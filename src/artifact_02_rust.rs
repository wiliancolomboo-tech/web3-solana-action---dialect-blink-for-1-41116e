use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("Vau1tXN8YwK2qM4aM5rXgP6dE7T9uV1wY2z3A4b5C6d");

#[program]
pub mod solana_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        vault_seed: u64,
        deposit_cap: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.vault_bump = ctx.bumps.vault;
        vault.token_vault_bump = ctx.bumps.token_vault;
        vault.share_mint_bump = ctx.bumps.share_mint;
        vault.vault_seed = vault_seed;
        vault.deposit_cap = deposit_cap;
        vault.total_deposited = 0;
        vault.is_paused = false;

        emit!(VaultInitializedEvent {
            vault: vault.key(),
            authority: vault.authority,
            deposit_cap,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64, min_shares_out: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroDepositAmount);
        let vault = &mut ctx.accounts.vault;
        require!(!vault.is_paused, VaultError::VaultPaused);

        let current_vault_balance = ctx.accounts.token_vault.amount;
        let total_shares = ctx.accounts.share_mint.supply;

        // Invariant check: Deposit cap
        let projected_balance = vault
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        require!(
            projected_balance <= vault.deposit_cap,
            VaultError::DepositCapExceeded
        );

        // Share Calculation:
        // If first deposit, shares = amount (1:1 parity)
        // Else: shares = (amount * total_shares) / current_vault_balance
        let shares_to_mint = if total_shares == 0 || current_vault_balance == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(total_shares as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(current_vault_balance as u128)
                .ok_or(VaultError::MathOverflow)? as u64
        };

        require!(
            shares_to_mint >= min_shares_out,
            VaultError::SlippageExceeded
        );

        // 1. Transfer user token to vault token account
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        // 2. Mint vault LP shares to user
        let vault_seed_bytes = vault.vault_seed.to_le_bytes();
        let seeds = &[
            b"vault".as_ref(),
            vault_seed_bytes.as_ref(),
            &[vault.vault_bump],
        ];
        let signer = &[&seeds[..]];

        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer,
        );
        token::mint_to(mint_to_ctx, shares_to_mint)?;

        // Update state
        vault.total_deposited = vault
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            amount_deposited: amount,
            shares_minted: shares_to_mint,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(vault_seed: u64)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", vault_seed.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub underlying_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"token_vault", vault.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = vault
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [b"share_mint", vault.key().as_ref()],
        bump,
        mint::decimals = underlying_mint.decimals,
        mint::authority = vault
    )]
    pub share_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault.vault_seed.to_le_bytes().as_ref()],
        bump = vault.vault_bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"token_vault", vault.key().as_ref()],
        bump = vault.token_vault_bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"share_mint", vault.key().as_ref()],
        bump = vault.share_mint_bump
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token.owner == user.key() @ VaultError::InvalidTokenOwner,
        constraint = user_token.mint == token_vault.mint @ VaultError::InvalidTokenMint
    )]
    pub user_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_share_account.owner == user.key() @ VaultError::InvalidTokenOwner,
        constraint = user_share_account.mint == share_mint.key() @ VaultError::InvalidTokenMint
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,       // 32
    pub vault_seed: u64,         // 8
    pub deposit_cap: u64,        // 8
    pub total_deposited: u64,    // 8
    pub vault_bump: u8,          // 1
    pub token_vault_bump: u8,    // 1
    pub share_mint_bump: u8,     // 1
    pub is_paused: bool,         // 1
}

#[event]
pub struct VaultInitializedEvent {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub deposit_cap: u64,
    pub timestamp: i64,
}

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub amount_deposited: u64,
    pub shares_minted: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum VaultError {
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDepositAmount,
    #[msg("Vault is currently paused by authority.")]
    VaultPaused,
    #[msg("Deposit exceeds global vault capacity.")]
    DepositCapExceeded,
    #[msg("Slippage limit violated: returned shares less than minimum requested.")]
    SlippageExceeded,
    #[msg("Math arithmetic overflow occurred.")]
    MathOverflow,
    #[msg("Provided token account does not belong to signer.")]
    InvalidTokenOwner,
    #[msg("Provided token account does not match vault mint requirement.")]
    InvalidTokenMint,
}