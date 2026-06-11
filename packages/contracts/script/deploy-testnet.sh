#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-${MAYBEPAY_DEPLOYER_PRIVATE_KEY:-${MAYBEPAY_PROCESSOR_PRIVATE_KEY:-}}}"
OPERATOR_PRIVATE_KEY="${OPERATOR_PRIVATE_KEY:-${MAYBEPAY_PROCESSOR_PRIVATE_KEY:-}}"

if [[ -z "$DEPLOYER_PRIVATE_KEY" ]]; then
  echo "Set DEPLOYER_PRIVATE_KEY, MAYBEPAY_DEPLOYER_PRIVATE_KEY, or MAYBEPAY_PROCESSOR_PRIVATE_KEY" >&2
  exit 1
fi

if [[ -z "$OPERATOR_PRIVATE_KEY" ]]; then
  echo "Set OPERATOR_PRIVATE_KEY or MAYBEPAY_PROCESSOR_PRIVATE_KEY" >&2
  exit 1
fi

RPC_URL="${TEMPO_RPC_URL:-${TEMPO_TESTNET_RPC_URL:-https://rpc.testnet.tempo.xyz}}"
PAYMENT_RAIL_ID="${PAYMENT_RAIL_ID:-pathusd}"
PAYMENT_TOKEN="${PAYMENT_TOKEN_ADDRESS:-${PAYMENT_TOKEN:-${PATHUSD_ADDRESS:-0x20c0000000000000000000000000000000000000}}}"
PAYMENT_TOKEN_SYMBOL="${PAYMENT_TOKEN_SYMBOL:-pathUSD}"
FEE_TOKEN="${FEE_TOKEN_ADDRESS:-${FEE_TOKEN:-$PAYMENT_TOKEN}}"
MERCHANT="${MERCHANT_ADDRESS:-$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")}"
DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
OPERATOR="${OPERATOR_ADDRESS:-$(cast wallet address --private-key "$OPERATOR_PRIVATE_KEY")}"
CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
METADATA_BASE_URL="${METADATA_BASE_URL:-https://tempo-maybe-pay.vercel.app}"
HOUSE_BANKROLL_AMOUNT="${HOUSE_BANKROLL_AMOUNT:-0}"
OUT_DIR="$ROOT_DIR/deployments"
OUT_FILE="$OUT_DIR/$CHAIN_ID-$PAYMENT_RAIL_ID.json"

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
echo "Payment rail: $PAYMENT_RAIL_ID"
echo "Payment token: $PAYMENT_TOKEN_SYMBOL $PAYMENT_TOKEN"
echo "Transaction fee token: $FEE_TOKEN"
echo "House bankroll seed: $HOUSE_BANKROLL_AMOUNT $PAYMENT_TOKEN_SYMBOL base units"

NFT_JSON="$(
  deploy_contract src/TempoMaybePayNFTV2.sol:TempoMaybePayNFTV2 \
    --constructor-args "Tempo Maybe Pay" "TMP" "$METADATA_BASE_URL/api/metadata/$CHAIN_ID/" "$DEPLOYER"
)"
NFT_ADDRESS="$(printf '%s' "$NFT_JSON" | jq -r '.deployedTo')"
echo "NFT: $NFT_ADDRESS"

STORE_JSON="$(
  deploy_contract src/TempoMaybePayStoreV2.sol:TempoMaybePayStoreV2 \
    --constructor-args "$PAYMENT_TOKEN" "$NFT_ADDRESS" "$MERCHANT" "$DEPLOYER"
)"
STORE_ADDRESS="$(printf '%s' "$STORE_JSON" | jq -r '.deployedTo')"
echo "Store: $STORE_ADDRESS"

send_tx "$NFT_ADDRESS" "setStore(address)" "$STORE_ADDRESS"
send_tx "$STORE_ADDRESS" "setProcessor(address,bool)" "$OPERATOR" true

if [[ "$CHAIN_ID" == "4217" ]]; then
  PRODUCTS=(
    "1|Tempo Flight Pass|1000|10000"
    "2|Tempo Dollar Lane|10000|5000"
    "3|Tempo Treasury Bag|100000|1000"
  )
else
  PRODUCTS=(
    "1|Tempo Flight Pass|1000000|10000"
    "2|Tempo Dollar Lane|10000000|5000"
    "3|Tempo Treasury Bag|100000000|1000"
  )
fi

for product in "${PRODUCTS[@]}"; do
  IFS="|" read -r id name price max_supply <<<"$product"
  echo "Configuring product $id: $name"
  send_tx "$STORE_ADDRESS" "setProduct(uint256,uint256,uint256,bool)" "$id" "$price" "$max_supply" true
done

if [[ "$HOUSE_BANKROLL_AMOUNT" != "0" ]]; then
  send_tx "$PAYMENT_TOKEN" "transfer(address,uint256)" "$STORE_ADDRESS" "$HOUSE_BANKROLL_AMOUNT"
fi

cat > "$OUT_FILE" <<JSON
{
  "version": 2,
  "chainId": $CHAIN_ID,
  "paymentRailId": "$PAYMENT_RAIL_ID",
  "rpcUrl": "$RPC_URL",
  "paymentToken": "$PAYMENT_TOKEN",
  "paymentTokenSymbol": "$PAYMENT_TOKEN_SYMBOL",
  "feeToken": "$FEE_TOKEN",
  "merchant": "$MERCHANT",
  "deployer": "$DEPLOYER",
  "operator": "$OPERATOR",
  "nft": "$NFT_ADDRESS",
  "store": "$STORE_ADDRESS",
  "houseBankrollAmount": "$HOUSE_BANKROLL_AMOUNT",
  "deployedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
JSON

echo "Wrote $OUT_FILE"
