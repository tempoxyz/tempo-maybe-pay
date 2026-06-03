# tempo-maybe-pay

Hackathon app for Tempo Maybe Pay.

## Commands

- Install: `pnpm install`
- Web dev: `pnpm --filter @tempo-maybe-pay/web dev`
- Web build: `pnpm --filter @tempo-maybe-pay/web build`
- Contracts build: `pnpm --filter @tempo-maybe-pay/contracts build`
- Contracts test: `pnpm --filter @tempo-maybe-pay/contracts test`

## Notes

- Do not commit `.env*`, generated wallet keys, Vercel project metadata, or Foundry `broadcast/` output.
- Payments use TIP-20 contracts and Tempo transactions; do not use native `msg.value`.
- Testnet is Tempo Moderato chain `42431`; mainnet is chain `4217`.

