use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("V1kDep0s1t111111111111111111111111111111111");

pub const VAULT_SEED: &[u8] = b"vault_state";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_tokens";
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";
pub const VIRTUAL_OFFSET: u128 = 1_000; // Mitigates ERC-4626 style inflation attacks

#[program]
pub mod vault_blink {
    use super::*;

    /// Initializes the global vault and receipt share mint.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.deposit_mint = ctx.accounts.deposit_mint.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.total_staked = 0;
        vault.vault_bump = ctx.bumps.vault;
        vault.token_bump = ctx.bumps.vault_token_account;
        vault.share_bump = ctx.bumps.share_mint;

        emit!(VaultInitializedEvent {
            authority: vault.authority,
            deposit_mint: vault.deposit_mint,
            share_mint: vault.share_mint,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposits base tokens into the vault and mints yield shares to the user.
    pub fn deposit_and_stake(
        ctx: Context<DepositAndStake>,
        amount_in: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        require!(amount_in > 0, VaultError::InvalidDepositAmount);

        let vault = &ctx.accounts.vault;
        let deposit_mint_key = vault.deposit_mint;
        let vault_bump = vault.vault_bump;

        // Calculate current virtual reserves
        let current_tokens = ctx.accounts.vault_token_account.amount;
        let current_shares = ctx.accounts.share_mint.supply;

        // ERC-4626 virtual shares conversion:
        // shares_to_mint = amount_in * (total_shares + VIRTUAL_OFFSET) / (total_tokens + 1)
        let shares_to_mint_u128 = (amount_in as u128)
            .checked_mul((current_shares as u128).checked_add(VIRTUAL_OFFSET).ok_or(VaultError::MathOverflow)?)
            .ok_or(VaultError::MathOverflow)?
            .checked_div((current_tokens as u128).checked_add(1).ok_or(VaultError::MathOverflow)?)
            .ok_or(VaultError::MathOverflow)?;

        let shares_to_mint = u64::try_from(shares_to_mint_u128)
            .map_err(|_| VaultError::ConversionOverflow)?;

        require!(
            shares_to_mint >= min_shares_out,
            VaultError::SlippageToleranceExceeded
        );

        // 1. CPI: Transfer user tokens to Vault Token PDA Account
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount_in)?;

        // 2. CPI: Mint shares to user receipt ATA using Vault PDA signer seeds
        let authority_seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            deposit_mint_key.as_ref(),
            &[vault_bump],
        ]];

        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            authority_seeds,
        );
        token::mint_to(mint_to_ctx, shares_to_mint)?;

        // 3. Mutate Vault State
        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.total_staked = vault_mut
            .total_staked
            .checked_add(amount_in)
            .ok_or(VaultError::MathOverflow)?;

        emit!(DepositStakedEvent {
            user: ctx.accounts.user.key(),
            amount_deposited: amount_in,
            shares_minted: shares_to_mint,
            total_vault_tokens: ctx.accounts.vault_token_account.amount + amount_in,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub deposit_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [VAULT_SEED, deposit_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultState>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()],
        bump,
        token::mint = deposit_mint,
        token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = deposit_mint.decimals,
        mint::authority = vault,
    )]
    pub share_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositAndStake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub deposit_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, deposit_mint.key().as_ref()],
        bump = vault.vault_bump,
        has_one = deposit_mint @ VaultError::DepositMintMismatch,
        has_one = share_mint @ VaultError::ShareMintMismatch,
    )]
    pub vault: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()],
        bump = vault.token_bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump = vault.share_bump,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ VaultError::InvalidTokenAccountOwner,
        constraint = user_token_account.mint == deposit_mint.key() @ VaultError::DepositMintMismatch,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_share_account.owner == user.key() @ VaultError::InvalidTokenAccountOwner,
        constraint = user_share_account.mint == share_mint.key() @ VaultError::ShareMintMismatch,
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE
// -----------------------------------------------------------------------------

#[account]
pub struct VaultState {
    pub authority: Pubkey,     // 32
    pub deposit_mint: Pubkey,  // 32
    pub share_mint: Pubkey,    // 32
    pub total_staked: u64,     // 8
    pub vault_bump: u8,        // 1
    pub token_bump: u8,        // 1
    pub share_bump: u8,        // 1
}

impl VaultState {
    pub const INIT_SPACE: usize = 32 + 32 + 32 + 8 + 1 + 1 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct VaultInitializedEvent {
    pub authority: Pubkey,
    pub deposit_mint: Pubkey,
    pub share_mint: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct DepositStakedEvent {
    pub user: Pubkey,
    pub amount_deposited: u64,
    pub shares_minted: u64,
    pub total_vault_tokens: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum VaultError {
    #[msg("Deposit amount must be strictly greater than zero.")]
    InvalidDepositAmount,
    #[msg("Calculation resulted in integer overflow/underflow.")]
    MathOverflow,
    #[msg("Share calculation exceeds u64 boundary.")]
    ConversionOverflow,
    #[msg("Slippage limit reached. Received fewer shares than minimum acceptable threshold.")]
    SlippageToleranceExceeded,
    #[msg("Target deposit mint does not match vault configuration.")]
    DepositMintMismatch,
    #[msg("Receipt share mint does not match vault configuration.")]
    ShareMintMismatch,
    #[msg("Associated token account is not owned by the signing user.")]
    InvalidTokenAccountOwner,
}