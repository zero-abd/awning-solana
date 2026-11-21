use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GCiXjWdKPbLSq7NLpDkjyVmiLcx9tmYG3oHNTS5Ese12");

pub const MAX_MARKET_LEN: usize = 48;
pub const SECONDS_PER_DAY: i64 = 86_400;

pub const COVER_OPEN: u8 = 0;
pub const COVER_PAID_OUT: u8 = 1;
pub const COVER_EXPIRED: u8 = 2;

#[program]
pub mod awning {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>, quoter: Pubkey, resolver: Pubkey) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.quoter = quoter;
        pool.resolver = resolver;
        pool.usdc_mint = ctx.accounts.usdc_mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.locked = 0;
        pool.premiums = 0;
        pool.open_covers = 0;
        pool.bump = ctx.bumps.pool;
        pool.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn fund_pool(ctx: Context<FundPool>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.funder_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn withdraw_pool(ctx: Context<WithdrawPool>, amount: u64) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let free = ctx
            .accounts
            .vault
            .amount
            .checked_sub(pool.locked)
            .ok_or(AwningError::InsufficientFree)?;
        require!(amount <= free, AwningError::InsufficientFree);
        let authority_key = pool.authority;
        let bump = [pool.bump];
        let seeds: &[&[u8]] = &[b"pool", authority_key.as_ref(), &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.authority_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    pub fn open_mandate(ctx: Context<OpenMandate>, agent: Pubkey, limits: Limits) -> Result<()> {
        let m = &mut ctx.accounts.mandate;
        m.owner = ctx.accounts.owner.key();
        m.agent = agent;
        m.pool = ctx.accounts.pool.key();
        m.vault = ctx.accounts.mandate_vault.key();
        m.limits = limits;
        m.day = Clock::get()?.unix_timestamp / SECONDS_PER_DAY;
        m.spent_today = 0;
        m.total_spent = 0;
        m.covers = 0;
        m.revoked = false;
        m.bump = ctx.bumps.mandate;
        m.vault_bump = ctx.bumps.mandate_vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_token.to_account_info(),
                    to: ctx.accounts.mandate_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let m = &ctx.accounts.mandate;
        let pool_key = m.pool;
        let owner_key = m.owner;
        let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"mandate", pool_key.as_ref(), owner_key.as_ref(), &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.mandate_vault.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.mandate.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    pub fn set_limits(ctx: Context<OwnerOnly>, limits: Limits) -> Result<()> {
        ctx.accounts.mandate.limits = limits;
        Ok(())
    }

    pub fn set_agent(ctx: Context<OwnerOnly>, agent: Pubkey) -> Result<()> {
        let m = &mut ctx.accounts.mandate;
        m.agent = agent;
        m.revoked = false;
        Ok(())
    }

    pub fn revoke(ctx: Context<OwnerOnly>) -> Result<()> {
        ctx.accounts.mandate.revoked = true;
        Ok(())
    }

    pub fn buy_cover(
        ctx: Context<BuyCover>,
        market: String,
        payout: u64,
        premium: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(market.len() <= MAX_MARKET_LEN, AwningError::MarketTooLong);
        let now = Clock::get()?.unix_timestamp;
        {
            let m = &ctx.accounts.mandate;
            require!(!m.revoked, AwningError::Revoked);
            require!(premium > 0 && premium < payout, AwningError::BadPrice);
            require!(premium <= m.limits.max_premium_per_cover, AwningError::OverCoverLimit);
            require!(payout <= m.limits.max_payout_per_cover, AwningError::OverPayoutLimit);
            require!(expires_at > now, AwningError::Expired);
        }

        let pool_vault_amount = ctx.accounts.pool_vault.amount;
        let pool_locked = ctx.accounts.pool.locked;

        // Roll the day and enforce the daily budget.
        let today = now / SECONDS_PER_DAY;
        let m = &mut ctx.accounts.mandate;
        if m.day != today {
            m.day = today;
            m.spent_today = 0;
        }
        let spent = m.spent_today.checked_add(premium).ok_or(AwningError::MathOverflow)?;
        require!(spent <= m.limits.max_premium_per_day, AwningError::OverDailyLimit);

        // Pool must be able to lock the payout (premium arrives first).
        let capacity = pool_vault_amount.checked_add(premium).ok_or(AwningError::MathOverflow)?;
        let free = capacity.checked_sub(pool_locked).ok_or(AwningError::PoolTooThin)?;
        require!(free >= payout, AwningError::PoolTooThin);

        let cover_id = m.covers;
        m.spent_today = spent;
        m.total_spent = m.total_spent.checked_add(premium).ok_or(AwningError::MathOverflow)?;
        m.covers = m.covers.checked_add(1).ok_or(AwningError::MathOverflow)?;
        let owner = m.owner;
        let pool_key = m.pool;
        let bump = [m.bump];

        let seeds: &[&[u8]] = &[b"mandate", pool_key.as_ref(), owner.as_ref(), &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.mandate_vault.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.mandate.to_account_info(),
                },
                &[seeds],
            ),
            premium,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.locked = pool.locked.checked_add(payout).ok_or(AwningError::MathOverflow)?;
        pool.premiums = pool.premiums.checked_add(premium).ok_or(AwningError::MathOverflow)?;
        pool.open_covers = pool.open_covers.checked_add(1).ok_or(AwningError::MathOverflow)?;

        let mandate_key = ctx.accounts.mandate.key();
        let cover_key = ctx.accounts.cover.key();
        let cover = &mut ctx.accounts.cover;
        cover.mandate = mandate_key;
        cover.owner = owner;
        cover.market = market.clone();
        cover.payout = payout;
        cover.premium = premium;
        cover.expires_at = expires_at;
        cover.state = COVER_OPEN;
        cover.bump = ctx.bumps.cover;

        emit!(CoverBought {
            mandate: mandate_key,
            cover: cover_key,
            cover_id,
            owner,
            market,
            payout,
            premium,
            expires_at,
        });
        Ok(())
    }

    pub fn settle_cover(ctx: Context<SettleCover>, happened: bool) -> Result<()> {
        require!(ctx.accounts.cover.state == COVER_OPEN, AwningError::NotOpen);
        let payout = ctx.accounts.cover.payout;

        if happened {
            let authority_key = ctx.accounts.pool.authority;
            let bump = [ctx.accounts.pool.bump];
            let seeds: &[&[u8]] = &[b"pool", authority_key.as_ref(), &bump];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_vault.to_account_info(),
                        to: ctx.accounts.owner_token.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                payout,
            )?;
        }

        let pool = &mut ctx.accounts.pool;
        pool.locked = pool.locked.checked_sub(payout).ok_or(AwningError::MathOverflow)?;
        pool.open_covers = pool.open_covers.checked_sub(1).ok_or(AwningError::MathOverflow)?;

        let cover_key = ctx.accounts.cover.key();
        let cover = &mut ctx.accounts.cover;
        cover.state = if happened { COVER_PAID_OUT } else { COVER_EXPIRED };

        emit!(CoverSettled {
            cover: cover_key,
            mandate: cover.mandate,
            owner: cover.owner,
            happened,
            payout: if happened { payout } else { 0 },
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", authority.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPool<'info> {
    pub funder: Signer<'info>,
    #[account(
        seeds = [b"pool", pool.authority.as_ref()],
        bump = pool.bump,
        has_one = vault @ AwningError::WrongPool
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = pool.usdc_mint,
        token::authority = funder
    )]
    pub funder_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawPool<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"pool", authority.key().as_ref()],
        bump = pool.bump,
        has_one = authority,
        has_one = vault @ AwningError::WrongPool
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = pool.usdc_mint,
        constraint = authority_token.key() != vault.key() @ AwningError::WrongOwner
    )]
    pub authority_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OpenMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"pool", pool.authority.as_ref()],
        bump = pool.bump,
        has_one = usdc_mint @ AwningError::WrongPool
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [b"mandate", pool.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub mandate: Account<'info, Mandate>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        seeds = [b"mandate_vault", mandate.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = mandate
    )]
    pub mandate_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"mandate", mandate.pool.as_ref(), owner.key().as_ref()],
        bump = mandate.bump,
        has_one = owner @ AwningError::WrongOwner
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        mut,
        seeds = [b"mandate_vault", mandate.key().as_ref()],
        bump = mandate.vault_bump,
        constraint = mandate_vault.key() == mandate.vault @ AwningError::WrongOwner
    )]
    pub mandate_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mandate_vault.mint,
        token::authority = owner
    )]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"mandate", mandate.pool.as_ref(), owner.key().as_ref()],
        bump = mandate.bump,
        has_one = owner @ AwningError::WrongOwner
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        mut,
        seeds = [b"mandate_vault", mandate.key().as_ref()],
        bump = mandate.vault_bump,
        constraint = mandate_vault.key() == mandate.vault @ AwningError::WrongOwner
    )]
    pub mandate_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mandate_vault.mint,
        token::authority = owner
    )]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"mandate", mandate.pool.as_ref(), owner.key().as_ref()],
        bump = mandate.bump,
        has_one = owner @ AwningError::WrongOwner
    )]
    pub mandate: Account<'info, Mandate>,
}

#[derive(Accounts)]
pub struct BuyCover<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    pub quoter: Signer<'info>,
    #[account(
        mut,
        seeds = [b"pool", pool.authority.as_ref()],
        bump = pool.bump,
        constraint = pool.quoter == quoter.key() @ AwningError::BadQuoter,
        constraint = pool.vault == pool_vault.key() @ AwningError::WrongPool
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.vault_bump
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"mandate", pool.key().as_ref(), mandate.owner.as_ref()],
        bump = mandate.bump,
        constraint = mandate.agent == agent.key() @ AwningError::NotAgent,
        constraint = mandate.pool == pool.key() @ AwningError::WrongPool
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        mut,
        seeds = [b"mandate_vault", mandate.key().as_ref()],
        bump = mandate.vault_bump,
        constraint = mandate_vault.key() == mandate.vault @ AwningError::WrongOwner
    )]
    pub mandate_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = agent,
        space = 8 + Cover::INIT_SPACE,
        seeds = [b"cover", mandate.key().as_ref(), &mandate.covers.to_le_bytes()],
        bump
    )]
    pub cover: Account<'info, Cover>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleCover<'info> {
    pub resolver: Signer<'info>,
    #[account(
        mut,
        seeds = [b"pool", pool.authority.as_ref()],
        bump = pool.bump,
        has_one = resolver,
        constraint = pool.vault == pool_vault.key() @ AwningError::WrongPool
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.vault_bump
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = cover.state == COVER_OPEN @ AwningError::NotOpen
    )]
    pub cover: Account<'info, Cover>,
    #[account(
        mut,
        token::mint = pool.usdc_mint,
        token::authority = cover.owner
    )]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------- state

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Limits {
    pub max_premium_per_cover: u64,
    pub max_premium_per_day: u64,
    pub max_payout_per_cover: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub quoter: Pubkey,
    pub resolver: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub locked: u64,
    pub premiums: u64,
    pub open_covers: u32,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub pool: Pubkey,
    pub vault: Pubkey,
    pub limits: Limits,
    pub day: i64,
    pub spent_today: u64,
    pub total_spent: u64,
    pub covers: u64,
    pub revoked: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Cover {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    #[max_len(48)]
    pub market: String,
    pub payout: u64,
    pub premium: u64,
    pub expires_at: i64,
    pub state: u8,
    pub bump: u8,
}

// ---------------------------------------------------------------- events

#[event]
pub struct CoverBought {
    pub mandate: Pubkey,
    pub cover: Pubkey,
    pub cover_id: u64,
    pub owner: Pubkey,
    pub market: String,
    pub payout: u64,
    pub premium: u64,
    pub expires_at: i64,
}

#[event]
pub struct CoverSettled {
    pub cover: Pubkey,
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub happened: bool,
    pub payout: u64,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum AwningError {
    #[msg("Signer is not the mandate's agent")]
    NotAgent,
    #[msg("Mandate is revoked")]
    Revoked,
    #[msg("Quoter does not match the pool's quoter")]
    BadQuoter,
    #[msg("Premium must be > 0 and < payout")]
    BadPrice,
    #[msg("Premium exceeds the per-cover limit")]
    OverCoverLimit,
    #[msg("Payout exceeds the per-cover payout limit")]
    OverPayoutLimit,
    #[msg("Premium exceeds the daily limit")]
    OverDailyLimit,
    #[msg("Cover expiry is in the past")]
    Expired,
    #[msg("Pool cannot lock this payout")]
    PoolTooThin,
    #[msg("Cover is not open")]
    NotOpen,
    #[msg("Amount exceeds free pool liquidity")]
    InsufficientFree,
    #[msg("Market id longer than 48 bytes")]
    MarketTooLong,
    #[msg("Account belongs to a different pool")]
    WrongPool,
    #[msg("Account belongs to a different owner")]
    WrongOwner,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
