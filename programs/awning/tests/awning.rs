//! Host-native integration tests (solana-program-test, native processor mode).
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::{spl_token, TokenAccount};
use awning::{Cover, Limits, Mandate, Pool};
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{Instruction, InstructionError},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::{Transaction, TransactionError},
};

// Anchor's `entry` wants one lifetime for everything; program-test's processor! hands us several.
fn entry_shim<'a, 'b, 'c, 'd>(
    program_id: &'a Pubkey,
    accounts: &'b [AccountInfo<'c>],
    data: &'d [u8],
) -> ProgramResult {
    let accounts: &'c [AccountInfo<'c>] = unsafe { std::mem::transmute(accounts) };
    awning::entry(program_id, accounts, data)
}

const NOT_AGENT: u32 = 6000;
const REVOKED: u32 = 6001;
const BAD_QUOTER: u32 = 6002;
const OVER_COVER_LIMIT: u32 = 6004;
const OVER_DAILY_LIMIT: u32 = 6006;
const POOL_TOO_THIN: u32 = 6008;
const NOT_OPEN: u32 = 6009;
const INSUFFICIENT_FREE: u32 = 6010;
const ANCHOR_HAS_ONE: u32 = 2001;
const ANCHOR_SEEDS: u32 = 2006;

const TOKEN: Pubkey = anchor_spl::token::ID;
const SYSTEM: Pubkey = anchor_lang::system_program::ID;

struct Env {
    ctx: ProgramTestContext,
    payer: Keypair,
    authority: Keypair,
    quoter: Keypair,
    resolver: Keypair,
    owner: Keypair,
    agent: Keypair,
    mint: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
    mandate: Pubkey,
    mandate_vault: Pubkey,
    authority_token: Pubkey,
    owner_token: Pubkey,
    agent_token: Pubkey,
}

fn limits() -> Limits {
    Limits { max_premium_per_cover: 50_000_000, max_premium_per_day: 80_000_000, max_payout_per_cover: 1_000_000_000 }
}

fn code(e: BanksClientError) -> Option<u32> {
    match e.unwrap() {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(c),
        other => {
            println!("non-custom error: {other:?}");
            None
        }
    }
}

impl Env {
    async fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), BanksClientError> {
        let bh = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&self.payer.pubkey()), &all, bh);
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn token_account(&mut self, owner: &Pubkey) -> Pubkey {
        let kp = Keypair::new();
        let rent = self.ctx.banks_client.get_rent().await.unwrap();
        let ixs = [
            system_instruction::create_account(
                &self.payer.pubkey(),
                &kp.pubkey(),
                rent.minimum_balance(spl_token::state::Account::LEN),
                spl_token::state::Account::LEN as u64,
                &TOKEN,
            ),
            spl_token::instruction::initialize_account3(&TOKEN, &kp.pubkey(), &self.mint, owner).unwrap(),
        ];
        self.send(&ixs, &[&kp]).await.unwrap();
        kp.pubkey()
    }

    async fn mint_to(&mut self, to: &Pubkey, amount: u64) {
        let ix = spl_token::instruction::mint_to(&TOKEN, &self.mint, to, &self.payer.pubkey(), &[], amount).unwrap();
        self.send(&[ix], &[]).await.unwrap();
    }

    async fn balance(&mut self, ta: &Pubkey) -> u64 {
        let acc = self.ctx.banks_client.get_account(*ta).await.unwrap().unwrap();
        TokenAccount::try_deserialize(&mut acc.data.as_slice()).unwrap().amount
    }

    async fn read<T: AccountDeserialize>(&mut self, pk: &Pubkey) -> T {
        let acc = self.ctx.banks_client.get_account(*pk).await.unwrap().unwrap();
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    async fn now(&mut self) -> i64 {
        self.ctx.banks_client.get_sysvar::<Clock>().await.unwrap().unix_timestamp
    }

    fn cover_pda(&self, id: u64) -> Pubkey {
        Pubkey::find_program_address(&[b"cover", self.mandate.as_ref(), &id.to_le_bytes()], &awning::ID).0
    }

    /// Fresh chain with a pool (funded with `pool_funds`) and a mandate (deposit `budget`).
    async fn new(pool_funds: u64, budget: u64) -> Env {
        let pt = ProgramTest::new("awning", awning::ID, processor!(entry_shim));
        let ctx = pt.start_with_context().await;
        let payer = ctx.payer.insecure_clone();
        let authority = Keypair::new();
        let owner = Keypair::new();
        let agent = Keypair::new();
        let mint_kp = Keypair::new();
        let mut env = Env {
            ctx,
            payer,
            authority,
            quoter: Keypair::new(),
            resolver: Keypair::new(),
            owner,
            agent,
            mint: mint_kp.pubkey(),
            pool: Pubkey::default(),
            vault: Pubkey::default(),
            mandate: Pubkey::default(),
            mandate_vault: Pubkey::default(),
            authority_token: Pubkey::default(),
            owner_token: Pubkey::default(),
            agent_token: Pubkey::default(),
        };
        // SOL for the actors that pay rent.
        let fund: Vec<Instruction> = [env.authority.pubkey(), env.owner.pubkey(), env.agent.pubkey()]
            .iter()
            .map(|k| system_instruction::transfer(&env.payer.pubkey(), k, 10_000_000_000))
            .collect();
        env.send(&fund, &[]).await.unwrap();
        // USDC-like mint, 6 decimals.
        let rent = env.ctx.banks_client.get_rent().await.unwrap();
        let ixs = [
            system_instruction::create_account(
                &env.payer.pubkey(),
                &env.mint,
                rent.minimum_balance(spl_token::state::Mint::LEN),
                spl_token::state::Mint::LEN as u64,
                &TOKEN,
            ),
            spl_token::instruction::initialize_mint2(&TOKEN, &env.mint, &env.payer.pubkey(), None, 6).unwrap(),
        ];
        env.send(&ixs, &[&mint_kp]).await.unwrap();

        let a = env.authority.pubkey();
        env.authority_token = env.token_account(&a).await;
        let o = env.owner.pubkey();
        env.owner_token = env.token_account(&o).await;
        let g = env.agent.pubkey();
        env.agent_token = env.token_account(&g).await;
        let at = env.authority_token;
        env.mint_to(&at, 10_000_000_000).await;
        let ot = env.owner_token;
        env.mint_to(&ot, 1_000_000_000).await;

        // init_pool + fund_pool
        env.pool = Pubkey::find_program_address(&[b"pool", a.as_ref()], &awning::ID).0;
        env.vault = Pubkey::find_program_address(&[b"vault", env.pool.as_ref()], &awning::ID).0;
        let ix = Instruction {
            program_id: awning::ID,
            accounts: awning::accounts::InitPool {
                authority: a,
                pool: env.pool,
                usdc_mint: env.mint,
                vault: env.vault,
                token_program: TOKEN,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: awning::instruction::InitPool { quoter: env.quoter.pubkey(), resolver: env.resolver.pubkey() }.data(),
        };
        let auth = env.authority.insecure_clone();
        env.send(&[ix], &[&auth]).await.unwrap();
        if pool_funds > 0 {
            let ix = Instruction {
                program_id: awning::ID,
                accounts: awning::accounts::FundPool {
                    funder: a,
                    pool: env.pool,
                    vault: env.vault,
                    funder_token: env.authority_token,
                    token_program: TOKEN,
                }
                .to_account_metas(None),
                data: awning::instruction::FundPool { amount: pool_funds }.data(),
            };
            env.send(&[ix], &[&auth]).await.unwrap();
        }

        // open_mandate + deposit
        env.mandate = Pubkey::find_program_address(&[b"mandate", env.pool.as_ref(), o.as_ref()], &awning::ID).0;
        env.mandate_vault = Pubkey::find_program_address(&[b"mandate_vault", env.mandate.as_ref()], &awning::ID).0;
        let ix = Instruction {
            program_id: awning::ID,
            accounts: awning::accounts::OpenMandate {
                owner: o,
                pool: env.pool,
                mandate: env.mandate,
                usdc_mint: env.mint,
                mandate_vault: env.mandate_vault,
                token_program: TOKEN,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: awning::instruction::OpenMandate { agent: g, limits: limits() }.data(),
        };
        let own = env.owner.insecure_clone();
        env.send(&[ix], &[&own]).await.unwrap();
        if budget > 0 {
            let ix = env.deposit_ix(budget);
            env.send(&[ix], &[&own]).await.unwrap();
        }
        env
    }

    fn deposit_ix(&self, amount: u64) -> Instruction {
        Instruction {
            program_id: awning::ID,
            accounts: awning::accounts::Deposit {
                owner: self.owner.pubkey(),
                mandate: self.mandate,
                mandate_vault: self.mandate_vault,
                owner_token: self.owner_token,
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: awning::instruction::Deposit { amount }.data(),
        }
    }

    fn buy_ix(&self, agent: &Pubkey, quoter: &Pubkey, id: u64, payout: u64, premium: u64, expires_at: i64) -> Instruction {
        Instruction {
            program_id: awning::ID,
            accounts: awning::accounts::BuyCover {
                agent: *agent,
                quoter: *quoter,
                pool: self.pool,
                pool_vault: self.vault,
                mandate: self.mandate,
                mandate_vault: self.mandate_vault,
                cover: self.cover_pda(id),
                token_program: TOKEN,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: awning::instruction::BuyCover {
                market: "KXHIGHNY-26NOV22-T40".to_string(),
                payout,
                premium,
                expires_at,
            }
            .data(),
        }
    }

    async fn buy(&mut self, payout: u64, premium: u64) -> Result<(), BanksClientError> {
        let exp = self.now().await + 86_400;
        let id = self.read::<Mandate>(&self.mandate.clone()).await.covers;
        let ix = self.buy_ix(&self.agent.pubkey(), &self.quoter.pubkey(), id, payout, premium, exp);
        let (agent, quoter) = (self.agent.insecure_clone(), self.quoter.insecure_clone());
        self.send(&[ix], &[&agent, &quoter]).await
    }

    fn settle_ix(&self, resolver: &Pubkey, cover: Pubkey, happened: bool) -> Instruction {
        Instruction {
            program_id: awning::ID,
            accounts: awning::accounts::SettleCover {
                resolver: *resolver,
                pool: self.pool,
                pool_vault: self.vault,
                cover,
                owner_token: self.owner_token,
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: awning::instruction::SettleCover { happened }.data(),
        }
    }
}

#[tokio::test]
async fn init_pool_and_fund_pool() {
    let mut env = Env::new(2_000_000_000, 0).await;
    let pool: Pool = env.read(&env.pool.clone()).await;
    assert_eq!(pool.authority, env.authority.pubkey());
    assert_eq!(pool.quoter, env.quoter.pubkey());
    assert_eq!(pool.resolver, env.resolver.pubkey());
    assert_eq!(pool.usdc_mint, env.mint);
    assert_eq!(pool.vault, env.vault);
    assert_eq!(pool.locked, 0);
    let v = env.vault;
    assert_eq!(env.balance(&v).await, 2_000_000_000);
}

#[tokio::test]
async fn open_mandate_and_deposit() {
    let mut env = Env::new(0, 300_000_000).await;
    let m: Mandate = env.read(&env.mandate.clone()).await;
    assert_eq!(m.owner, env.owner.pubkey());
    assert_eq!(m.agent, env.agent.pubkey());
    assert_eq!(m.pool, env.pool);
    assert_eq!(m.vault, env.mandate_vault);
    assert_eq!(m.limits, limits());
    assert_eq!(m.covers, 0);
    assert!(!m.revoked);
    let mv = env.mandate_vault;
    assert_eq!(env.balance(&mv).await, 300_000_000);
    let ot = env.owner_token;
    assert_eq!(env.balance(&ot).await, 700_000_000);
}

#[tokio::test]
async fn buy_cover_happy_path() {
    let mut env = Env::new(2_000_000_000, 300_000_000).await;
    env.buy(500_000_000, 40_000_000).await.unwrap();
    let (mv, v) = (env.mandate_vault, env.vault);
    assert_eq!(env.balance(&mv).await, 260_000_000);
    assert_eq!(env.balance(&v).await, 2_040_000_000);
    let pool: Pool = env.read(&env.pool.clone()).await;
    assert_eq!(pool.locked, 500_000_000);
    assert_eq!(pool.premiums, 40_000_000);
    assert_eq!(pool.open_covers, 1);
    let m: Mandate = env.read(&env.mandate.clone()).await;
    assert_eq!(m.covers, 1);
    assert_eq!(m.spent_today, 40_000_000);
    assert_eq!(m.total_spent, 40_000_000);
    let c: Cover = env.read(&env.cover_pda(0)).await;
    assert_eq!(c.mandate, env.mandate);
    assert_eq!(c.owner, env.owner.pubkey());
    assert_eq!(c.market, "KXHIGHNY-26NOV22-T40");
    assert_eq!(c.payout, 500_000_000);
    assert_eq!(c.premium, 40_000_000);
    assert_eq!(c.state, 0);
}

#[tokio::test]
async fn over_per_cover_limit() {
    let mut env = Env::new(2_000_000_000, 300_000_000).await;
    let e = env.buy(500_000_000, 50_000_001).await.unwrap_err();
    assert_eq!(code(e), Some(OVER_COVER_LIMIT));
}

#[tokio::test]
async fn over_daily_limit() {
    let mut env = Env::new(2_000_000_000, 300_000_000).await;
    env.buy(500_000_000, 45_000_000).await.unwrap();
    let e = env.buy(500_000_000, 45_000_000).await.unwrap_err();
    assert_eq!(code(e), Some(OVER_DAILY_LIMIT));
}

#[tokio::test]
async fn buy_requires_the_pool_quoter() {
    let mut env = Env::new(2_000_000_000, 300_000_000).await;
    let exp = env.now().await + 86_400;
    // Quoter account present but not signing.
    let mut ix = env.buy_ix(&env.agent.pubkey(), &env.quoter.pubkey(), 0, 500_000_000, 40_000_000, exp);
    ix.accounts[1].is_signer = false;
    let agent = env.agent.insecure_clone();
    assert!(env.send(&[ix], &[&agent]).await.is_err());
    // A different key co-signs.
    let fake = Keypair::new();
    let ix = env.buy_ix(&env.agent.pubkey(), &fake.pubkey(), 0, 500_000_000, 40_000_000, exp);
    let e = env.send(&[ix], &[&agent, &fake]).await.unwrap_err();
    assert_eq!(code(e), Some(BAD_QUOTER));
}

#[tokio::test]
async fn hijacked_agent_cannot_drain_or_buy_after_revoke() {
    let mut env = Env::new(2_000_000_000, 300_000_000).await;
    let agent = env.agent.insecure_clone();
    // The agent poses as owner to withdraw the budget into its own token account.
    let ix = Instruction {
        program_id: awning::ID,
        accounts: awning::accounts::Withdraw {
            owner: agent.pubkey(),
            mandate: env.mandate,
            mandate_vault: env.mandate_vault,
            owner_token: env.agent_token,
            token_program: TOKEN,
        }
        .to_account_metas(None),
        data: awning::instruction::Withdraw { amount: 300_000_000 }.data(),
    };
    let e = env.send(&[ix], &[&agent]).await.unwrap_err();
    assert!(matches!(code(e), Some(ANCHOR_SEEDS) | Some(ANCHOR_HAS_ONE) | Some(6013)));
    let mv = env.mandate_vault;
    assert_eq!(env.balance(&mv).await, 300_000_000);

    // A stranger key cannot buy either.
    let stranger = Keypair::new();
    let fund = system_instruction::transfer(&env.payer.pubkey(), &stranger.pubkey(), 1_000_000_000);
    env.send(&[fund], &[]).await.unwrap();
    let exp = env.now().await + 86_400;
    let ix = env.buy_ix(&stranger.pubkey(), &env.quoter.pubkey(), 0, 500_000_000, 40_000_000, exp);
    let q = env.quoter.insecure_clone();
    let e = env.send(&[ix], &[&stranger, &q]).await.unwrap_err();
    assert_eq!(code(e), Some(NOT_AGENT));

    // Owner revokes; the agent's next buy is refused.
    let ix = Instruction {
        program_id: awning::ID,
        accounts: awning::accounts::OwnerOnly { owner: env.owner.pubkey(), mandate: env.mandate }.to_account_metas(None),
        data: awning::instruction::Revoke {}.data(),
    };
    let own = env.owner.insecure_clone();
    env.send(&[ix], &[&own]).await.unwrap();
    let e = env.buy(500_000_000, 40_000_000).await.unwrap_err();
    assert_eq!(code(e), Some(REVOKED));

    // Owner can still withdraw.
    let ix = Instruction {
        program_id: awning::ID,
        accounts: awning::accounts::Withdraw {
            owner: own.pubkey(),
            mandate: env.mandate,
            mandate_vault: env.mandate_vault,
            owner_token: env.owner_token,
            token_program: TOKEN,
        }
        .to_account_metas(None),
        data: awning::instruction::Withdraw { amount: 300_000_000 }.data(),
    };
    env.send(&[ix], &[&own]).await.unwrap();
    let ot = env.owner_token;
    assert_eq!(env.balance(&ot).await, 1_000_000_000);
}

#[tokio::test]
async fn pool_too_thin() {
    let mut env = Env::new(100_000_000, 300_000_000).await;
    // 100 + 40 premium < 500 payout.
    let e = env.buy(500_000_000, 40_000_000).await.unwrap_err();
    assert_eq!(code(e), Some(POOL_TOO_THIN));
}

#[tokio::test]
async fn settle_happened_pays_owner_and_unlocks() {
    let mut env = Env::new(2_000_000_000, 300_000_000).await;
    env.buy(500_000_000, 40_000_000).await.unwrap();
    let cover = env.cover_pda(0);
    let ix = env.settle_ix(&env.resolver.pubkey(), cover, true);
    let r = env.resolver.insecure_clone();
    env.send(&[ix], &[&r]).await.unwrap();
    let ot = env.owner_token;
    assert_eq!(env.balance(&ot).await, 700_000_000 + 500_000_000);
    let pool: Pool = env.read(&env.pool.clone()).await;
    assert_eq!(pool.locked, 0);
    assert_eq!(pool.open_covers, 0);
    let c: Cover = env.read(&cover).await;
    assert_eq!(c.state, 1);
    // Cannot settle twice.
    let ix = env.settle_ix(&env.resolver.pubkey(), cover, false);
    let e = env.send(&[ix], &[&r]).await.unwrap_err();
    assert_eq!(code(e), Some(NOT_OPEN));
}

#[tokio::test]
async fn settle_by_non_resolver_refused() {
    let mut env = Env::new(2_000_000_000, 300_000_000).await;
    env.buy(500_000_000, 40_000_000).await.unwrap();
    let cover = env.cover_pda(0);
    let fake = Keypair::new();
    let ix = env.settle_ix(&fake.pubkey(), cover, true);
    let e = env.send(&[ix], &[&fake]).await.unwrap_err();
    assert_eq!(code(e), Some(ANCHOR_HAS_ONE));
    let pool: Pool = env.read(&env.pool.clone()).await;
    assert_eq!(pool.locked, 500_000_000);
}

#[tokio::test]
async fn withdraw_pool_cannot_touch_locked() {
    let mut env = Env::new(1_000_000_000, 300_000_000).await;
    env.buy(500_000_000, 40_000_000).await.unwrap();
    // vault = 1040, locked = 500, free = 540
    let mk = |amount: u64, env: &Env| Instruction {
        program_id: awning::ID,
        accounts: awning::accounts::WithdrawPool {
            authority: env.authority.pubkey(),
            pool: env.pool,
            vault: env.vault,
            authority_token: env.authority_token,
            token_program: TOKEN,
        }
        .to_account_metas(None),
        data: awning::instruction::WithdrawPool { amount }.data(),
    };
    let auth = env.authority.insecure_clone();
    let ix = mk(540_000_001, &env);
    let e = env.send(&[ix], &[&auth]).await.unwrap_err();
    assert_eq!(code(e), Some(INSUFFICIENT_FREE));
    let ix = mk(540_000_000, &env);
    env.send(&[ix], &[&auth]).await.unwrap();
    let v = env.vault;
    assert_eq!(env.balance(&v).await, 500_000_000);
}
