// "Hijack test": the agent key tries to break out of its mandate. Every attempt is simulated against the real program.
import { Transaction, TransactionInstruction, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { connection, decodeMandate, decodePool, deployed, ixs, keys, mandatePda, poolAuthority, poolPda, programError, programId, USDC } from "./chain.ts";

async function simulateSigned(instrs: TransactionInstruction[], signers: Keypair[]) {
  const conn = connection();
  const tx = new Transaction().add(...instrs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sim = await conn.simulateTransaction(tx);
  return { refused: !!sim.value.err, error: sim.value.err ? programError(sim.value.logs, sim.value.err) : null, logs: (sim.value.logs ?? []).slice(-6) };
}

export async function hijack() {
  const conn = connection();
  const dep = await deployed(conn);
  if (!dep.deployed) return { deployed: false, reason: dep.reason, attempts: [] };
  const pid = programId()!;
  const k = keys();
  const pool = poolPda(pid, poolAuthority());
  const md = mandatePda(pid, pool, k.owner.publicKey);
  const [pai, mai] = await conn.getMultipleAccountsInfo([pool, md]);
  if (!pai || !mai) return { deployed: true, reason: "Pool or mandate missing — run `npm run setup:localnet`", attempts: [] };
  const p = decodePool(pai.data);
  const mm = decodeMandate(mai.data);
  const agentAta = getAssociatedTokenAddressSync(p.usdcMint, k.agent.publicKey);
  const exp = BigInt(Math.floor(Date.now() / 1000) + 86400);
  const buy = (premium: bigint, quoterSigns = true) =>
    ixs.buyCover(pid, { agent: k.agent.publicKey, quoter: k.quoter.publicKey, pool, mandate: md, coverId: mm.covers, quoterSigns }, "HIJACK-TEST", 400n * USDC, premium, exp);
  const attempts: Array<{ name: string; refused: boolean; error: string | null; logs: string[] }> = [];
  attempts.push({ name: "Agent withdraws the owner's budget to itself", ...(await simulateSigned([ixs.withdraw(pid, k.agent.publicKey, md, agentAta, 10n * USDC)], [k.agent])) });
  attempts.push({ name: `Agent buys cover over the per-cover limit ($${Number(mm.limits.maxPremiumPerCover + USDC) / 1e6})`, ...(await simulateSigned([buy(mm.limits.maxPremiumPerCover + USDC)], [k.agent, k.quoter])) });
  // Revoke + buy in one simulated transaction: nothing persists, but the program sees a revoked mandate.
  attempts.push({ name: "Agent buys cover after the owner revokes it", ...(await simulateSigned([ixs.revoke(pid, k.owner.publicKey, md), buy(5n * USDC)], [k.agent, k.owner, k.quoter])) });
  // Quoter account marked non-signer so the tx is well-formed; Anchor's Signer check must refuse it.
  attempts.push({ name: "Agent buys cover without the quoter's signature", ...(await simulateSigned([buy(5n * USDC, false)], [k.agent])) });
  return { deployed: true, attempts };
}
