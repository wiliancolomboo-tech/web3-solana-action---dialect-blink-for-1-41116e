# Build the Anchor program artifacts
anchor build

# Generate deterministic deployment keypair if necessary
solana-keygen new -o target/deploy/yield_vault-keypair.json --no-bip39-passphrase --force

# Sync program ID across lib.rs and Anchor.toml
anchor keys sync

# Deploy to Devnet (or Mainnet-Beta by adjusting the provider cluster)
anchor deploy --provider.cluster devnet