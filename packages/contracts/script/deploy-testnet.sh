#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY}"
: "${OPERATOR_PRIVATE_KEY:?Set OPERATOR_PRIVATE_KEY}"

RPC_URL="${TEMPO_TESTNET_RPC_URL:-https://rpc.moderato.tempo.xyz}"
FEE_TOKEN="${PATHUSD_ADDRESS:-0x20c0000000000000000000000000000000000000}"
MERCHANT="${MERCHANT_ADDRESS:-$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")}"
DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
OPERATOR="${OPERATOR_ADDRESS:-$(cast wallet address --private-key "$OPERATOR_PRIVATE_KEY")}"
CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
OUT_DIR="$ROOT_DIR/deployments"
OUT_FILE="$OUT_DIR/$CHAIN_ID.json"

mkdir -p "$OUT_DIR"

deploy_contract() {
  local contract="$1"
  shift
  forge create "$contract" \
    --rpc-url "$RPC_URL" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --tempo.fee-token "$FEE_TOKEN" \
    --broadcast \
    --json \
    "$@"
}

send_tx() {
  cast send "$@" \
    --rpc-url "$RPC_URL" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --tempo.fee-token "$FEE_TOKEN" \
    --json >/dev/null
}

echo "Deploying Tempo Maybe Pay to chain $CHAIN_ID"
echo "Deployer: $DEPLOYER"
echo "Operator: $OPERATOR"
echo "Merchant: $MERCHANT"

NFT_JSON="$(deploy_contract src/TempoMaybePayNFT.sol:TempoMaybePayNFT --constructor-args "Tempo Maybe Pay" "TMP" "$DEPLOYER")"
NFT_ADDRESS="$(printf '%s' "$NFT_JSON" | jq -r '.deployedTo')"
echo "NFT: $NFT_ADDRESS"

STORE_JSON="$(deploy_contract src/TempoMaybePayStore.sol:TempoMaybePayStore --constructor-args "$FEE_TOKEN" "$NFT_ADDRESS" "$MERCHANT" "$DEPLOYER")"
STORE_ADDRESS="$(printf '%s' "$STORE_JSON" | jq -r '.deployedTo')"
echo "Store: $STORE_ADDRESS"

send_tx "$NFT_ADDRESS" "setStore(address)" "$STORE_ADDRESS"
send_tx "$STORE_ADDRESS" "setProcessor(address,bool)" "$OPERATOR" true

send_tx "$STORE_ADDRESS" "setProduct(uint256,string,uint256,uint256,bool,string)" \
  1 "Payment Lane Pass" 10000000 500 true "https://tempo-maybe-pay.vercel.app/api/metadata/$CHAIN_ID/1"
send_tx "$STORE_ADDRESS" "setProduct(uint256,string,uint256,uint256,bool,string)" \
  2 "Moderato Mint" 5000000 500 true "https://tempo-maybe-pay.vercel.app/api/metadata/$CHAIN_ID/2"
send_tx "$STORE_ADDRESS" "setProduct(uint256,string,uint256,uint256,bool,string)" \
  3 "PathUSD Proof" 2500000 500 true "https://tempo-maybe-pay.vercel.app/api/metadata/$CHAIN_ID/3"
send_tx "$STORE_ADDRESS" "setProduct(uint256,string,uint256,uint256,bool,string)" \
  4 "MaybePay Receipt" 1000000 1000 true "https://tempo-maybe-pay.vercel.app/api/metadata/$CHAIN_ID/4"

cat > "$OUT_FILE" <<JSON
{
  "chainId": $CHAIN_ID,
  "rpcUrl": "$RPC_URL",
  "paymentToken": "$FEE_TOKEN",
  "merchant": "$MERCHANT",
  "deployer": "$DEPLOYER",
  "operator": "$OPERATOR",
  "nft": "$NFT_ADDRESS",
  "store": "$STORE_ADDRESS",
  "deployedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
JSON

echo "Wrote $OUT_FILE"

