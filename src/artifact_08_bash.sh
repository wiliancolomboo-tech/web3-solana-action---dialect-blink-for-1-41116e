# -------------------------------------------------------------
# 1. On-Chain Smart Contract Deployment
# -------------------------------------------------------------
# Build program binaries
anchor build

# Sync Program ID into lib.rs and Anchor.toml
anchor keys sync

# Deploy to Solana Devnet / Mainnet-Beta
solana program deploy \
  --program-id target/deploy/solana_vault_blink-keypair.json \
  target/deploy/solana_vault_blink.so \
  --url https://api.devnet.solana.com

# -------------------------------------------------------------
# 2. Local Fast-Track Testing
# -------------------------------------------------------------
npm install
anchor test

# -------------------------------------------------------------
# 3. Microservice Orchestration via Docker
# -------------------------------------------------------------
# Configure secrets
cp .env.example .env

# Spin up daemonized microservice
docker-compose up -d --build

# Inspect operational logs
docker-compose logs -f solana-blink-engine