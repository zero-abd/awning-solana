import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { parseSentence, parseBucket, selectStrip, buckets, priceCover, quoteFromEvents, examplesFromEvents } from "../src/quote.ts";
import { buyCoverData, disc, coverPda, mandatePda, poolPda, vaultPda, programError, limits } from "../src/chain.ts";
import type { GeminiEvent } from "../src/gemini.ts";

const NOW = Date.parse("2026-11-21T15:00:00Z");
const c = (id: string, label: string, yes?: string) => ({ id, label, prices: { buy: yes ? { yes } : {} }, expiryDate: "2026-11-23T04:59:59.000Z" });
const CHI: GeminiEvent = {
  id: "1", ticker: "WXHIGH-CHI-2611230459", title: "Highest temperature in Chicago on November 22, 2026?", category: "Weather", status: "active", expiryDate: "2026-11-23T04:59:59.000Z",
  contracts: [c("1-a", "41°F or below", "0.02"), c("1-b", "42°F to 43°F", "0.03"), c("1-c", "44°F to 45°F", "0.03"), c("1-d", "46°F to 47°F", "0.30"), c("1-e", "48°F to 49°F", "0.40"), c("1-f", "50°F or above", "0.25")],
};
const CITIES = ["Chicago", "NYC", "Los Angeles", "Washington DC", "Las Vegas"];

describe("parser", () => {
  it("reads the canonical sentence", () => {
    const p = parseSentence("If Chicago's high stays under 46 tomorrow my coffee cart is out $300", CITIES);
    expect(p).toMatchObject({ city: "Chicago", direction: "below", threshold: 45, amount: 300, day: "tomorrow" });
  });
  it("handles inclusive phrasing, aliases, °F and k amounts", () => {
    expect(parseSentence("if new york is 40°F or below today I lose $1.5k", CITIES)).toMatchObject({ city: "NYC", direction: "below", threshold: 40, amount: 1500, day: "today", unit: "F" });
    expect(parseSentence("Vegas tops 90 tomorrow, costs my crew 800 dollars", CITIES)).toMatchObject({ city: "Las Vegas", direction: "above", threshold: 91, amount: 800 });
    expect(parseSentence("If DC hits 75 my patio loses $250", CITIES)).toMatchObject({ city: "Washington DC", direction: "above", threshold: 75, amount: 250 });
  });
  it("does not mistake the dollar amount for the threshold", () => {
    expect(parseSentence("I'm out $300 if Chicago stays below 30", CITIES)).toMatchObject({ threshold: 29, amount: 300 });
  });
});

describe("buckets + pricing", () => {
  it("parses Gemini labels", () => {
    expect(parseBucket("44°F or below")).toEqual({ lo: -Infinity, hi: 44, unit: "F" });
    expect(parseBucket("45°F to 46°F")).toEqual({ lo: 45, hi: 46, unit: "F" });
    expect(parseBucket("55°F or above")).toEqual({ lo: 55, hi: Infinity, unit: "F" });
    expect(parseBucket("-2°C or below")).toEqual({ lo: -Infinity, hi: -2, unit: "C" });
    expect(parseBucket("5°C")).toEqual({ lo: 5, hi: 5, unit: "C" });
  });
  it("sums YES legs on the bad side", () => {
    const s = selectStrip(buckets(CHI), "below", 45)!;
    expect(s.legs.map((l) => l.contract.id)).toEqual(["1-a", "1-b", "1-c"]);
    expect(s.odds).toBeCloseTo(0.08);
    expect(s.exact).toBe(true);
  });
  it("prices cost = payout × ask × 1.06, to the cent", () => {
    expect(priceCover(300, 0.08)).toBe(25.44);
    expect(priceCover(300, 0.0805)).toBe(25.6);
    expect(priceCover(500, 0.11)).toBe(58.3);
  });
  it("builds a full quote and flags basis risk when buckets don't line up", () => {
    const q = quoteFromEvents("If Chicago's high stays under 46 tomorrow my coffee cart is out $300", [CHI], NOW);
    expect(q.headline).toBe("Pays $300 if Chicago's high is 45°F or below. Costs $25.44.");
    expect(q.market.onchainMarket).toBe("WXHIGH-CHI-2611230459:LE45");
    const q2 = quoteFromEvents("If Chicago's high stays under 45 tomorrow my cart is out $300", [CHI], NOW);
    expect(q2.basisRisk).toMatch(/does not pay/);
    expect(q2.headline).toContain("43°F or below");
  });
  it("refuses to price unpriced legs", () => {
    const ev = { ...CHI, contracts: CHI.contracts.map((x) => (x.id === "1-b" ? c("1-b", "42°F to 43°F") : x)) };
    expect(() => quoteFromEvents("Chicago under 46 tomorrow costs me $300", [ev], NOW)).toThrow(/Nobody is selling/);
  });
  it("makes examples from live-shaped events", () => {
    const ex = examplesFromEvents([CHI], 6, NOW);
    expect(ex.length).toBe(1);
    expect(ex[0].odds).toBeGreaterThan(0.04);
  });
});

describe("chain encoders", () => {
  it("uses Anchor discriminators", () => {
    expect(disc("global", "buy_cover")).toEqual(createHash("sha256").update("global:buy_cover").digest().subarray(0, 8));
    expect(disc("account", "Mandate").length).toBe(8);
  });
  it("Borsh-encodes buy_cover args", () => {
    const d = buyCoverData("ABC", 300_000_000n, 25_440_000n, -1n);
    expect(d.subarray(0, 8)).toEqual(disc("global", "buy_cover"));
    expect(d.readUInt32LE(8)).toBe(3);
    expect(d.subarray(12, 15).toString()).toBe("ABC");
    expect(d.readBigUInt64LE(15)).toBe(300_000_000n);
    expect(d.readBigUInt64LE(23)).toBe(25_440_000n);
    expect(d.readBigInt64LE(31)).toBe(-1n);
    expect(d.length).toBe(39);
    expect(() => buyCoverData("x".repeat(49), 1n, 1n, 1n)).toThrow(/MarketTooLong/);
    expect(limits({ maxPremiumPerCover: 1n, maxPremiumPerDay: 2n, maxPayoutPerCover: 3n }).length).toBe(24);
  });
  it("derives PDAs from the spec seeds", () => {
    const pid = new PublicKey("GCiXjWdKPbLSq7NLpDkjyVmiLcx9tmYG3oHNTS5Ese12");
    const auth = new PublicKey("11111111111111111111111111111112");
    const pool = poolPda(pid, auth);
    expect(pool.equals(PublicKey.findProgramAddressSync([Buffer.from("pool"), auth.toBuffer()], pid)[0])).toBe(true);
    expect(vaultPda(pid, pool).equals(PublicKey.findProgramAddressSync([Buffer.from("vault"), pool.toBuffer()], pid)[0])).toBe(true);
    const md = mandatePda(pid, pool, auth);
    const id = Buffer.alloc(8); id.writeBigUInt64LE(7n);
    expect(coverPda(pid, md, 7n).equals(PublicKey.findProgramAddressSync([Buffer.from("cover"), md.toBuffer(), id], pid)[0])).toBe(true);
  });
  it("maps program errors", () => {
    expect(programError(["Program log: AnchorError ... Error Code: OverCoverLimit. Error Number: 6004."])).toBe("OverCoverLimit");
    expect(programError([], { InstructionError: [0, { Custom: 6001 }] })).toBe("Revoked");
  });
});
