# Awning on Solana

Awning rebuilt from scratch on Solana: say what could go wrong, get paid when it does. Cover is priced
from live Gemini prediction markets and bought by an AI agent whose limits a Solana program enforces.

- `programs/awning`: Anchor 0.31 program. A pool locks the whole payout before the owner pays anything;
  a mandate caps the agent per cover, per day and per payout; the pool's quoter key co-signs every
  price; only the owner can move budget out. 11 integration tests (solana-program-test, real SPL Token)
  cover limits, quoter, revoke, hijack, settlement and pool liquidity. Linted clean by the Solana
  Developer MCP's `program_autofixer` (see `programs/awning/AUDIT.md`).
- `app`: Node + TypeScript server and vanilla web UI. Parses a sentence, matches the Gemini weather
  market whose YES pays on that day, prices it, buys cover on-chain, shows the agent's limits, and runs
  the hijack test (agent key tries to withdraw, overspend, buy after revoke, buy without the quoter).
- `SPEC.md`: the account and instruction contract. `idl/awning.json`: Anchor IDL.
- `tools/solana-mcp.mjs`: small client for the Solana Developer MCP (mcp.solana.com) used while building.

## Run locally

Needs the Solana CLI (Agave) and Node 22.

```bash
solana-test-validator --reset                       # terminal 1
solana-keygen new -o programs/awning/keypair.json   # program id; then put it in declare_id!, Anchor.toml, idl
cargo build-sbf --manifest-path programs/awning/Cargo.toml
solana program deploy target/deploy/awning.so --program-id programs/awning/keypair.json
cargo test -p awning                                # native integration tests
cd app && npm install
npx tsx src/setup-localnet.ts                       # mock USDC, pool, demo mandate ($50/cover, $120/day)
npx tsx src/server.ts                               # http://localhost:3000
```

Keypairs are never committed: generate your own program id as above.
