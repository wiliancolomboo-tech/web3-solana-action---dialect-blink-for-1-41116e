use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("V1tB1inkDepositVault1111111111111111111111111");

pub const VAULT_SEED: &[u8] = b"vault_state";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token_account";
pub const SHARE_MINT_SEED: &[u8] = b"vault_share_mint";

#[program]
pub mod solana_vault_blink {
    use super::*;

    /// Initializes a new yield vault, creating its underlying vault token account and share mint.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        management_fee_bps: u16,
    ) -> Result<()> {
        require!(management_fee_bps <= 1000, VaultError::FeeExceedsLimit);

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.underlying_mint = ctx.accounts.underlying_mint.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.bump = ctx.bumps.vault;
        vault.token_bump = ctx.bumps.vault_token_account;
        vault.share_mint_bump = ctx.bumps.share_mint;
        vault.total_deposited = 0;
        vault.total_shares_minted = 0;
        vault.management_fee_bps = management_fee_bps;
        vault.is_locked = false;

        emit!(VaultInitializedEvent {
            vault: vault.key(),
            authority: vault.authority,
            underlying_mint: vault.underlying_mint,
            share_mint: vault.share_mint,
        });

        Ok(())
    }

    /// Deposits underlying SPL tokens into the vault and mints corresponding receipt share tokens to the user.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, min_shares_out: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(!vault.is_locked, VaultError::VaultIsLocked);
        require!(amount > 0, VaultError::ZeroDepositAmount);

        let vault_balance_before = ctx.accounts.vault_token_account.amount;
        let total_shares = ctx.accounts.share_mint.supply;

        // Calculate share allocation using safe math
        let shares_to_mint: u64 = if total_shares == 0 || vault_balance_before == 0 {
            // Initial 1:1 conversion ratio
            amount
        } else {
            (amount as u128)
                .checked_mul(total_shares as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(vault_balance_before as u128)
                .ok_or(VaultError::MathOverflow)? as u64
        };

        require!(shares_to_mint >= min_shares_out, VaultError::SlippageExceeded);

        // 1. Transfer underlying tokens from user to vault PDA token account
        let transfer_cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let transfer_cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_cpi_accounts,
        );
        token::transfer(transfer_cpi_ctx, amount)?;

        // 2. Mint receipt share tokens to user ATA via Vault authority seeds
        let vault_key = ctx.accounts.vault.key();
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            ctx.accounts.underlying_mint.to_account_info().key.as_ref(),
            &[ctx.accounts.vault.bump],
        ]];

        let mint_to_cpi_accounts = MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.user_share_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let mint_to_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            mint_to_cpi_accounts,
            seeds,
        );
        token::mint_to(mint_to_cpi_ctx, shares_to_mint)?;

        // Update internal accounting ledger
        let vault_state = &mut ctx.accounts.vault;
        vault_state.total_deposited = vault_state
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        vault_state.total_shares_minted = vault_state
            .total_shares_minted
            .checked_add(shares_to_mint)
            .ok_or(VaultError::MathOverflow)?;

        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            vault: vault_key,
            amount_deposited: amount,
            shares_minted: shares_to_mint,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------
// Account Context Structs
// ---------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub underlying_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, underlying_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = authority,
        token::mint = underlying_mint,
        token::authority = vault,
        seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        mint::decimals = underlying_mint.decimals,
        mint::authority = vault,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump
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
        seeds = [VAULT_SEED, underlying_mint.key().as_ref()],
        bump = vault.bump,
        has_one = underlying_mint,
        has_one = vault_token_account,
        has_one = share_mint
    )]
    pub vault: Account<'info, Vault>,

    pub underlying_mint: Account<'info, Mint>,

    #[account(
        mut,
        address = vault.vault_token_account
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = vault.share_mint
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == underlying_mint.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_share_account.owner == user.key(),
        constraint = user_share_account.mint == share_mint.key()
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------
// Data State Accounts & Errors
// ---------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    pub underlying_mint: Pubkey,
    pub share_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub total_deposited: u64,
    pub total_shares_minted: u64,
    pub bump: u8,
    pub token_bump: u8,
    pub share_mint_bump: u8,
    pub management_fee_bps: u16,
    pub is_locked: bool,
}

#[error_code]
pub enum VaultError {
    #[msg("Management fee exceeds maximum allowed threshold of 1000 bps (10%)")]
    FeeExceedsLimit,
    #[msg("Vault is currently locked by the security guardian")]
    VaultIsLocked,
    #[msg("Deposit amount must be strictly greater than zero")]
    ZeroDepositAmount,
    #[msg("Math arithmetic overflow occurred")]
    MathOverflow,
    #[msg("Slippage tolerance exceeded during share allocation")]
    SlippageExceeded,
}

#[event]
pub struct VaultInitializedEvent {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub underlying_mint: Pubkey,
    pub share_mint: Pubkey,
}

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub amount_deposited: u64,
    pub shares_minted: u64,
    pub timestamp: i64,
}