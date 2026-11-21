// One-shot localnet bootstrap: mock USDC, pool, funding, demo mandate ($50/cover, $120/day, $500 payout), deposit.
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { connection, decodePool, deployed, ixs, keys, mandatePda, poolPda, programId, send, USDC, RPC_URL, key } from "./chain.ts";

const conn = connection();
const k = keys();
const dep = await deployed(conn);
if (!dep.deployed) {
  console.error(`Program not deployed (${dep.reason}). Deploy it to ${RPC_URL} first.`);
  process.exit(1);
}
const pid = programId()!;
for (const kp of [k.authority, k.owner, k.agent, k.quoter, k.resolver]) {
  if ((await conn.getBalance(kp.publicKey)) < LAMPORTS_PER_SOL) {
    const s = await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(s, "confirmed");
  }
}
const pool = poolPda(pid, k.authority.publicKey);
let mintPk: PublicKey;
const pai = await conn.getAccountInfo(pool);
if (!pai) {
  mintPk = await createMint(conn, k.authority, k.authority.publicKey, null, 6, key("usdc-mint"));
  console.log("mock USDC", mintPk.toBase58());
  console.log("init_pool", await send(conn, [ixs.initPool(pid, k.authority.publicKey, mintPk, k.quoter.publicKey, k.resolver.publicKey)], [k.authority]));
} else {
  mintPk = decodePool(pai.data).usdcMint;
}
const authAta = await getOrCreateAssociatedTokenAccount(conn, k.authority, mintPk, k.authority.publicKey);
const ownerAta = await getOrCreateAssociatedTokenAccount(conn, k.authority, mintPk, k.owner.publicKey);
await getOrCreateAssociatedTokenAccount(conn, k.authority, mintPk, k.agent.publicKey);
await mintTo(conn, k.authority, mintPk, authAta.address, k.authority, 10_000n * USDC);
await mintTo(conn, k.authority, mintPk, ownerAta.address, k.authority, 1_000n * USDC);
console.log("fund_pool", await send(conn, [ixs.fundPool(pid, k.authority.publicKey, pool, authAta.address, 10_000n * USDC)], [k.authority]));
const md = mandatePda(pid, pool, k.owner.publicKey);
if (!(await conn.getAccountInfo(md))) {
  const l = { maxPremiumPerCover: 50n * USDC, maxPremiumPerDay: 120n * USDC, maxPayoutPerCover: 500n * USDC };
  console.log("open_mandate", await send(conn, [ixs.openMandate(pid, k.owner.publicKey, pool, mintPk, k.agent.publicKey, l)], [k.owner]));
}
console.log("deposit", await send(conn, [ixs.deposit(pid, k.owner.publicKey, md, ownerAta.address, 300n * USDC)], [k.owner]));
console.log(JSON.stringify({ programId: pid.toBase58(), pool: pool.toBase58(), mandate: md.toBase58(), mint: mintPk.toBase58(), owner: k.owner.publicKey.toBase58(), agent: k.agent.publicKey.toBase58() }, null, 2));
