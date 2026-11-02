# 1. Clone repository & install dependencies
git clone https://github.com/sponsor-org/omnivault-blink.git
cd omnivault-blink
npm install

# 2. Build Anchor Smart Contract (Rust)
cd programs/yield-vault && anchor build
solana program deploy ./target/deploy/yield_vault.so --network devnet

# 3. Configure Environment Variables
cp .env.example .env
# Edit .env with your SOLANA_RPC_URL and DISCORD_WEBHOOK_URL

# 4. Run automated test suite
npm test

# 5. Start production service
npm run build && npm start