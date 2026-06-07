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

## Tempo deployments

### Mainnet

- pathUSD store: `0x567A1CBdb1fb304c799d1130f3675B58E923e2C6`
- pathUSD item token: `0x33D45470110aA62F06D97588205fe413a44eFE44`
- pathUSD token: `0x20c0000000000000000000000000000000000000`
- USDC.e store: `0xDD7c855e521B9371aB7c7d2166964b69D239315A`
- USDC.e item token: `0x64c0c6305b4D3C9290C3412374f6A455EDFDdcd7`
- USDC.e token: `0x20c000000000000000000000b9537d11c60e8b50`
- Operator: `0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4`
- Initial USDC.e house bankroll: `0 USDC.e` until seeded

Deployment artifacts: `packages/contracts/deployments/4217.json` and `packages/contracts/deployments/4217-usdc.json`.

### Testnet

- pathUSD store: `0x50Fe68c6BF1FC8311252F86701A54F6C753D691D`
- pathUSD item token: `0x47926a61023B4A99de3F8958b4F168e8aB868Ee3`
- pathUSD token: `0x20c0000000000000000000000000000000000000`
- USDC.e store: `0xCd4A483924aB8711F094C2cE351681F691069D34`
- USDC.e item token: `0x95f4beAB8Db934Dfb71F0D07fe794099D3F82b27`
- USDC.e token: `0x20c0000000000000000000009e8d7eb59b783726`
- Operator: `0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4`
- Initial USDC.e house bankroll: `0 USDC.e` until seeded

Deployment artifacts: `packages/contracts/deployments/42431.json` and `packages/contracts/deployments/42431-usdc.json`.

The catalog has three Tempo tier NFTs:

- Tempo Flight Pass, pictured with `:money-with-wings:`
- Tempo Dollar Lane, pictured with `:dollar:`
- Tempo Treasury Bag, pictured with `:moneybag:`

Testnet prices are `1`, `10`, and `100` in the selected token. Mainnet prices are `0.001`, `0.01`, and `0.1` in the selected token.

## Live app

Production: https://tempo-maybe-pay.vercel.app

## Validation

```bash
pnpm check
pnpm --filter @tempo-maybe-pay/web build
```

Testnet smoke covered free order resolution, 99% redemption, NFT restocking, and liability returning to zero.
