# Awning program: security audit log

## Solana MCP `program_autofixer` (framework: anchor)
- File: `programs/awning/src/lib.rs` (the whole program; there are no other program .rs files).
- Run 1 (final source): `{"issues":[],"suggestions":[],"framework_detected":"anchor","require_another_tool_call_after_fixing":false}`
- Issues fixed: none were reported. Issues dismissed: none.

## Checks built in by design
- Every relation is constrained: `has_one = authority` (withdraw_pool), `has_one = resolver` (settle_cover), `has_one = owner` (deposit/withdraw/set_*/revoke), `mandate.agent == agent` (NotAgent), `pool.quoter == quoter` plus a quoter `Signer` (BadQuoter), `mandate.pool == pool` (WrongPool), `pool.vault == pool_vault` and `mandate.vault == mandate_vault`.
- All PDAs are re-derived from seeds and checked against the stored bumps (`pool.bump`, `vault_bump`, `mandate.bump`, `mandate.vault_bump`). The Cover PDA uses `mandate.covers` (LE u64) as its id.
- Token accounts: vaults are PDA token accounts with authority = pool/mandate PDA. User token accounts are checked with `token::mint` (= pool.usdc_mint / vault mint) and `token::authority`. For settle, `owner_token` must be owned by `cover.owner`.
- Checked arithmetic everywhere, with MathOverflow on failure. withdraw_pool only moves `vault.amount - locked` (InsufficientFree).
- settle_cover requires `state == Open` (NotOpen), so a cover cannot be paid twice.
- The agent has no path to move budget out: withdraw requires `owner` to sign and to match the mandate seeds/has_one.

## Test evidence
`cargo test -p awning`: 11 host-native solana-program-test transactions, all pass (see tests/awning.rs).
