use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("Vau1tB1ink111111111111111111111111111111111");

pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";

#[program]
pub mod yield_vault {
    use super::*;

    /// Initializes a new yield vault for a specific base token mint (e.g., USDC or WSOL).
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.admin = ctx.accounts.admin.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.token_reserve = ctx.accounts.token_reserve.key();
        vault.bump = ctx.bumps.vault;
        vault.vault_auth_bump = ctx.bumps.vault_authority;
        vault.total_deposited = 0;
        vault.is_paused = false;

        emit!(VaultInitializedEvent {
            admin: vault.admin,
            token_mint: vault.token_mint,
            share_mint: vault.share_mint,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposits base tokens into the vault and mints yield-bearing LP shares.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.vault.is_paused, VaultError::VaultPaused);
        require!(amount > 0, VaultError::ZeroDepositAmount);

        let vault = &ctx.accounts.vault;
        let total_vault_tokens = ctx.accounts.token_reserve.amount;
        let total_share_supply = ctx.accounts.share_mint.supply;

        // Calculate share allocation:
        // If initial deposit: 1 token = 1 share
        // Subsequent deposits: shares = (deposit_amount * total_shares) / total_vault_tokens
        let shares_to_mint = if total_share_supply == 0 || total_vault_tokens == 0 {
            amount
        } else {
            amount
                .checked_mul(total_share_supply)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(total_vault_tokens)
                .ok_or(VaultError::MathOverflow)?
        };

        require!(shares_to_mint > 0, VaultError::ZeroShareAllocation);

        // Transfer base tokens from depositor to the vault reserve
        let transfer_cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.token_reserve.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, transfer_cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Mint LP shares directly to user
        let seeds = &[
            VAULT_AUTH_SEED,
            &[vault.vault_auth_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let mint_to_accounts = MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.user_share_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let mint_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            mint_to_accounts,
            signer_seeds,
        );
        token::mint_to(mint_cpi_ctx, shares_to_mint)?;

        // Update state
        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.total_deposited = vault_mut
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            token_amount: amount,
            shares_minted: shares_to_mint,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Toggles emergency pause state. Admin only.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.is_paused = paused;
        emit!(VaultPauseStateChanged { paused, timestamp: Clock::get()?.unix_timestamp });
        Ok(())
    }
}

// ============================================================================
// Account Structs
// ============================================================================

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        seeds = [SHARE_MINT_SEED, token_mint.key().as_ref()],
        bump,
        payer = admin,
        mint::decimals = token_mint.decimals,
        mint::authority = vault_authority,
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    /// CHECK: PDA signer authority for token minting and asset holding
    #[account(
        seeds = [VAULT_AUTH_SEED],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        seeds = [VAULT_SEED, token_mint.key().as_ref()],
        bump,
        payer = admin,
        space = 8 + Vault::INIT_SPACE,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = token_mint,
        associated_token::authority = vault_authority,
    )]
    pub token_reserve: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.token_mint.as_ref()],
        bump = vault.bump,
        has_one = token_reserve,
        has_one = share_mint,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: PDA signer authority
    #[account(
        seeds = [VAULT_AUTH_SEED],
        bump = vault.vault_auth_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = user_token_account.mint == vault.token_mint,
        constraint = user_token_account.owner == user.key(),
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = share_mint,
        associated_token::authority = user,
    )]
    pub user_share_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = token_reserve.key() == vault.token_reserve,
    )]
    pub token_reserve: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
}

// ============================================================================
// State Definition
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub admin: Pubkey,          // 32
    pub token_mint: Pubkey,     // 32
    pub share_mint: Pubkey,     // 32
    pub token_reserve: Pubkey,  // 32
    pub bump: u8,               // 1
    pub vault_auth_bump: u8,    // 1
    pub total_deposited: u64,   // 8
    pub is_paused: bool,        // 1
}

// ============================================================================
// Events and Errors
// ============================================================================

#[event]
pub struct VaultInitializedEvent {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub share_mint: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub token_amount: u64,
    pub shares_minted: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultPauseStateChanged {
    pub paused: bool,
    pub timestamp: i64,
}

#[error_code]
pub enum VaultError {
    #[msg("Vault operations are currently paused.")]
    VaultPaused,
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDepositAmount,
    #[msg("Share allocation resulted in 0 shares.")]
    ZeroShareAllocation,
    #[msg("Arithmetic overflow occurred during conversion.")]
    MathOverflow,
    #[msg("Signer is not authorized to perform this operation.")]
    Unauthorized,
}