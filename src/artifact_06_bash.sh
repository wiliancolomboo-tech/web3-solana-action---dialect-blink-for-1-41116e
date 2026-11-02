# 1. Clone the repository and navigate to root directory
git clone https://github.com/example/solana-action-vault-blink.git
cd solana-action-vault-blink

# 2. Install all Node dependencies
yarn install

# 3. Build the Anchor program binary and generate IDL types
anchor build

# 4. Sync Program ID with local target keys
anchor keys sync

# 5. Run the complete automated test matrix (Starts local test validator automatically)
anchor test