// Awning on Solana — node:http server, no framework.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { APP_DIR, RPC_URL, agentState, buyCover, clusterName, connection, decodeMandate, decodePool, deployed, ixs, keys, mandatePda, poolAuthority, poolPda, programId, send, USDC } from "./chain.ts";
import { examplesFromEvents, quote, QuoteError, recall, remember, weatherEvents } from "./quote.ts";
import { hijack } from "./hijack.ts";

const PUBLIC = join(APP_DIR, "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 10_000) throw new Error("body too large"); }
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

async function status() {
  const dep = await deployed();
  let liquidity: { vault: string | null; locked: string; free: string | null } | null = null;
  if (dep.deployed) {
    const conn = connection();
    const pai = await conn.getAccountInfo(poolPda(programId()!, poolAuthority())).catch(() => null);
    if (pai) {
      const p = decodePool(pai.data);
      const v = await conn.getTokenAccountBalance(p.vault).catch(() => null);
      const amt = v ? BigInt(v.value.amount) : null;
      liquidity = { vault: amt?.toString() ?? null, locked: p.locked.toString(), free: amt == null ? null : (amt - p.locked).toString() };
    }
  }
  return { cluster: clusterName(), rpc: RPC_URL, programId: dep.programId, deployed: dep.deployed, reason: dep.reason, pool: liquidity, buyEnabled: dep.deployed && !!liquidity };
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  "GET /api/status": async (_q, res) => json(res, 200, await status()),
  "GET /api/examples": async (_q, res) => {
    const ev = await weatherEvents();
    json(res, 200, { examples: examplesFromEvents(ev).map(remember), markets: ev.length });
  },
  "POST /api/quote": async (req, res) => {
    const { sentence } = await body(req);
    if (typeof sentence !== "string" || !sentence.trim()) return json(res, 400, { error: "Say what could go wrong, in a sentence." });
    try { json(res, 200, remember(await quote(sentence))); }
    catch (e) { if (e instanceof QuoteError) return json(res, 422, { error: e.message, hint: e.hint }); throw e; }
  },
  "POST /api/buy": async (req, res) => {
    const { quoteId } = await body(req);
    const q = typeof quoteId === "string" ? recall(quoteId) : null;
    if (!q) return json(res, 404, { error: "Quote expired. Get a fresh price." });
    const dep = await deployed();
    if (!dep.deployed) return json(res, 409, { error: `Program not deployed on ${clusterName()}. Nothing was bought.`, reason: dep.reason });
    try { json(res, 200, { ok: true, quote: q, ...(await buyCover(q)) }); }
    catch (e) { json(res, 422, { ok: false, error: (e as Error).message, logs: (e as { logs?: string[] }).logs?.slice(-6) }); }
  },
  "GET /api/agent": async (_q, res) => json(res, 200, await agentState()),
  "POST /api/agent/limits": async (req, res) => {
    const b = await body(req);
    const dep = await deployed();
    if (!dep.deployed) return json(res, 409, { deployed: false, error: dep.reason });
    const d = (v: unknown) => BigInt(Math.round(Number(v) * 1e6));
    if (![b.perCover, b.perDay, b.payout].every((v) => Number(v) > 0)) return json(res, 400, { error: "All three limits must be positive dollar amounts." });
    const pid = programId()!; const k = keys(); const md = mandatePda(pid, poolPda(pid, poolAuthority()), k.owner.publicKey);
    try { json(res, 200, { ok: true, signature: await send(connection(), [ixs.setLimits(pid, k.owner.publicKey, md, { maxPremiumPerCover: d(b.perCover), maxPremiumPerDay: d(b.perDay), maxPayoutPerCover: d(b.payout) })], [k.owner]) }); }
    catch (e) { json(res, 422, { ok: false, error: (e as Error).message }); }
  },
  "POST /api/agent/revoke": async (req, res) => {
    const b = await body(req);
    const dep = await deployed();
    if (!dep.deployed) return json(res, 409, { deployed: false, error: dep.reason });
    const pid = programId()!; const k = keys(); const md = mandatePda(pid, poolPda(pid, poolAuthority()), k.owner.publicKey);
    try {
      const mai = await connection().getAccountInfo(md);
      const revoked = mai ? decodeMandate(mai.data).revoked : false;
      // Revoked mandates are restored with set_agent (which clears `revoked`), per SPEC.
      const ix = b.restore || revoked ? ixs.setAgent(pid, k.owner.publicKey, md, k.agent.publicKey) : ixs.revoke(pid, k.owner.publicKey, md);
      json(res, 200, { ok: true, revoked: !(b.restore || revoked), signature: await send(connection(), [ix], [k.owner]) });
    } catch (e) { json(res, 422, { ok: false, error: (e as Error).message }); }
  },
  "POST /api/hijack": async (_q, res) => json(res, 200, await hijack()),
};

async function serveStatic(path: string, res: ServerResponse) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" });
    res.end(data);
  } catch { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const h = routes[`${req.method} ${url.pathname}`];
  try {
    if (h) await h(req, res);
    else if (req.method === "GET" && !url.pathname.startsWith("/api/")) await serveStatic(url.pathname, res);
    else json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 502, { error: (e as Error).message || "upstream error" });
  }
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => console.log(`Awning on http://localhost:${PORT}  (rpc ${RPC_URL}, program ${programId()?.toBase58() ?? "unset"})`));
void USDC;
