curl -i -X POST -H "Content-Type: application/json" \
  -d '{"account": "GsbwXfJraMomNxBcgR1kLq5c91iRzC84nQUMq5fF2uF4"}' \
  "http://localhost:3000/api/actions/vault-deposit?amount=100&mint=USDC"