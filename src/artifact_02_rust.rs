use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("VBL1NK1111111111111111111111111111111111111");

#[program]
pub mod vault_blink {
    use super::*;

    /// Initializes a new yield vault with a deterministic PDA authority.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        vault_id: u64,
        bump: u8,
        lp_bump: u8,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.vault_id = vault_id;
        vault.asset_mint = ctx.accounts.asset_mint.key();
        vault.lp_mint = ctx.accounts.lp_mint.key();
        vault.token_vault = ctx.accounts.token_vault.key();
        vault.total_deposited = 0;
        vault.total_shares = 0;
        vault.bump = bump;
        vault.lp_bump = lp_bump;
        vault.is_paused = false;
        Ok(())
    }

    /// Performs atomic swap-and-deposit or direct asset deposit into the vault,
    /// calculating shares via constant asset pricing and minting LP tokens to user.
    pub fn deposit(
        ctx: Context<Deposit>,
        asset_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.is_paused, VaultError::VaultPaused);
        require!(asset_amount > 0, VaultError::ZeroDepositAmount);

        // 1. Calculate LP Shares to mint using standard pool accounting
        //    shares = (deposit_amount * total_shares) / total_deposited
        //    Initial bootstrap condition: 1:1 ratio.
        let shares_to_mint: u64 = if vault.total_shares == 0 || vault.total_deposited == 0 {
            asset_amount
        } else {
            (asset_amount as u128)
                .checked_mul(vault.total_shares as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(vault.total_deposited as u128)
                .ok_or(VaultError::MathOverflow)? as u64
        };

        require!(shares_to_mint >= min_shares_out, VaultError::SlippageExceeded);

        // 2. CPI: Transfer tokens from user to vault reserve
        let transfer_cpi_accounts = Transfer {
            from: ctx.accounts.user_asset_ata.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_cpi_accounts,
        );
        token::transfer(cpi_ctx, asset_amount)?;

        // 3. CPI: Mint LP tokens to user via Vault PDA signature
        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds = &[
            b"vault".as_ref(),
            vault_id_bytes.as_ref(),
            &[vault.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let mint_to_cpi_accounts = MintTo {
            mint: ctx.accounts.lp_mint.to_account_info(),
            to: ctx.accounts.user_lp_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let mint_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            mint_to_cpi_accounts,
            signer_seeds,
        );
        token::mint_to(mint_cpi_ctx, shares_to_mint)?;

        // 4. Update Internal Ledger
        vault.total_deposited = vault
            .total_deposited
            .checked_add(asset_amount)
            .ok_or(VaultError::MathOverflow)?;
        vault.total_shares = vault
            .total_shares
            .checked_add(shares_to_mint)
            .ok_or(VaultError::MathOverflow)?;

        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            asset_amount,
            shares_minted: shares_to_mint,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Validation Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault", vault_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultState>,

    pub asset_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        mint::decimals = asset_mint.decimals,
        mint::authority = vault,
        seeds = [b"lp_mint", vault.key().as_ref()],
        bump
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = asset_mint,
        token::authority = vault,
        seeds = [b"token_vault", vault.key().as_ref()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

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
        seeds = [b"vault", vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        has_one = token_vault @ VaultError::InvalidTokenVault,
        has_one = lp_mint @ VaultError::InvalidLpMint,
        has_one = asset_mint @ VaultError::InvalidAssetMint,
    )]
    pub vault: Account<'info, VaultState>,

    pub asset_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lp_mint", vault.key().as_ref()],
        bump = vault.lp_bump
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"token_vault", vault.key().as_ref()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_asset_ata.mint == asset_mint.key() @ VaultError::InvalidUserAta,
        constraint = user_asset_ata.owner == user.key() @ VaultError::UnauthorizedOwner
    )]
    pub user_asset_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = lp_mint,
        associated_token::authority = user
    )]
    pub user_lp_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// State & Events
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub authority: Pubkey,       // 32
    pub vault_id: u64,           // 8
    pub asset_mint: Pubkey,      // 32
    pub lp_mint: Pubkey,         // 32
    pub token_vault: Pubkey,     // 32
    pub total_deposited: u64,    // 8
    pub total_shares: u64,       // 8
    pub bump: u8,                // 1
    pub lp_bump: u8,             // 1
    pub is_paused: bool,         // 1
}

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub asset_amount: u64,
    pub shares_minted: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum VaultError {
    #[msg("Calculation overflowed standard bounds.")]
    MathOverflow,
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDepositAmount,
    #[msg("Slippage limit reached. Output shares below threshold.")]
    SlippageExceeded,
    #[msg("Provided token vault does not match state PDA.")]
    InvalidTokenVault,
    #[msg("Provided LP mint does not match state PDA.")]
    InvalidLpMint,
    #[msg("Provided asset mint does not match state.")]
    InvalidAssetMint,
    #[msg("User ATA does not correspond to expected mint.")]
    InvalidUserAta,
    #[msg("User is not the rightful owner of the source ATA.")]
    UnauthorizedOwner,
    #[msg("Vault is currently paused by authority.")]
    VaultPaused,
}