use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Calculation triggered arithmetic overflow.")]
    MathOverflow,
    #[msg("Calculation triggered arithmetic underflow.")]
    MathUnderflow,
    #[msg("Deposit fee basis points cannot exceed 10% (1000 bps).")]
    ExcessiveFee,
    #[msg("Vault operations are currently paused by the administrator.")]
    VaultPaused,
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDeposit,
    #[msg("Slippage limit reached: shares to mint is less than minimum specified.")]
    SlippageExceeded,
    #[msg("Underlying mint account does not match vault specifications.")]
    InvalidMint,
    #[msg("Share mint account does not match vault specifications.")]
    InvalidShareMint,
    #[msg("Vault token account does not match vault specifications.")]
    InvalidVaultTokenAccount,
    #[msg("Account owner mismatch for the provided token account.")]
    InvalidOwner,
}