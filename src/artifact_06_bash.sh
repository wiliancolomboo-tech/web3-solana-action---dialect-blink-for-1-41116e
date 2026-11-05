# 1. Clone & install dependencies
git clone https://github.com/sponsor-org/blink-vault.git
cd blink-vault && npm install

# 2. Build and verify Anchor smart contract
anchor build
anchor test

# 3. Deploy smart contract to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --program-name solana_vault --provider.cluster devnet

# 4. Export configuration environment variables
export RPC_ENDPOINT="https://api.devnet.solana.com"
export PROGRAM_ID="<YOUR_DEPLOYED_PROGRAM_ID>"
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/your-channel-webhook"
npm run build
npm start