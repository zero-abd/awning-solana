#!/usr/bin/env node
// Minimal client for the Solana Developer MCP (https://mcp.solana.com/mcp).
// Usage: node tools/solana-mcp.mjs <tool> '<json arguments>'   |   node tools/solana-mcp.mjs --list
const URL_ = process.env.SOLANA_MCP_URL || "https://mcp.solana.com/mcp";
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body, sid) {
  const r = await fetch(URL_, { method: "POST", headers: sid ? { ...H, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } : H, body: JSON.stringify(body) });
  const text = await r.text();
  const msgs = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))) : text ? [JSON.parse(text)] : [];
  return { sid: r.headers.get("mcp-session-id") || sid, msg: msgs.find((m) => m.id === body.id) };
}
const [tool, argJson] = process.argv.slice(2);
const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "awning-solana-dev", version: "1" } } });
const sid = init.sid;
await fetch(URL_, { method: "POST", headers: sid ? { ...H, "mcp-session-id": sid } : H, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
if (!tool || tool === "--list") {
  const { msg } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  for (const t of msg.result.tools) console.log(`${t.name}: ${t.description.split("\n")[0]}`);
} else {
  const { msg } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: JSON.parse(argJson || "{}") } }, sid);
  if (msg.error) { console.error(JSON.stringify(msg.error)); process.exit(1); }
  for (const c of msg.result.content || []) console.log(c.type === "text" ? c.text : JSON.stringify(c));
  if (msg.result.structuredContent && !(msg.result.content || []).length) console.log(JSON.stringify(msg.result.structuredContent, null, 2));
}
