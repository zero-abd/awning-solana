// Awning front end. Every string from the network goes through esc().
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const usdc = (base) => (base == null ? "—" : money(Number(base) / 1e6));
const pct = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + "%";
let STATUS = { deployed: false, buyEnabled: false };

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return { ok: r.ok, status: r.status, ...j };
}

// theme
const saved = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
if (saved) document.documentElement.dataset.theme = saved;
$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
});

async function loadStatus() {
  const s = await api("/api/status").catch(() => null);
  if (!s) return;
  STATUS = s;
  const pill = $("#status");
  pill.className = "pill " + (s.deployed ? "ok" : "warn");
  pill.textContent = `${s.cluster} · ${s.deployed ? (s.pool ? "pool " + usdc(s.pool.free) + " free" : "program live, no pool") : "program not deployed"}`;
  const b = $("#banner");
  if (!s.deployed) { b.hidden = false; b.textContent = `Program not deployed on ${s.cluster}${s.programId ? " (" + s.programId.slice(0, 8) + "…)" : ""}. Quotes are live; buying is off until it is.`; }
  else if (!s.pool) { b.hidden = false; b.textContent = "Program is live but the pool isn't set up yet. Run npm run setup:localnet."; }
  else b.hidden = true;
  document.querySelectorAll("[data-buy]").forEach((el) => (el.disabled = !s.buyEnabled));
}

function quoteTicket(q) {
  const legs = q.contracts.map((c) => `${esc(c.label)} @ ${esc(c.ask)}`).join(" + ");
  return `<article class="ticket quote">
    <div class="muted small">${esc(q.sentence)}</div>
    <div class="head">${esc(q.headline)}</div>
    <div class="stats">
      <div class="stat"><div class="k">Pays</div><div class="v">${esc(money(q.payout))}</div></div>
      <div class="stat"><div class="k">Costs</div><div class="v">${esc(money(q.cost))}</div></div>
      <div class="stat"><div class="k">Odds</div><div class="v">${esc(pct(q.odds))}</div></div>
    </div>
    <p class="small">${esc(q.explanation)}</p>
    <div class="note"><b>Basis risk.</b> ${esc(q.basisRisk)}</div>
    <div class="meta">Market <b>${esc(q.market.eventTicker)}</b> · ${esc(q.market.title)} · legs ${legs} · on-chain id <code>${esc(q.market.onchainMarket)}</code> · <a href="${esc(q.market.url)}" target="_blank" rel="noopener">Gemini Predictions ↗</a></div>
    <div class="actions">
      <button class="btn primary" data-buy="${esc(q.id)}" ${STATUS.buyEnabled ? "" : "disabled"}>Buy cover · ${esc(money(q.cost))}</button>
      <span class="muted small">${STATUS.buyEnabled ? "Your agent signs; the pool's quoter co-signs the price." : "Buying needs the program deployed."}</span>
    </div>
    <div class="buy-out"></div>
  </article>`;
}

async function getQuote(sentence) {
  const slot = $("#quote");
  slot.innerHTML = `<div class="muted" style="margin-top:14px">Reading live markets…</div>`;
  const q = await api("/api/quote", { sentence });
  if (!q.ok) { slot.innerHTML = `<div class="err">${esc(q.error)}${q.hint ? " " + esc(q.hint) : ""}</div>`; return; }
  slot.innerHTML = quoteTicket(q);
}

$("#ask").addEventListener("submit", (e) => { e.preventDefault(); const s = $("#sentence").value.trim() || $("#sentence").placeholder; getQuote(s); });

document.addEventListener("click", async (e) => {
  const buy = e.target.closest("[data-buy]");
  if (buy) {
    buy.disabled = true; const out = buy.closest(".ticket").querySelector(".buy-out");
    out.innerHTML = `<div class="muted small">Agent is signing…</div>`;
    const r = await api("/api/buy", { quoteId: buy.dataset.buy });
    out.innerHTML = r.ok ? `<div class="okmsg">Bought. Cover #${esc(r.coverId)} · tx ${esc(r.signature)}</div>` : `<div class="err">Refused: ${esc(r.error)}</div>`;
    if (!r.ok) buy.disabled = false;
    loadAgent(); loadStatus();
    return;
  }
  const card = e.target.closest("[data-sentence]");
  if (card) { $("#sentence").value = card.dataset.sentence; getQuote(card.dataset.sentence); $("#ask").scrollIntoView({ behavior: "smooth" }); }
});

async function loadExamples() {
  const r = await api("/api/examples").catch(() => ({ ok: false, error: "network" }));
  const box = $("#examples");
  if (!r.ok || !r.examples?.length) { box.innerHTML = `<div class="err">No live weather markets to price right now${r.error ? " (" + esc(r.error) + ")" : ""}.</div>`; return; }
  $("#ex-meta").textContent = `${r.examples.length} from ${r.markets} live Gemini weather markets`;
  box.innerHTML = r.examples.map((q) => `<button class="ticket card" type="button" data-sentence="${esc(q.sentence)}">
    <div class="muted small">${esc(q.city)} · ${esc(q.day)}</div>
    <div class="s">“${esc(q.sentence)}”</div>
    <div class="row"><span>Pays <b>${esc(money(q.payout))}</b></span><span>Costs <b>${esc(money(q.cost))}</b></span><span>Odds <b>${esc(pct(q.odds))}</b></span></div>
  </button>`).join("");
}

async function loadAgent() {
  const a = await api("/api/agent").catch(() => null);
  const box = $("#agent");
  if (!a) { box.textContent = "Couldn't reach the server."; return; }
  if (!a.deployed) { box.innerHTML = `<p class="muted">${esc(a.reason || "Program not deployed.")}</p><p class="small muted">Once the program is deployed, your mandate, limits and covers appear here, read straight from chain.</p>`; return; }
  if (!a.mandateState) { box.innerHTML = `<p class="muted">No mandate yet. Run <code>npm run setup:localnet</code>.</p>`; return; }
  const m = a.mandateState, L = m.limits;
  box.innerHTML = `<dl class="kv">
      <dt>Status</dt><dd>${m.revoked ? "Revoked" : "Active"}</dd>
      <dt>Budget in vault</dt><dd>${esc(usdc(m.vaultAmount))}</dd>
      <dt>Spent today</dt><dd>${esc(usdc(m.spentToday))} of ${esc(usdc(L.maxPremiumPerDay))}</dd>
      <dt>Total spent</dt><dd>${esc(usdc(m.totalSpent))}</dd>
      <dt>Agent</dt><dd>${esc(a.agent.slice(0, 6))}…${esc(a.agent.slice(-4))}</dd>
    </dl>
    <form id="limits" class="limits">
      <label>Max per cover ($)<input name="perCover" inputmode="decimal" value="${esc(Number(L.maxPremiumPerCover) / 1e6)}"></label>
      <label>Max per day ($)<input name="perDay" inputmode="decimal" value="${esc(Number(L.maxPremiumPerDay) / 1e6)}"></label>
      <label>Max payout ($)<input name="payout" inputmode="decimal" value="${esc(Number(L.maxPayoutPerCover) / 1e6)}"></label>
    </form>
    <div class="actions"><button class="btn small" id="save-limits">Save limits</button><button class="btn small" id="revoke">${m.revoked ? "Restore agent" : "Revoke agent"}</button></div>
    <div id="agent-out"></div>
    <h3 class="small" style="margin:16px 0 6px">Covers</h3>
    ${a.covers.length ? a.covers.map((c) => `<div class="attempt"><span>#${esc(c.id)} ${esc(c.market)}</span><span>${esc(usdc(c.payout))} for ${esc(usdc(c.premium))} · ${esc(c.state)}</span></div>`).join("") : `<p class="muted small">None yet.</p>`}`;
  $("#save-limits").onclick = async () => {
    const f = new FormData($("#limits"));
    const r = await api("/api/agent/limits", Object.fromEntries(f));
    $("#agent-out").innerHTML = r.ok ? `<div class="okmsg">Limits saved on-chain.</div>` : `<div class="err">${esc(r.error)}</div>`;
    setTimeout(loadAgent, 800);
  };
  $("#revoke").onclick = async () => {
    const r = await api("/api/agent/revoke", {});
    $("#agent-out").innerHTML = r.ok ? `<div class="okmsg">${r.revoked ? "Agent revoked." : "Agent restored."}</div>` : `<div class="err">${esc(r.error)}</div>`;
    setTimeout(loadAgent, 800);
  };
}

$("#hijack").addEventListener("click", async () => {
  const out = $("#hijack-out");
  out.innerHTML = `<p class="muted small">Simulating…</p>`;
  const r = await api("/api/hijack", {});
  if (!r.deployed) { out.innerHTML = `<p class="muted small">${esc(r.reason || "Program not deployed.")} Nothing was simulated.</p>`; return; }
  if (!r.attempts?.length) { out.innerHTML = `<p class="muted small">${esc(r.reason)}</p>`; return; }
  out.innerHTML = r.attempts.map((a) => `<div class="attempt"><span>${esc(a.name)}${a.error ? `<br><span class="muted small">${esc(a.error)}</span>` : ""}</span><span class="tag ${a.refused ? "ok" : "bad"}">${a.refused ? "REFUSED" : "ALLOWED"}</span></div>`).join("");
});

loadStatus().then(() => { loadAgent(); });
loadExamples();
setInterval(loadStatus, 15000);
