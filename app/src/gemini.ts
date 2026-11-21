// Live Gemini prediction-market client: timeouts, retries, 30s cache.
export const GEMINI_BASE = "https://api.gemini.com/v1/prediction-markets";

export interface GeminiContract {
  id: string;
  label: string;
  ticker?: string;
  instrumentSymbol?: string;
  status?: string;
  marketState?: string;
  expiryDate?: string;
  prices?: {
    buy?: { yes?: string; no?: string };
    sell?: { yes?: string; no?: string };
    bestBid?: string;
    bestAsk?: string;
  };
}

export interface GeminiEvent {
  id: string;
  title: string;
  slug?: string;
  ticker: string;
  category: string;
  status: string;
  expiryDate?: string;
  contracts: GeminiContract[];
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 30_000;

async function getJson(url: string, fetcher: Fetcher = fetch, tries = 3): Promise<unknown> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
      if (res.status >= 500 || res.status === 429) throw new Error(`Gemini HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`Gemini HTTP ${res.status}`), { fatal: true });
      const value = await res.json();
      cache.set(url, { at: Date.now(), value });
      return value;
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  // Serve stale on failure rather than nothing.
  if (hit) return hit.value;
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function listEvents(category: string, fetcher?: Fetcher): Promise<GeminiEvent[]> {
  const out: GeminiEvent[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const url = `${GEMINI_BASE}/events?status=active&category=${encodeURIComponent(category)}&limit=100&offset=${offset}`;
    const j = (await getJson(url, fetcher)) as { data?: GeminiEvent[]; pagination?: { total?: number } };
    const page = Array.isArray(j.data) ? j.data : [];
    out.push(...page);
    const total = j.pagination?.total ?? 0;
    if (page.length < 100 || out.length >= total) break;
  }
  return out;
}

export async function getEvent(ticker: string, fetcher?: Fetcher): Promise<GeminiEvent> {
  const j = (await getJson(`${GEMINI_BASE}/events/${encodeURIComponent(ticker)}`, fetcher)) as { data?: GeminiEvent } & GeminiEvent;
  return (j.data ?? j) as GeminiEvent;
}

/** Price to buy YES, or null when nobody is offering. */
export function yesAsk(c: GeminiContract): number | null {
  const raw = c.prices?.buy?.yes ?? c.prices?.bestAsk;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

export function clearCache() {
  cache.clear();
}
