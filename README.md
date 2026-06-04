# Tempo Maybe Pay

Tempo Maybe Pay is a hackathon demo for buying merchant-store product NFTs with a probabilistic TIP-20 payment. Users escrow the maximum payment, onchain commit-reveal randomness resolves whether the order is paid or free, and the NFT is minted in either outcome.

## Flow

1. A user connects a Tempo passkey wallet.
2. The app opens a committed randomness epoch.
3. The user chooses an NFT and pay probability.
4. The user approves pathUSD escrow and places an order.
5. The frontend waits for the order receipt and calls the Vercel processor.
6. The processor reveals the seed, resolves the order, moves pathUSD with memos, and mints the NFT.

## Local Setup

```bash
pnpm install
pnpm --filter @tempo-maybe-pay/contracts test
pnpm --filter @tempo-maybe-pay/web dev
```

Copy `apps/web/.env.example` to `apps/web/.env.local` after contracts are deployed.

## Tempo testnet deployment

- Store: `0x53e4b02Be21d629AFf3Cd6C8500913Bd48CAD8A1`
- NFT: `0x150ee51799ED8Eba69fcfB1Bb35Af7295ad9B86a`
- Payment token: `0x20c0000000000000000000000000000000000000`
- Operator: `0xCdf374527991264A77073D83A6781eD6A121722B`

Deployment artifact: `packages/contracts/deployments/42431.json`.

Mainnet is configured in code but not deployed yet.

The testnet catalog has ten merchant items: Tempo Hoodie, Ceramic Mug, Desk Mat, Canvas Tote, Notebook Pack, Stainless Bottle, Mechanical Keyboard, Desk Lamp, Gift Card, and Sticker Sheet.

## Live app

Production: https://tempo-maybe-pay.vercel.app

## Validation

```bash
pnpm check
pnpm --filter @tempo-maybe-pay/web build
```

The refreshed production smoke placed and processed both outcomes against `https://tempo-maybe-pay.vercel.app`:

- Paid path: token `#5`, order tx `0x268a6611f5504e5bc761a2e0e9b73ebb2adf3b8e2f4394ddeb45a12555f54527`, process tx `0xae8873ad70a32b90b1829c4fe7bb45da71237445553501736cab562e6f58e5e1`
- Free path: token `#6`, order tx `0xb68586f58106cbea9d77fc01e4c78be99a2d39d97a59fc71ccf00ce24c178c1b`, process tx `0x326eb4fa9595cd7eb56e95268f37c7e6fbaa2b539d96ec52aad600d34756bcc6`
