// Anchor-compatible client for the `awning` program, written from SPEC.md.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = join(HERE, "..");
export const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
export const USDC = 1_000_000n;

export function programId(): PublicKey | null {
  if (process.env.AWNING_PROGRAM_ID) return new PublicKey(process.env.AWNING_PROGRAM_ID);
  for (const f of [join(APP_DIR, "../programs/awning/src/lib.rs"), join(APP_DIR, "../Anchor.toml")]) {
    try {
      const t = readFileSync(f, "utf8");
      const m = /declare_id!\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(t) ?? /^\s*awning\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/m.exec(t);
      if (m) return new PublicKey(m[1]);
    } catch {}
  }
  return null;
}

// ---------- encoding ----------
export const disc = (kind: "global" | "account", name: string) => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);
export const u64 = (v: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
export const i64 = (v: bigint | number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
export const str = (s: string) => { const d = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([l, d]); };
export const bool = (v: boolean) => Buffer.from([v ? 1 : 0]);
export interface Limits { maxPremiumPerCover: bigint; maxPremiumPerDay: bigint; maxPayoutPerCover: bigint }
export const limits = (l: Limits) => Buffer.concat([u64(l.maxPremiumPerCover), u64(l.maxPremiumPerDay), u64(l.maxPayoutPerCover)]);
export function ixData(name: string, ...args: Buffer[]) { return Buffer.concat([disc("global", name), ...args]); }
export function buyCoverData(market: string, payout: bigint, premium: bigint, expiresAt: bigint) {
  if (Buffer.byteLength(market) > 48) throw new Error("MarketTooLong");
  return ixData("buy_cover", str(market), u64(payout), u64(premium), i64(expiresAt));
}

// ---------- PDAs ----------
const pda = (pid: PublicKey, seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, pid)[0];
export const poolPda = (pid: PublicKey, authority: PublicKey) => pda(pid, [Buffer.from("pool"), authority.toBuffer()]);
export const vaultPda = (pid: PublicKey, pool: PublicKey) => pda(pid, [Buffer.from("vault"), pool.toBuffer()]);
export const mandatePda = (pid: PublicKey, pool: PublicKey, owner: PublicKey) => pda(pid, [Buffer.from("mandate"), pool.toBuffer(), owner.toBuffer()]);
export const mandateVaultPda = (pid: PublicKey, mandate: PublicKey) => pda(pid, [Buffer.from("mandate_vault"), mandate.toBuffer()]);
export const coverPda = (pid: PublicKey, mandate: PublicKey, id: bigint) => pda(pid, [Buffer.from("cover"), mandate.toBuffer(), u64(id)]);

// ---------- decoders ----------
class R { o = 8; constructor(public b: Buffer) {}
  pk() { const p = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return p; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u8() { return this.b[this.o++]; }
  str() { const n = this.u32(); const s = this.b.subarray(this.o, this.o + n).toString("utf8"); this.o += n; return s; } }
function check(b: Buffer, name: string) { if (!b.subarray(0, 8).equals(disc("account", name))) throw new Error(`not a ${name} account`); return new R(b); }
export function decodePool(b: Buffer) { const r = check(b, "Pool");
  return { authority: r.pk(), quoter: r.pk(), resolver: r.pk(), usdcMint: r.pk(), vault: r.pk(), locked: r.u64(), premiums: r.u64(), openCovers: r.u32(), bump: r.u8(), vaultBump: r.u8() }; }
export function decodeMandate(b: Buffer) { const r = check(b, "Mandate");
  return { owner: r.pk(), agent: r.pk(), pool: r.pk(), vault: r.pk(), limits: { maxPremiumPerCover: r.u64(), maxPremiumPerDay: r.u64(), maxPayoutPerCover: r.u64() },
    day: r.i64(), spentToday: r.u64(), totalSpent: r.u64(), covers: r.u64(), revoked: r.u8() === 1, bump: r.u8(), vaultBump: r.u8() }; }
export function decodeCover(b: Buffer) { const r = check(b, "Cover");
  return { mandate: r.pk(), owner: r.pk(), market: r.str(), payout: r.u64(), premium: r.u64(), expiresAt: r.i64(), state: (["Open", "PaidOut", "Expired"] as const)[r.u8()] ?? "?", bump: r.u8() }; }
export const ERRORS = ["NotAgent", "Revoked", "BadQuoter", "BadPrice", "OverCoverLimit", "OverPayoutLimit", "OverDailyLimit", "Expired", "PoolTooThin", "NotOpen", "InsufficientFree", "MarketTooLong", "WrongPool", "WrongOwner", "MathOverflow"];
export function programError(logs: string[] | null | undefined, err?: unknown): string | null {
  const text = (logs ?? []).join("\n") + " " + JSON.stringify(err ?? "");
  const named = /Error Code: (\w+)/.exec(text); if (named) return named[1];
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (hex) { const n = parseInt(hex[1], 16); return ERRORS[n - 6000] ?? `Custom(${n})`; }
  const c = /"Custom":(\d+)/.exec(text); if (c) { const n = +c[1]; return ERRORS[n - 6000] ?? `Custom(${n})`; }
  return err ? (/missing required signature|Signature verification|signer/i.test(text) ? "MissingSignature" : String(JSON.stringify(err)).slice(0, 120)) : null;
}

// ---------- keys ----------
export function key(name: string): Keypair {
  const dir = join(APP_DIR, ".keys"); const f = join(dir, `${name}.json`);
  if (existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8"))));
  mkdirSync(dir, { recursive: true }); const k = Keypair.generate();
  writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }); return k;
}
export const keys = () => ({ authority: key("authority"), quoter: key("quoter"), resolver: key("resolver"), owner: key("owner"), agent: key("agent") });
export function poolAuthority(): PublicKey { return process.env.AWNING_POOL_AUTHORITY ? new PublicKey(process.env.AWNING_POOL_AUTHORITY) : key("authority").publicKey; }

export const connection = () => new Connection(RPC_URL, "confirmed");
export function clusterName(url = RPC_URL) { return /127\.0\.0\.1|localhost/.test(url) ? "localnet" : /devnet/.test(url) ? "devnet" : /testnet/.test(url) ? "testnet" : /mainnet/.test(url) ? "mainnet-beta" : url; }

export async function deployed(conn = connection()) {
  const pid = programId();
  if (!pid) return { deployed: false, reason: "No program id (set AWNING_PROGRAM_ID)", programId: null as string | null };
  try { const ai = await conn.getAccountInfo(pid); return { deployed: !!ai?.executable, reason: ai ? (ai.executable ? "" : "account not executable") : `Program not deployed on ${clusterName()}`, programId: pid.toBase58() }; }
  catch (e) { return { deployed: false, reason: `RPC unreachable at ${RPC_URL}: ${(e as Error).message}`, programId: pid.toBase58() }; }
}

// ---------- instruction builders ----------
const m = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const ix = (pid: PublicKey, keys: ReturnType<typeof m>[], data: Buffer) => new TransactionInstruction({ programId: pid, keys, data });
export const ixs = {
  initPool: (pid: PublicKey, authority: PublicKey, mint: PublicKey, quoter: PublicKey, resolver: PublicKey) => { const pool = poolPda(pid, authority);
    return ix(pid, [m(authority, true, true), m(pool, false, true), m(mint), m(vaultPda(pid, pool), false, true), m(TOKEN_PROGRAM_ID), m(SystemProgram.programId)], ixData("init_pool", quoter.toBuffer(), resolver.toBuffer())); },
  fundPool: (pid: PublicKey, funder: PublicKey, pool: PublicKey, funderToken: PublicKey, amount: bigint) =>
    ix(pid, [m(funder, true), m(pool), m(vaultPda(pid, pool), false, true), m(funderToken, false, true), m(TOKEN_PROGRAM_ID)], ixData("fund_pool", u64(amount))),
  openMandate: (pid: PublicKey, owner: PublicKey, pool: PublicKey, mint: PublicKey, agent: PublicKey, l: Limits) => { const md = mandatePda(pid, pool, owner);
    return ix(pid, [m(owner, true, true), m(pool), m(md, false, true), m(mint), m(mandateVaultPda(pid, md), false, true), m(TOKEN_PROGRAM_ID), m(SystemProgram.programId)], ixData("open_mandate", agent.toBuffer(), limits(l))); },
  deposit: (pid: PublicKey, owner: PublicKey, mandate: PublicKey, ownerToken: PublicKey, amount: bigint) =>
    ix(pid, [m(owner, true), m(mandate), m(mandateVaultPda(pid, mandate), false, true), m(ownerToken, false, true), m(TOKEN_PROGRAM_ID)], ixData("deposit", u64(amount))),
  withdraw: (pid: PublicKey, signer: PublicKey, mandate: PublicKey, toToken: PublicKey, amount: bigint) =>
    ix(pid, [m(signer, true), m(mandate), m(mandateVaultPda(pid, mandate), false, true), m(toToken, false, true), m(TOKEN_PROGRAM_ID)], ixData("withdraw", u64(amount))),
  setLimits: (pid: PublicKey, owner: PublicKey, mandate: PublicKey, l: Limits) => ix(pid, [m(owner, true), m(mandate, false, true)], ixData("set_limits", limits(l))),
  setAgent: (pid: PublicKey, owner: PublicKey, mandate: PublicKey, agent: PublicKey) => ix(pid, [m(owner, true), m(mandate, false, true)], ixData("set_agent", agent.toBuffer())),
  revoke: (pid: PublicKey, owner: PublicKey, mandate: PublicKey) => ix(pid, [m(owner, true), m(mandate, false, true)], ixData("revoke")),
  buyCover: (pid: PublicKey, a: { agent: PublicKey; quoter: PublicKey; pool: PublicKey; mandate: PublicKey; coverId: bigint; quoterSigns?: boolean }, market: string, payout: bigint, premium: bigint, expiresAt: bigint) =>
    ix(pid, [m(a.agent, true, true), m(a.quoter, a.quoterSigns !== false), m(a.pool, false, true), m(vaultPda(pid, a.pool), false, true), m(a.mandate, false, true),
      m(mandateVaultPda(pid, a.mandate), false, true), m(coverPda(pid, a.mandate, a.coverId), false, true), m(TOKEN_PROGRAM_ID), m(SystemProgram.programId)], buyCoverData(market, payout, premium, expiresAt)),
  settleCover: (pid: PublicKey, resolver: PublicKey, pool: PublicKey, cover: PublicKey, ownerToken: PublicKey, happened: boolean) =>
    ix(pid, [m(resolver, true), m(pool, false, true), m(vaultPda(pid, pool), false, true), m(cover, false, true), m(ownerToken, false, true), m(TOKEN_PROGRAM_ID)], ixData("settle_cover", bool(happened))),
};

export async function send(conn: Connection, instrs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...instrs); tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(...signers);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) { const e = new Error(programError(sim.value.logs, sim.value.err) ?? "simulation failed"); Object.assign(e, { logs: sim.value.logs }); throw e; }
  const sig = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(sig, "confirmed"); return sig;
}

// ---------- reads ----------
export async function agentState(conn = connection()) {
  const dep = await deployed(conn); if (!dep.deployed) return { deployed: false, reason: dep.reason, programId: dep.programId };
  const pid = programId()!; const k = keys(); const pool = poolPda(pid, poolAuthority()); const md = mandatePda(pid, pool, k.owner.publicKey);
  const [pai, mai] = await conn.getMultipleAccountsInfo([pool, md]);
  const out: Record<string, unknown> = { deployed: true, programId: pid.toBase58(), pool: pool.toBase58(), mandate: md.toBase58(), owner: k.owner.publicKey.toBase58(), agent: k.agent.publicKey.toBase58() };
  if (pai) { const p = decodePool(pai.data); const v = await conn.getTokenAccountBalance(p.vault).catch(() => null);
    out.poolState = { locked: p.locked.toString(), premiums: p.premiums.toString(), openCovers: p.openCovers, vaultAmount: v?.value.amount ?? null, quoter: p.quoter.toBase58() }; }
  if (!mai) return { ...out, mandateState: null, covers: [] };
  const mm = decodeMandate(mai.data); const vb = await conn.getTokenAccountBalance(mm.vault).catch(() => null);
  const ids = Array.from({ length: Number(mm.covers) }, (_, i) => BigInt(i)).slice(-20);
  const cs = ids.length ? await conn.getMultipleAccountsInfo(ids.map((i) => coverPda(pid, md, i))) : [];
  return { ...out, mandateState: { limits: Object.fromEntries(Object.entries(mm.limits).map(([a, b]) => [a, b.toString()])), spentToday: mm.spentToday.toString(), totalSpent: mm.totalSpent.toString(), covers: mm.covers.toString(), revoked: mm.revoked, vaultAmount: vb?.value.amount ?? null, day: mm.day.toString() },
    covers: cs.map((a, i) => a && { id: ids[i].toString(), ...((c) => ({ market: c.market, payout: c.payout.toString(), premium: c.premium.toString(), expiresAt: Number(c.expiresAt), state: c.state }))(decodeCover(a.data)) }).filter(Boolean) };
}

export async function buyCover(q: { market: { onchainMarket: string; expiresAt: number }; payout: number; cost: number }, opts: { quoterSigns?: boolean } = {}) {
  const conn = connection(); const pid = programId()!; const k = keys(); const pool = poolPda(pid, poolAuthority()); const md = mandatePda(pid, pool, k.owner.publicKey);
  const mai = await conn.getAccountInfo(md); if (!mai) throw new Error("No mandate yet — run setup-localnet");
  const id = decodeMandate(mai.data).covers;
  const ins = ixs.buyCover(pid, { agent: k.agent.publicKey, quoter: k.quoter.publicKey, pool, mandate: md, coverId: id, quoterSigns: opts.quoterSigns }, q.market.onchainMarket,
    BigInt(Math.round(q.payout * 1e6)), BigInt(Math.round(q.cost * 1e6)), BigInt(q.market.expiresAt));
  const sig = await send(conn, [ins], opts.quoterSigns === false ? [k.agent] : [k.agent, k.quoter]);
  return { signature: sig, coverId: id.toString(), cover: coverPda(pid, md, id).toBase58() };
}
