# Tempo Maybe Pay

Tempo Maybe Pay is a "try to bankrupt the house" storefront for buying product NFTs with probabilistic TIP-20 payments. Users escrow the maximum payment, onchain commit-reveal randomness resolves whether the order is paid or free, and the item NFT is delivered either way. Each NFT can be redeemed back to the house for 99% of its price for 1 hour.

## Flow

1. A user connects a Tempo passkey wallet.
2. The app opens a committed randomness epoch.
3. The user chooses an item and pay probability.
4. The user approves pathUSD escrow and places an order.
5. The frontend waits for the order receipt and calls the Vercel processor.
6. The processor reveals the seed, resolves the order, returns free escrow or keeps paid escrow in the house contract, and delivers the item NFT.
7. The user can redeem the NFT for 99% of its price within 1 hour, returning the NFT to store inventory.
8. Expired redemption claims can be settled onchain; the NFT remains a collectible and the house liability unlocks.

## Local Setup

```bash
pnpm install
pnpm --filter @tempo-maybe-pay/contracts test
pnpm --filter @tempo-maybe-pay/web dev
```

Copy `.env.example` or `apps/web/.env.example` to a local `.env.local` after contracts are deployed.

## Tempo testnet deployment

- Store: `0x8d4D5049c23a49CF1819867889ef1b0B049F118A`
- Item token: `0x8e02BA0dDE050d5101f18B0bCA7F82278D6483C9`
- Payment token: `0x20c0000000000000000000000000000000000000`
- Operator: `0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4`
- Initial house bankroll: `500 pathUSD`

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

Testnet smoke covered free order resolution, 99% redemption, NFT restocking, and liability returning to zero.
