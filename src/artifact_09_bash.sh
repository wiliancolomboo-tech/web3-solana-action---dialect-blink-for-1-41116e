# 1. Build and test Anchor smart contract locally
anchor build
anchor test

# 2. Deploy smart contract to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
anchor deploy --program-name vault_core --provider.cluster devnet

# 3. Launch Gateway Services with 1 command
docker compose up -d --build

# 4. Verify Gateway Health and Blink Endpoint Unfurl
curl -i http://localhost:3000/healthz
curl -i http://localhost:3000/actions.json
curl -i http://localhost:3000/api/actions/vault-deposit