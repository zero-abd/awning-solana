# Awning on Solana — program/app contract

Awning pays a small business when a bad day hits (a cold snap, a heat wave…). Cover is priced from live
Gemini prediction markets and bought by an AI agent whose spending limits are enforced on-chain.
This repo is written from scratch for Solana: an Anchor program (`programs/awning`) and a web app (`app`).

## Program `awning` (Anchor; standard Anchor discriminators)
Instruction discriminator = sha256("global:<snake_name>")[..8]; account discriminator = sha256("account:<TypeName>")[..8].
All amounts are USDC base units (6 decimals). Borsh encoding. `Limits` = { max_premium_per_cover: u64, max_premium_per_day: u64, max_payout_per_cover: u64 }.

### Accounts (PDAs)
- `Pool` seeds ["pool", authority]: authority, quoter, resolver, usdc_mint, vault, locked: u64, premiums: u64, open_covers: u32, bump: u8, vault_bump: u8
- pool vault: SPL token account, seeds ["vault", pool], authority = pool PDA
- `Mandate` seeds ["mandate", pool, owner]: owner, agent, pool, vault, limits: Limits, day: i64 (unix_ts / 86400), spent_today: u64, total_spent: u64, covers: u64 (next cover id), revoked: bool, bump: u8, vault_bump: u8
- mandate vault: SPL token account, seeds ["mandate_vault", mandate], authority = mandate PDA
- `Cover` seeds ["cover", mandate, cover_id.to_le_bytes()]: mandate, owner, market: String (≤ 48 bytes, Gemini contract ticker/id), payout: u64, premium: u64, expires_at: i64, state: u8 (0 Open, 1 PaidOut, 2 Expired), bump: u8

### Instructions (accounts in this exact order)
1. `init_pool(quoter: Pubkey, resolver: Pubkey)` — authority (signer, mut), pool (init), usdc_mint, vault (init), token_program, system_program
2. `fund_pool(amount: u64)` — funder (signer), pool, vault (mut), funder_token (mut), token_program
3. `withdraw_pool(amount: u64)` — authority (signer), pool, vault (mut), authority_token (mut), token_program. Only free liquidity (vault.amount − locked).
4. `open_mandate(agent: Pubkey, limits: Limits)` — owner (signer, mut), pool, mandate (init), usdc_mint, mandate_vault (init), token_program, system_program
5. `deposit(amount: u64)` — owner (signer), mandate, mandate_vault (mut), owner_token (mut), token_program
6. `withdraw(amount: u64)` — owner (signer), mandate, mandate_vault (mut), owner_token (mut), token_program. Owner only; the agent can never move budget out.
7. `set_limits(limits: Limits)` — owner (signer), mandate
8. `set_agent(agent: Pubkey)` — owner (signer), mandate. Also clears `revoked`.
9. `revoke()` — owner (signer), mandate
10. `buy_cover(market: String, payout: u64, premium: u64, expires_at: i64)` — agent (signer, mut, pays Cover rent), quoter (signer: the pool's pricing key co-signs every price), pool (mut), pool_vault (mut), mandate (mut), mandate_vault (mut), cover (init, id = mandate.covers), token_program, system_program.
    Checks: agent == mandate.agent; !revoked; quoter == pool.quoter; mandate.pool == pool; 0 < premium < payout; premium ≤ max_premium_per_cover; payout ≤ max_payout_per_cover; roll day, spent_today + premium ≤ max_premium_per_day; expires_at > now; pool can lock payout (pool_vault.amount + premium − locked ≥ payout).
    Effects: premium mandate_vault → pool_vault (mandate PDA signs); pool.locked += payout; spent_today/total_spent += premium; covers += 1; Cover created with owner = mandate.owner. Emits `CoverBought`.
11. `settle_cover(happened: bool)` — resolver (signer), pool (mut), pool_vault (mut), cover (mut), owner_token (mut; must be owned by cover.owner with pool.usdc_mint), token_program.
    Requires state Open. happened → payout pool_vault → owner_token (pool PDA signs), state PaidOut; else state Expired. Either way pool.locked −= payout. Emits `CoverSettled`.

### Errors (custom, in order from 6000)
NotAgent, Revoked, BadQuoter, BadPrice, OverCoverLimit, OverPayoutLimit, OverDailyLimit, Expired, PoolTooThin, NotOpen, InsufficientFree, MarketTooLong, WrongPool, WrongOwner, MathOverflow

## App notes
- App reads the program id from AWNING_PROGRAM_ID, else `declare_id!` in programs/awning/src/lib.rs, else Anchor.toml. Pool authority = AWNING_POOL_AUTHORITY or app/.keys/authority.json.
- Decoders assume fields are laid out in exactly the order listed above (Anchor/Borsh, no padding), after the 8-byte discriminator.
- On-chain `market` = Gemini instrumentSymbol for a single-bucket cover, else `<eventTicker>:LE<n>` / `:GE<n>` for a multi-bucket strip (≤ 48 bytes).
- Revoked mandates are restored through `set_agent` (it clears `revoked`).
