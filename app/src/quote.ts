// Sentence -> cover quote, deterministic (no LLM). Prices from live Gemini asks.
import { randomBytes } from "node:crypto";
import { listEvents, yesAsk, type GeminiContract, type GeminiEvent } from "./gemini.ts";

export const MARGIN = 0.06;

export type Direction = "below" | "above";
export interface Parsed {
  sentence: string;
  city: string | null;
  direction: Direction | null;
  /** Inclusive threshold: below => high <= threshold, above => high >= threshold. */
  threshold: number | null;
  unit: "F" | "C" | null;
  /** The number the owner actually said, and how they said it. */
  said: string | null;
  amount: number | null;
  day: "today" | "tomorrow" | null;
}

const ALIASES: Record<string, string> = {
  "new york city": "NYC", "new york": "NYC", nyc: "NYC", manhattan: "NYC",
  "washington dc": "Washington DC", "washington, dc": "Washington DC", "d.c.": "Washington DC", dc: "Washington DC",
  "san fran": "San Francisco", sf: "San Francisco", "l.a.": "Los Angeles", la: "Los Angeles",
  vegas: "Las Vegas", philly: "Philadelphia", nola: "New Orleans", "st louis": "St. Louis",
  "saint louis": "St. Louis", "kc": "Kansas City", "slc": "Salt Lake City", "sao paulo": "Sao Paulo", "são paulo": "Sao Paulo",
};

const MONEY = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?\b|\b(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand\b)?\s*(?:dollars|bucks|usd)\b/gi;

export function parseAmount(s: string): number | null {
  MONEY.lastIndex = 0;
  const m = MONEY.exec(s);
  if (!m) return null;
  const n = Number((m[1] ?? m[3]).replace(/,/g, ""));
  const k = m[2] ?? m[4];
  const v = k ? n * 1000 : n;
  return Number.isFinite(v) && v > 0 ? v : null;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseCity(s: string, cities: string[]): string | null {
  const lower = s.toLowerCase().replace(/’/g, "'");
  let best: { city: string; len: number } | null = null;
  const consider = (needle: string, city: string) => {
    const re = new RegExp(`(^|[^a-z])${escapeRe(needle.toLowerCase())}('s)?([^a-z]|$)`);
    if (re.test(lower) && (!best || needle.length > best.len)) best = { city, len: needle.length };
  };
  for (const c of cities) consider(c, c);
  for (const [alias, city] of Object.entries(ALIASES)) if (cities.includes(city)) consider(alias, city);
  return (best as { city: string } | null)?.city ?? null;
}

const BELOW_STRICT = /\b(under|below|less than|colder than|lower than|beneath|doesn'?t (?:get|make it|reach|hit) (?:above |to |past )?|fails to (?:reach|hit)|never (?:gets )?(?:above|past|to)|short of)\s*(-?\d+(?:\.\d+)?)/i;
const BELOW_INCL = /(?:\b(at or below|at or under|no (?:higher|warmer|more) than|at most|maxes out at|tops out at)\s*(-?\d+(?:\.\d+)?))|(?:(-?\d+(?:\.\d+)?)\s*(?:°|º|degrees?|deg)?\s*(?:f|c)?\s*(or (?:below|under|lower|colder|less)))/i;
const ABOVE_STRICT = /\b(over|above|more than|hotter than|warmer than|higher than|exceeds?|tops|passes|beats)\s*(-?\d+(?:\.\d+)?)/i;
const ABOVE_INCL = /(?:\b(at or above|at least|hits|reaches|gets to|climbs to|soars to|goes to)\s*(-?\d+(?:\.\d+)?))|(?:(-?\d+(?:\.\d+)?)\s*(?:°|º|degrees?|deg)?\s*(?:f|c)?\s*(or (?:above|over|higher|hotter|more)))/i;

export function parseThreshold(s0: string): Pick<Parsed, "direction" | "threshold" | "unit" | "said"> {
  MONEY.lastIndex = 0;
  const s = s0.replace(MONEY, " ").replace(/[’]/g, "'").replace(/(\d)\s*(?:°|º)/g, "$1 ");
  const unitM = /-?\d+(?:\.\d+)?\s*(?:°|º|degrees?|deg)?\s*(f|c|fahrenheit|celsius)\b/i.exec(s0);
  const unit = unitM ? (unitM[1][0].toUpperCase() as "F" | "C") : null;
  const tries: Array<[RegExp, Direction, boolean]> = [
    [BELOW_INCL, "below", true], [ABOVE_INCL, "above", true], [BELOW_STRICT, "below", false], [ABOVE_STRICT, "above", false],
  ];
  let best: { idx: number; direction: Direction; threshold: number; said: string } | null = null;
  for (const [re, direction, inclusive] of tries) {
    const m = re.exec(s);
    if (!m) continue;
    const raw = m[2] ?? m[3];
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) continue;
    const threshold = inclusive ? n : direction === "below" ? n - 1 : n + 1;
    if (!best || m.index < best.idx) best = { idx: m.index, direction, threshold, said: m[0].trim() };
  }
  if (!best) {
    // Fallback: "cold"/"freeze" words with a bare number.
    const num = /(-?\d+(?:\.\d+)?)\s*(?:degrees?|deg|f\b|c\b)/i.exec(s);
    const cold = /\b(cold|freez|chill|frost|snow)/i.test(s);
    const hot = /\b(hot|heat|scorch|swelter|bak)/i.test(s);
    if (num && (cold || hot)) {
      const n = Math.round(Number(num[1]));
      return { direction: cold ? "below" : "above", threshold: n, unit, said: num[0].trim() };
    }
    return { direction: null, threshold: null, unit, said: null };
  }
  return { direction: best.direction, threshold: best.threshold, unit, said: best.said };
}

export function parseDay(s: string): "today" | "tomorrow" | null {
  if (/\b(tomorrow|tmrw|tmr)\b/i.test(s)) return "tomorrow";
  if (/\b(today|tonight|this afternoon)\b/i.test(s)) return "today";
  return null;
}

export function parseSentence(sentence: string, cities: string[]): Parsed {
  const s = sentence.trim().slice(0, 400);
  return { sentence: s, city: parseCity(s, cities), ...parseThreshold(s), amount: parseAmount(s), day: parseDay(s) };
}

// ---------- market structure ----------
export interface Bucket {
  contract: GeminiContract;
  lo: number; // inclusive, -Infinity for "or below"
  hi: number; // inclusive, +Infinity for "or above"
  unit: "F" | "C";
  ask: number | null;
}

export function parseBucket(label: string): Omit<Bucket, "contract" | "ask"> | null {
  const t = label.replace(/º/g, "°").trim();
  let m = /^(-?\d+)\s*°\s*([FC])\s*or\s*(below|lower|less)$/i.exec(t);
  if (m) return { lo: -Infinity, hi: +m[1], unit: m[2].toUpperCase() as "F" | "C" };
  m = /^(-?\d+)\s*°\s*([FC])\s*or\s*(above|higher|more)$/i.exec(t);
  if (m) return { lo: +m[1], hi: Infinity, unit: m[2].toUpperCase() as "F" | "C" };
  m = /^(-?\d+)\s*°\s*([FC])?\s*(?:to|-|–)\s*(-?\d+)\s*°\s*([FC])$/i.exec(t);
  if (m) return { lo: +m[1], hi: +m[3], unit: m[4].toUpperCase() as "F" | "C" };
  m = /^(-?\d+)\s*°\s*([FC])$/i.exec(t);
  if (m) return { lo: +m[1], hi: +m[1], unit: m[2].toUpperCase() as "F" | "C" };
  return null;
}

export function buckets(ev: GeminiEvent): Bucket[] {
  const out: Bucket[] = [];
  for (const c of ev.contracts ?? []) {
    const b = parseBucket(c.label);
    if (b) out.push({ ...b, contract: c, ask: yesAsk(c) });
  }
  return out.sort((a, b) => a.lo - b.lo);
}

const TITLE = /^Highest temperature in (.+?) on ([A-Z][a-z]+ \d{1,2}, \d{4})\??$/;
export function eventCity(ev: GeminiEvent): string | null {
  return TITLE.exec(ev.title)?.[1] ?? null;
}
export function eventDate(ev: GeminiEvent): string | null {
  const d = TITLE.exec(ev.title)?.[2];
  if (!d) return null;
  const t = Date.parse(d + " 12:00 UTC");
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export interface Strip {
  legs: Bucket[];
  lo: number;
  hi: number;
  unit: "F" | "C";
  odds: number | null; // sum of YES asks, null if any leg unpriced
  exact: boolean; // covered condition equals the stated one
}

/** Pick the YES legs that together pay on the bad day. */
export function selectStrip(bs: Bucket[], direction: Direction, threshold: number): Strip | null {
  if (!bs.length) return null;
  const unit = bs[0].unit;
  let legs: Bucket[];
  if (direction === "below") {
    legs = bs.filter((b) => b.hi <= threshold);
    if (!legs.length) legs = bs.filter((b) => b.lo === -Infinity); // over-cover with the bottom tail
  } else {
    legs = bs.filter((b) => b.lo >= threshold);
    if (!legs.length) legs = bs.filter((b) => b.hi === Infinity);
  }
  if (!legs.length) return null;
  const lo = Math.min(...legs.map((l) => l.lo));
  const hi = Math.max(...legs.map((l) => l.hi));
  const covered = direction === "below" ? hi : lo;
  const odds = legs.some((l) => l.ask == null) ? null : Math.min(0.99, legs.reduce((s, l) => s + (l.ask as number), 0));
  return { legs, lo, hi, unit, odds: odds == null ? null : Math.round(odds * 10000) / 10000, exact: covered === threshold };
}

export function priceCover(payout: number, odds: number, margin = MARGIN): number {
  return Math.round(payout * odds * (1 + margin) * 100) / 100;
}

export function conditionText(city: string, strip: Pick<Strip, "lo" | "hi" | "unit">): string {
  const u = `°${strip.unit}`;
  if (strip.lo === -Infinity) return `${city}'s high is ${strip.hi}${u} or below`;
  if (strip.hi === Infinity) return `${city}'s high is ${strip.lo}${u} or above`;
  return `${city}'s high is between ${strip.lo}${u} and ${strip.hi}${u}`;
}

function marketId(ev: GeminiEvent, strip: Strip): string {
  if (strip.legs.length === 1 && strip.legs[0].contract.instrumentSymbol && strip.legs[0].contract.instrumentSymbol.length <= 48)
    return strip.legs[0].contract.instrumentSymbol;
  const tag = strip.lo === -Infinity ? `LE${strip.hi}` : strip.hi === Infinity ? `GE${strip.lo}` : `${strip.lo}TO${strip.hi}`;
  return `${ev.ticker}:${tag}`.slice(0, 48);
}

export interface Quote {
  id: string;
  sentence: string;
  city: string;
  day: string;
  date: string | null;
  market: { eventTicker: string; title: string; onchainMarket: string; url: string; expiresAt: number };
  contracts: Array<{ id: string; label: string; ask: number }>;
  contractId: string;
  contractLabel: string;
  odds: number;
  payout: number;
  cost: number;
  margin: number;
  headline: string;
  explanation: string;
  basisRisk: string;
  createdAt: number;
}

export class QuoteError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
  }
}

const F2C = (f: number) => ((f - 32) * 5) / 9;
const C2F = (c: number) => (c * 9) / 5 + 32;

export function quoteFromEvents(sentence: string, events: GeminiEvent[], now = Date.now()): Quote {
  const wx = events.filter((e) => eventCity(e) && e.status === "active");
  const cities = [...new Set(wx.map((e) => eventCity(e) as string))];
  const p = parseSentence(sentence, cities);
  if (!p.city) throw new QuoteError("I couldn't find a city with a live temperature market in that sentence.", `Try one of: ${cities.slice(0, 8).join(", ")}.`);
  if (!p.direction || p.threshold == null) throw new QuoteError("Say the temperature that hurts, like \"stays under 46\" or \"tops 95\".");
  if (!p.amount) throw new QuoteError("How much would the bad day cost you? Add an amount, like \"$300\".");
  if (p.amount > 100_000) throw new QuoteError("That payout is larger than this pool writes. Try $100,000 or less.");

  const cityEvents = wx
    .filter((e) => eventCity(e) === p.city && (!e.expiryDate || Date.parse(e.expiryDate) > now))
    .sort((a, b) => (eventDate(a) ?? "").localeCompare(eventDate(b) ?? ""));
  if (!cityEvents.length) throw new QuoteError(`No open temperature market for ${p.city} right now.`);
  const today = new Date(now).toISOString().slice(0, 10);
  const tomorrow = new Date(now + 86_400_000).toISOString().slice(0, 10);
  const wantDate = p.day === "today" ? today : tomorrow;
  let ev = cityEvents.find((e) => eventDate(e) === wantDate);
  let dayNote = "";
  if (!ev) {
    ev = p.day === "today" ? cityEvents[0] : cityEvents[cityEvents.length - 1];
    dayNote = ` There is no ${p.day ?? "tomorrow"} market for ${p.city} yet, so this uses ${eventDate(ev)}.`;
  }
  const bs = buckets(ev);
  if (!bs.length) throw new QuoteError(`The ${p.city} market's buckets weren't readable.`);
  const mUnit = bs[0].unit;
  let threshold = p.threshold;
  let unitNote = "";
  const said = p.unit ?? mUnit;
  if (said !== mUnit) {
    const conv = said === "F" ? F2C(threshold) : C2F(threshold);
    threshold = p.direction === "below" ? Math.floor(conv) : Math.ceil(conv);
    unitNote = ` You said °${said}; this market settles in whole °${mUnit}, so ${p.threshold}°${said} becomes ${threshold}°${mUnit}.`;
  }
  const strip = selectStrip(bs, p.direction, threshold);
  if (!strip) throw new QuoteError(`No bucket in the ${p.city} market matches that bad day.`);
  if (strip.odds == null) {
    const missing = strip.legs.filter((l) => l.ask == null).map((l) => l.contract.label);
    throw new QuoteError(`Nobody is selling YES on ${missing.join(", ")} in ${p.city} right now, so there's no honest price.`, "Try another city or threshold.");
  }
  const payout = Math.round(p.amount * 100) / 100;
  const cost = priceCover(payout, strip.odds);
  if (cost >= payout) throw new QuoteError(`The market puts ${pct(strip.odds)} on that, so cover would cost more than it pays.`, "That's a likely day, not a bad one. Try a rarer threshold.");
  const cond = conditionText(p.city, strip);
  const stated = `${p.city}'s high is ${threshold}°${mUnit} or ${p.direction === "below" ? "below" : "above"}`;
  let basis = `Pays on the official reading at the station Gemini settles on (NOAA METAR, whole degrees), not the thermometer at your shop.`;
  if (!strip.exact) {
    basis =
      p.direction === "below" && strip.hi < threshold
        ? `Your bad day is ${stated}, but Gemini's buckets break at ${strip.hi}°${mUnit}: a high of exactly ${strip.hi + 1}–${threshold}°${mUnit} hurts you and does not pay. ` + basis
        : p.direction === "above" && strip.lo > threshold
          ? `Your bad day is ${stated}, but Gemini's buckets break at ${strip.lo}°${mUnit}: a high of exactly ${threshold}–${strip.lo - 1}°${mUnit} hurts you and does not pay. ` + basis
          : `This covers more than you asked (${cond}), so it can pay on a day that wasn't bad for you, and it costs more. ` + basis;
  }
  const legs = strip.legs.map((l) => ({ id: l.contract.id, label: l.contract.label, ask: l.ask as number }));
  const expiresAt = Math.floor(Date.parse(strip.legs[0].contract.expiryDate ?? ev.expiryDate ?? "") / 1000) || Math.floor(now / 1000) + 86400;
  const headline = `Pays $${fmt(payout)} if ${cond}. Costs $${fmt(cost)}.`;
  const explanation =
    `Gemini traders put ${pct(strip.odds)} on ${cond} on ${eventDate(ev)} (YES ask${legs.length > 1 ? "s summed across " + legs.length + " buckets" : ""}). ` +
    `Cover = $${fmt(payout)} × ${strip.odds.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} × (1 + ${MARGIN * 100}% margin) = $${fmt(cost)}.` + unitNote + dayNote;
  return {
    id: randomBytes(9).toString("base64url"),
    sentence: p.sentence,
    city: p.city,
    day: eventDate(ev) === today ? "today" : eventDate(ev) === tomorrow ? "tomorrow" : (eventDate(ev) ?? "?"),
    date: eventDate(ev),
    market: { eventTicker: ev.ticker, title: ev.title, onchainMarket: marketId(ev, strip), url: "https://www.gemini.com/predictions", expiresAt },
    contracts: legs,
    contractId: legs.map((l) => l.id).join("+").slice(0, 120),
    contractLabel: strip.legs.length === 1 ? legs[0].label : cond.replace(`${p.city}'s high is `, ""),
    odds: strip.odds,
    payout,
    cost,
    margin: MARGIN,
    headline,
    explanation,
    basisRisk: basis,
    createdAt: now,
  };
}

export function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

// ---------- live helpers ----------
export async function weatherEvents(): Promise<GeminiEvent[]> {
  return listEvents("Weather");
}

export async function quote(sentence: string): Promise<Quote> {
  return quoteFromEvents(sentence, await weatherEvents());
}

const COLD_BIZ = ["coffee cart", "patio bar", "food truck", "farmers-market stall", "ice cream stand", "rooftop café", "golf course"];
const HOT_BIZ = ["landscaping crew", "roofing crew", "outdoor market", "dog-walking business", "moving company"];

/** Build live-priced example bad days: a cold tail and a hot tail per city, 5%–45% odds. */
export function examplesFromEvents(events: GeminiEvent[], n = 6, now = Date.now()): Quote[] {
  const tomorrow = new Date(now + 86_400_000).toISOString().slice(0, 10);
  const wx = events
    .filter((e) => eventCity(e) && (!e.expiryDate || Date.parse(e.expiryDate) > now + 3600_000))
    .sort((a, b) => Number(eventDate(b) === tomorrow) - Number(eventDate(a) === tomorrow) || (a.ticker < b.ticker ? -1 : 1));
  const out: Quote[] = [];
  const seen = new Set<string>();
  let i = 0;
  for (const ev of wx) {
    const city = eventCity(ev) as string;
    if (seen.has(city)) continue;
    const bs = buckets(ev);
    if (bs.length < 3 || bs[0].unit !== "F") continue;
    const day = eventDate(ev) === tomorrow ? "tomorrow" : "today";
    const cands: string[] = [];
    for (const dir of (i % 2 ? ["above", "below"] : ["below", "above"]) as Direction[]) {
      // walk thresholds from the tail inward, take first with sensible odds
      const edges = dir === "below" ? bs.filter((b) => b.hi !== Infinity).map((b) => b.hi) : bs.filter((b) => b.lo !== -Infinity).map((b) => b.lo).reverse();
      for (const t of edges) {
        const s = selectStrip(bs, dir, t);
        if (!s || s.odds == null || !s.exact) continue;
        if (s.odds >= 0.04 && s.odds <= 0.45) {
          const amt = [300, 450, 250, 600, 400, 800][(i + cands.length) % 6];
          const biz = dir === "below" ? COLD_BIZ[i % COLD_BIZ.length] : HOT_BIZ[i % HOT_BIZ.length];
          cands.push(
            dir === "below"
              ? `If ${city}'s high stays under ${t + 1} ${day} my ${biz} is out $${amt}`
              : `If ${city} hits ${t} ${day} my ${biz} loses $${amt}`,
          );
          break;
        }
        if (s.odds > 0.45) break;
      }
    }
    for (const sentence of cands.slice(0, 1)) {
      try {
        const q = quoteFromEvents(sentence, events, now);
        out.push(q);
        seen.add(city);
        i++;
      } catch {
        /* skip */
      }
    }
    if (out.length >= n) break;
  }
  return out;
}

// ---------- quote store ----------
const store = new Map<string, Quote>();
export const QUOTE_TTL_MS = 5 * 60_000;
export function remember(q: Quote) {
  store.set(q.id, q);
  for (const [k, v] of store) if (Date.now() - v.createdAt > QUOTE_TTL_MS) store.delete(k);
  return q;
}
export function recall(id: string): Quote | null {
  const q = store.get(id);
  return q && Date.now() - q.createdAt <= QUOTE_TTL_MS ? q : null;
}
