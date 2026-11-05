use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("Vau1tCorg1111111111111111111111111111111111");

pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_tokens";
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";
pub const MINIMUM_INITIAL_DEPOSIT: u64 = 1_000; // Protection against zero-share inflation

#[program]
pub mod vault_core {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        deposit_bump: u8,
        share_bump: u8,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.underlying_mint = ctx.accounts.underlying_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.total_deposited = 0;
        vault.total_shares = 0;
        vault.paused = false;
        vault.bump = ctx.bumps.vault;
        vault.deposit_bump = deposit_bump;
        vault.share_bump = share_bump;

        msg!("Vault initialized successfully for mint: {}", vault.underlying_mint);
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
        require!(amount > 0, VaultError::ZeroDepositAmount);

        let vault = &ctx.accounts.vault;
        let total_assets = ctx.accounts.vault_token_account.amount;
        let total_shares = ctx.accounts.share_mint.supply;

        let shares_to_mint = if total_shares == 0 || total_assets == 0 {
            require!(
                amount >= MINIMUM_INITIAL_DEPOSIT,
                VaultError::DepositTooSmall
            );
            amount
        } else {
            // High-precision share math: shares = (amount * total_shares) / total_assets
            (amount as u128)
                .checked_mul(total_shares as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(total_assets as u128)
                .ok_or(VaultError::MathOverflow)? as u64
        };

        require!(shares_to_mint > 0, VaultError::ZeroShareIssuance);

        // 1. Transfer underlying tokens from user to vault PDA
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user_authority.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        // 2. Mint share receipt tokens to the user
        let underlying_mint_key = vault.underlying_mint;
        let seeds = &[
            VAULT_SEED,
            underlying_mint_key.as_ref(),
            &[vault.bump],
        ];
        let signer = &[&seeds[..]];

        let mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer,
        );
        token::mint_to(mint_ctx, shares_to_mint)?;

        // 3. Update internal accounting state
        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.total_deposited = vault_mut
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        vault_mut.total_shares = vault_mut
            .total_shares
            .checked_add(shares_to_mint)
            .ok_or(VaultError::MathOverflow)?;

        emit!(DepositEvent {
            user: ctx.accounts.user_authority.key(),
            amount,
            shares_minted: shares_to_mint,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminControl>, paused: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.paused = paused;
        emit!(PauseStateChanged { paused });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub underlying_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, underlying_mint.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = vault
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = underlying_mint.decimals,
        mint::authority = vault
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.underlying_mint.as_ref()],
        bump = vault.bump,
        has_one = vault_token_account,
        has_one = share_mint
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = user_token_account.mint == vault.underlying_mint @ VaultError::InvalidMint,
        constraint = user_token_account.owner == user_authority.key() @ VaultError::InvalidOwner
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_share_account.mint == vault.share_mint @ VaultError::InvalidMint,
        constraint = user_share_account.owner == user_authority.key() @ VaultError::InvalidOwner
    )]
    pub user_share_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminControl<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized
    )]
    pub vault: Box<Account<'info, Vault>>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    pub underlying_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub share_mint: Pubkey,
    pub total_deposited: u64,
    pub total_shares: u64,
    pub paused: bool,
    pub bump: u8,
    pub deposit_bump: u8,
    pub share_bump: u8,
}

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
    pub timestamp: i64,
}

#[event]
pub struct PauseStateChanged {
    pub paused: bool,
}

#[error_code]
pub enum VaultError {
    #[msg("Vault is currently paused by admin.")]
    VaultPaused,
    #[msg("Deposit amount must be greater than zero.")]
    ZeroDepositAmount,
    #[msg("Initial deposit does not meet anti-inflation minimum.")]
    DepositTooSmall,
    #[msg("Share calculation evaluated to zero.")]
    ZeroShareIssuance,
    #[msg("Numerical overflow during arithmetic calculation.")]
    MathOverflow,
    #[msg("Token account mint mismatch.")]
    InvalidMint,
    #[msg("Token account owner mismatch.")]
    InvalidOwner,
    #[msg("Signer is not authorized to execute this command.")]
    Unauthorized,
}