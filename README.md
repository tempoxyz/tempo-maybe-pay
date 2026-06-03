# Tempo Maybe Pay

Tempo Maybe Pay is a hackathon demo for buying fake Tempo product NFTs with a probabilistic TIP-20 payment. Users escrow the maximum payment, onchain commit-reveal randomness resolves whether the order is paid or free, and the NFT is minted in either outcome.

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

- Store: `0x93Bde6cfc058230783211fdF2A80B872B5dEB4A2`
- NFT: `0xCEF460cb161fe30c2FE0526164374BF992A627C4`
- Payment token: `0x20c0000000000000000000000000000000000000`
- Operator: `0xCdf374527991264A77073D83A6781eD6A121722B`

Deployment artifact: `packages/contracts/deployments/42431.json`.

Mainnet is configured in code but not deployed yet.

## Live app

Production: https://tempo-maybe-pay.vercel.app

## Validation

```bash
pnpm check
pnpm --filter @tempo-maybe-pay/web build
```

The current testnet smoke test opened an epoch, placed an order, processed it through the API, and minted NFT `#1`.

Production smoke test opened the live app, placed a Moderato order, processed it through Vercel, and minted NFT `#2`.
