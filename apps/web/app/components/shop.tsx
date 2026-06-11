'use client'

import {
  explorerAddressUrl,
  explorerTxUrl,
  formatPathUsd,
  getDeployment,
  getProductPrice,
  maybePayNftAbi,
  maybePayStoreAbi,
  normalizeChainId,
  normalizePaymentRailId,
  products,
  quoteMaxEscrow,
  quoteRedeemValue,
  tip20Abi,
  type ChainId,
  type Product,
} from '@tempo-maybe-pay/shared'
import { getAccessKeyAuthorization } from '@/app/lib/access-key'
import { ArrowLeft, ArrowRight, Banknote, CheckCircle2, Clock3, ExternalLink, Flame, RefreshCw, RotateCcw, ShieldCheck, Wallet } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { encodeFunctionData, zeroAddress, type Hex } from 'viem'
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useSendTransactionSync,
  useSwitchChain,
} from 'wagmi'

type Stage = 'idle' | 'epoch' | 'placing' | 'processing' | 'redeeming' | 'expiring' | 'resolved'

type ProcessResult = {
  basePrice: string
  buyer: Hex
  commitment: Hex
  epochId: string
  houseAvailableReserve: string
  houseBankroll: string
  houseOutstandingLiability: string
  housePendingEscrow: string
  maxEscrow: string
  merchant?: Hex
  metadataHash: Hex
  nftOwner: Hex
  orderId: Hex
  paidAmount: string
  payProbabilityBps: number
  paymentTransactionHash?: Hex
  paymentRailId?: string
  paymentTokenSymbol?: string
  processTransactionHash?: Hex
  productId: string
  refundedAmount: string
  redeemActive: boolean
  redeemDeadline: string
  redeemValue: string
  roll: string
  seed: Hex
  status: 'paid' | 'free'
  threshold: string
  tokenId: string
}

type OwnedClaim = {
  tokenId: bigint
  productId?: bigint
  productName: string
  redeemValue: bigint
  deadline: bigint
  active: boolean
  expired: boolean
}

type TempoSyncReceipt = {
  hash?: Hex
  status?: unknown
  transactionHash?: Hex
}

function receiptFailed(status: unknown): boolean {
  return status === false || status === '0x0' || status === 'reverted'
}

function shortValue(value: string, visible = 6): string {
  return `${value.slice(0, visible)}...${value.slice(-4)}`
}

function randomOrderId(): Hex {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function formatPercent(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`
}

function formatRawPathUsd(raw: string | bigint): string {
  return formatPathUsd(typeof raw === 'bigint' ? raw : BigInt(raw))
}

function formatTokenAmount(raw: string | bigint, symbol: string): string {
  return `${formatRawPathUsd(raw)} ${symbol}`
}

function withSelectedFeeToken(
  args: Record<string, unknown>,
  deployment: { paymentToken: Hex; railId: string },
): Record<string, unknown> {
  return { ...args, feeToken: deployment.paymentToken }
}

function withConnectAccessKey(
  args: Record<string, unknown>,
  chainId: ChainId,
  railId: 'pathusd' | 'usdc',
): Record<string, unknown> {
  return {
    ...args,
    capabilities: {
      authorizeAccessKey: getAccessKeyAuthorization(chainId, railId),
    },
  }
}

function formatCountdown(deadline: bigint, nowSeconds: number): string {
  const remaining = Number(deadline) - nowSeconds
  if (remaining <= 0) return 'Expired'
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

type ShopProps = {
  checkoutProductId?: number
}

type NftProductCardProps = {
  bankrupt?: boolean
  onClick?: () => void
  price: bigint
  product: Product
  redeemValue: bigint
  symbol: string
}

function NftProductCard({ bankrupt = false, onClick, price, product, redeemValue, symbol }: NftProductCardProps) {
  const content = (
    <>
      <img alt={product.name} src={product.image} />
      <span className="productDetails">
        <strong>{product.name}</strong>
        <em>{product.description}</em>
        <span className="productMoney">
          <span>{formatTokenAmount(price, symbol)}</span>
          <span>{formatTokenAmount(redeemValue, symbol)} cash-out</span>
        </span>
        {bankrupt ? <span className="productAction">House bankrupt</span> : null}
      </span>
    </>
  )

  if (onClick) {
    return (
      <button
        className={`productCard ${bankrupt ? 'bankruptProduct' : ''}`}
        onClick={onClick}
        style={{ '--accent': product.accent } as CSSProperties}
        type="button"
      >
        {content}
      </button>
    )
  }

  return (
    <div
      className={`productCard productCardStatic ${bankrupt ? 'bankruptProduct' : ''}`}
      style={{ '--accent': product.accent } as CSSProperties}
    >
      {content}
    </div>
  )
}

export function Shop({ checkoutProductId }: ShopProps = {}) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const selectedChainId = normalizeChainId(searchParams.get('chainId'))
  const selectedRailId = normalizePaymentRailId(searchParams.get('rail'))
  const deployment = getDeployment(selectedChainId, selectedRailId)
  const tokenSymbol = deployment.symbol
  const chainId = useChainId()
  const { address, isConnected } = useAccount()
  const { connectors, connectAsync, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChainAsync } = useSwitchChain()
  const sendTransactionSync = useSendTransactionSync() as unknown as {
    mutateAsync: (args: Record<string, unknown>) => Promise<TempoSyncReceipt>
    isPending: boolean
  }

  const [freeProbabilityBps, setFreeProbabilityBps] = useState(5000)
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | undefined>()
  const [placeTransactionHash, setPlaceTransactionHash] = useState<Hex | undefined>()
  const [redemptionTransactionHash, setRedemptionTransactionHash] = useState<Hex | undefined>()
  const [result, setResult] = useState<ProcessResult | undefined>()
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const interval = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(interval)
  }, [])

  const isCheckoutPage = checkoutProductId !== undefined
  const product = products.find((item) => item.id === (checkoutProductId ?? products[0].id)) ?? products[0]
  const routeForChain = (nextChainId: ChainId) =>
    isCheckoutPage
      ? `/checkout/${product.id}?chainId=${nextChainId}&rail=${selectedRailId}`
      : `/?chainId=${nextChainId}&rail=${selectedRailId}`
  const routeForRail = (nextRailId: 'pathusd' | 'usdc') =>
    isCheckoutPage
      ? `/checkout/${product.id}?chainId=${selectedChainId}&rail=${nextRailId}`
      : `/?chainId=${selectedChainId}&rail=${nextRailId}`
  const basePrice = getProductPrice(product, selectedChainId)
  const payProbabilityBps = 10_000 - freeProbabilityBps
  const maxEscrow = useMemo(
    () => quoteMaxEscrow(basePrice, payProbabilityBps),
    [basePrice, payProbabilityBps],
  )
  const redeemValue = quoteRedeemValue(basePrice)
  const multiplier = Number((maxEscrow * 100n) / basePrice) / 100
  const paidRollRange = `0-${payProbabilityBps - 1}`
  const freeRollRange = freeProbabilityBps === 0 ? 'none' : `${payProbabilityBps}-9999`
  const chainReady = Boolean(deployment.store && deployment.nft)
  const connectedToSelectedChain = chainId === selectedChainId

  const balanceQuery = useReadContract({
    abi: tip20Abi,
    address: deployment.paymentToken,
    args: [address ?? zeroAddress],
    chainId: selectedChainId,
    functionName: 'balanceOf',
    query: {
      enabled: Boolean(address),
      refetchInterval: 5_000,
    },
  })

  const balance = typeof balanceQuery.data === 'bigint' ? balanceQuery.data : 0n
  const houseBankrollQuery = useReadContract({
    abi: tip20Abi,
    address: deployment.paymentToken,
    args: [deployment.store ?? zeroAddress],
    chainId: selectedChainId,
    functionName: 'balanceOf',
    query: {
      enabled: Boolean(deployment.store),
      refetchInterval: 5_000,
    },
  })

  const availableReserveQuery = useReadContract({
    abi: maybePayStoreAbi,
    address: deployment.store ?? zeroAddress,
    chainId: selectedChainId,
    functionName: 'availableHouseReserve',
    query: {
      enabled: Boolean(deployment.store),
      refetchInterval: 5_000,
    },
  })

  const outstandingLiabilityQuery = useReadContract({
    abi: maybePayStoreAbi,
    address: deployment.store ?? zeroAddress,
    chainId: selectedChainId,
    functionName: 'outstandingRedemptionLiability',
    query: {
      enabled: Boolean(deployment.store),
      refetchInterval: 5_000,
    },
  })

  const pendingEscrowQuery = useReadContract({
    abi: maybePayStoreAbi,
    address: deployment.store ?? zeroAddress,
    chainId: selectedChainId,
    functionName: 'pendingEscrowTotal',
    query: {
      enabled: Boolean(deployment.store),
      refetchInterval: 5_000,
    },
  })

  const tokenIdsQuery = useReadContract({
    abi: maybePayNftAbi,
    address: deployment.nft ?? zeroAddress,
    args: [address ?? zeroAddress],
    chainId: selectedChainId,
    functionName: 'tokensOfOwner',
    query: {
      enabled: Boolean(address && deployment.nft),
      refetchInterval: 5_000,
    },
  })

  const ownedTokenIds = (tokenIdsQuery.data ?? []) as readonly bigint[]
  const ownedClaimContracts = useMemo(
    () =>
      ownedTokenIds.flatMap((tokenId) => [
        {
          abi: maybePayStoreAbi,
          address: deployment.store ?? zeroAddress,
          args: [tokenId],
          chainId: selectedChainId,
          functionName: 'redemptions',
        },
        {
          abi: maybePayNftAbi,
          address: deployment.nft ?? zeroAddress,
          args: [tokenId],
          chainId: selectedChainId,
          functionName: 'tokenProduct',
        },
      ]),
    [deployment.nft, deployment.store, ownedTokenIds, selectedChainId],
  )
  const ownedClaimsQuery = useReadContracts({
    contracts: ownedClaimContracts,
    query: {
      enabled: chainReady && ownedClaimContracts.length > 0,
      refetchInterval: 5_000,
    },
  })

  const houseBankroll = typeof houseBankrollQuery.data === 'bigint' ? houseBankrollQuery.data : 0n
  const availableReserve = typeof availableReserveQuery.data === 'bigint' ? availableReserveQuery.data : 0n
  const outstandingLiability =
    typeof outstandingLiabilityQuery.data === 'bigint' ? outstandingLiabilityQuery.data : 0n
  const pendingEscrow = typeof pendingEscrowQuery.data === 'bigint' ? pendingEscrowQuery.data : 0n
  const canUnderwrite = !chainReady || availableReserve >= redeemValue
  const hasFunds = !address || balance >= maxEscrow
  const houseSolvent = !chainReady || availableReserve > 0n
  const busy =
    stage === 'epoch' ||
    stage === 'placing' ||
    stage === 'processing' ||
    stage === 'redeeming' ||
    stage === 'expiring' ||
    sendTransactionSync.isPending
  const roll = result ? Number(result.roll) : undefined
  const rollPercent = roll === undefined ? undefined : `${roll / 100}%`
  const oddsStyle = {
    '--pay-pct': `${payProbabilityBps / 100}%`,
    '--roll-pct': rollPercent ?? '0%',
  } as CSSProperties
  const ownedClaims = useMemo<OwnedClaim[]>(() => {
    return ownedTokenIds.map((tokenId, index) => {
      const redemption = ownedClaimsQuery.data?.[index * 2]?.result as readonly [bigint, bigint, boolean] | undefined
      const tokenProductId = ownedClaimsQuery.data?.[index * 2 + 1]?.result as bigint | undefined
      const claimProduct = products.find((item) => BigInt(item.id) === tokenProductId)
      const deadline = redemption?.[1] ?? 0n
      const active = redemption?.[2] ?? false

      return {
        tokenId,
        productId: tokenProductId,
        productName: claimProduct?.name ?? `Product #${tokenProductId?.toString() ?? '?'}`,
        redeemValue: redemption?.[0] ?? 0n,
        deadline,
        active,
        expired: active && deadline > 0n && Number(deadline) < nowSeconds,
      }
    })
  }, [nowSeconds, ownedClaimsQuery.data, ownedTokenIds])
  const activeClaims = ownedClaims.filter((claim) => claim.active && !claim.expired)
  const expiredClaims = ownedClaims.filter((claim) => claim.expired)
  const collectibleClaims = ownedClaims.filter((claim) => !claim.active)

  function changeNetwork(nextChainId: ChainId) {
    if (nextChainId === selectedChainId) return
    setError(undefined)
    setResult(undefined)
    setPlaceTransactionHash(undefined)
    setRedemptionTransactionHash(undefined)
    setStage('idle')

    if (isConnected && chainId !== nextChainId) {
      void switchChainAsync({ chainId: nextChainId }).catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : 'wallet did not switch networks'
        setError(`The app switched networks, but your wallet did not: ${message}`)
      })
    }
  }

  function changeRail() {
    setError(undefined)
    setResult(undefined)
    setPlaceTransactionHash(undefined)
    setRedemptionTransactionHash(undefined)
    setStage('idle')
  }

  async function refetchLiveData() {
    await Promise.all([
      balanceQuery.refetch(),
      houseBankrollQuery.refetch(),
      availableReserveQuery.refetch(),
      outstandingLiabilityQuery.refetch(),
      pendingEscrowQuery.refetch(),
      tokenIdsQuery.refetch(),
      ownedClaimsQuery.refetch(),
    ])
  }

  async function beginCheckout() {
    if (!address) {
      setError('Connect a wallet first.')
      return
    }
    if (!deployment.store) {
      setError('Checkout is not available on this network yet.')
      return
    }
    if (!canUnderwrite) {
      setError('The house is bankrupt for this item. Wait for claims to expire or pick a smaller product.')
      return
    }
    if (!hasFunds) {
      setError(`Wallet needs at least ${formatTokenAmount(maxEscrow, tokenSymbol)} for this probability.`)
      return
    }

    setError(undefined)
    setResult(undefined)
    setPlaceTransactionHash(undefined)
    setRedemptionTransactionHash(undefined)

    try {
      if (!connectedToSelectedChain) {
        await switchChainAsync({ chainId: selectedChainId })
      }

      setStage('epoch')
      const epochResponse = await fetch(`/api/epoch/ensure?chainId=${selectedChainId}&rail=${selectedRailId}`, {
        method: 'POST',
      })
      if (!epochResponse.ok) throw new Error(await epochResponse.text())

      const orderId = randomOrderId()
      const escrowData = encodeFunctionData({
        abi: tip20Abi,
        args: [deployment.store, maxEscrow, orderId],
        functionName: 'transferWithMemo',
      })

      setStage('placing')
      const receipt = await sendTransactionSync.mutateAsync(
        withSelectedFeeToken(
          {
            calls: [{ data: escrowData, to: deployment.paymentToken }],
            chainId: selectedChainId,
            from: address,
          },
          deployment,
        ),
      )
      const hash = receipt.transactionHash ?? receipt.hash
      if (!hash) throw new Error('Wallet did not return a payment transaction hash')
      if (receiptFailed(receipt.status)) throw new Error('Payment transaction failed before escrow. No order was processed.')
      setPlaceTransactionHash(hash)

      setStage('processing')
      const processResponse = await fetch(`/api/orders/${orderId}/process?chainId=${selectedChainId}&rail=${selectedRailId}`, {
        body: JSON.stringify({
          buyer: address,
          maxEscrow: maxEscrow.toString(),
          payProbabilityBps,
          paymentTransactionHash: hash,
          productId: product.id,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
      if (!processResponse.ok) {
        const reason = await processResponse.text()
        throw new Error(reason ? `Payment verification failed: ${reason}` : 'Payment verification failed.')
      }
      const processed = (await processResponse.json()) as ProcessResult
      setResult(processed)
      setStage('resolved')
      await refetchLiveData()
    } catch (caught) {
      setStage('idle')
      setError(caught instanceof Error ? caught.message : 'Checkout failed.')
    }
  }

  async function redeemToken(tokenId: bigint) {
    if (!address || !deployment.store || !deployment.nft) {
      setError('Connect a wallet with a redeemable NFT first.')
      return
    }

    setError(undefined)
    setStage('redeeming')

    try {
      if (!connectedToSelectedChain) {
        await switchChainAsync({ chainId: selectedChainId })
      }

      const data = encodeFunctionData({
        abi: maybePayStoreAbi,
        args: [tokenId],
        functionName: 'redeem',
      })
      const receipt = await sendTransactionSync.mutateAsync(
        withSelectedFeeToken(
          {
            calls: [{ data, to: deployment.store }],
            chainId: selectedChainId,
            from: address,
          },
          deployment,
        ),
      )
      const hash = receipt.transactionHash ?? receipt.hash
      if (!hash) throw new Error('Wallet did not return a redemption transaction hash')
      if (receiptFailed(receipt.status)) throw new Error('Redemption transaction failed.')
      setRedemptionTransactionHash(hash)
      setResult((current) =>
        current?.tokenId === tokenId.toString() ? { ...current, redeemActive: false } : current,
      )
      setStage('resolved')
      await refetchLiveData()
    } catch (caught) {
      setStage(result ? 'resolved' : 'idle')
      setError(caught instanceof Error ? caught.message : 'Redemption failed.')
    }
  }

  async function expireToken(tokenId: bigint) {
    if (!deployment.store) {
      setError('Checkout is not available on this network yet.')
      return
    }

    setError(undefined)
    setStage('expiring')

    try {
      if (!connectedToSelectedChain) {
        await switchChainAsync({ chainId: selectedChainId })
      }

      const data = encodeFunctionData({
        abi: maybePayStoreAbi,
        args: [tokenId],
        functionName: 'expireRedemption',
      })
      const receipt = await sendTransactionSync.mutateAsync({
        ...withSelectedFeeToken(
          {
            calls: [{ data, to: deployment.store }],
            chainId: selectedChainId,
            from: address,
          },
          deployment,
        ),
      })
      const hash = receipt.transactionHash ?? receipt.hash
      setRedemptionTransactionHash(hash)
      setStage(result ? 'resolved' : 'idle')
      await refetchLiveData()
    } catch (caught) {
      setStage(result ? 'resolved' : 'idle')
      setError(caught instanceof Error ? caught.message : 'Could not expire claim.')
    }
  }

  return (
    <main className="shell">
      <header className="siteHeader">
        <Link className="logoLink" href={`/?chainId=${selectedChainId}&rail=${selectedRailId}`}>
          Tempo Maybe Pay
        </Link>
        <div className="controls">
          <div className="networkSwitch">
            <span>Network</span>
            <div className="networkOptions" role="group" aria-label="Network">
              <Link
                aria-pressed={selectedChainId === 42431}
                className="networkButton"
                href={routeForChain(42431)}
                onClick={(event) => {
                  if (busy) {
                    event.preventDefault()
                    return
                  }
                  changeNetwork(42431)
                }}
                role="button"
                tabIndex={busy ? -1 : 0}
                data-disabled={busy || undefined}
              >
                Testnet
              </Link>
              <Link
                aria-pressed={selectedChainId === 4217}
                className="networkButton"
                href={routeForChain(4217)}
                onClick={(event) => {
                  if (busy) {
                    event.preventDefault()
                    return
                  }
                  changeNetwork(4217)
                }}
                role="button"
                tabIndex={busy ? -1 : 0}
                data-disabled={busy || undefined}
              >
                Mainnet
              </Link>
            </div>
          </div>
          <div className="networkSwitch">
            <span>Pay with</span>
            <div className="networkOptions" role="group" aria-label="Payment token">
              <Link
                aria-pressed={selectedRailId === 'pathusd'}
                className="networkButton"
                href={routeForRail('pathusd')}
                onClick={(event) => {
                  if (busy) {
                    event.preventDefault()
                    return
                  }
                  changeRail()
                }}
                role="button"
                tabIndex={busy ? -1 : 0}
                data-disabled={busy || undefined}
              >
                pathUSD
              </Link>
              <Link
                aria-pressed={selectedRailId === 'usdc'}
                className="networkButton"
                href={routeForRail('usdc')}
                onClick={(event) => {
                  if (busy) {
                    event.preventDefault()
                    return
                  }
                  changeRail()
                }}
                role="button"
                tabIndex={busy ? -1 : 0}
                data-disabled={busy || undefined}
              >
                USDC
              </Link>
            </div>
          </div>
          {isConnected && address ? (
            <button className="iconButton" type="button" onClick={() => disconnect()} disabled={busy}>
              <Wallet size={17} />
              {shortValue(address)}
            </button>
          ) : (
            <div className="connectors">
              {connectors.map((connector) => (
                <button
                  className="iconButton"
                  disabled={isConnecting}
                  key={connector.uid}
                  type="button"
                  onClick={() => {
                    const connectRequest = withConnectAccessKey(
                      { chainId: selectedChainId, connector },
                      selectedChainId,
                      selectedRailId,
                    )
                    void connectAsync(connectRequest as never)
                  }}
                >
                  <Wallet size={17} />
                  {connector.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {isCheckoutPage ? null : (
        <>
          <section className="hero">
            <div>
              <h1>Buy now. Pay maybe.</h1>
            </div>
            <p>
              Pick a product, choose your variance, and race the 1-hour cash-out window. Every NFT can be
              redeemed for 99% of its price while the house bankroll lasts.{' '}
              <span className="heroChallenge">Try to bankrupt the house!</span>
            </p>
          </section>

          <section className={`houseDashboard ${houseSolvent ? '' : 'bankrupt'}`}>
            <div className="houseLead">
              <span className="eyebrow">House bankroll</span>
              <strong>{chainReady ? formatTokenAmount(houseBankroll, tokenSymbol) : 'Not deployed'}</strong>
            </div>
            <div className="houseStats">
              <div>
                <span>Live NFT claims</span>
                <strong>{chainReady ? formatTokenAmount(outstandingLiability, tokenSymbol) : '-'}</strong>
              </div>
              <div>
                <span>Pending escrow</span>
                <strong>{chainReady ? formatTokenAmount(pendingEscrow, tokenSymbol) : '-'}</strong>
              </div>
            </div>
          </section>

          <div className="heroDivider" />
        </>
      )}

      <section className={`layout ${isCheckoutPage ? 'checkoutLayout' : 'storefrontLayout'}`}>
        <div className="catalog" id="shop">
          <div className="sectionHeader">
            <div>
              <h2>{isCheckoutPage ? product.name : 'Choose an item'}</h2>
            </div>
            <div className="sectionActions">
              {isCheckoutPage ? (
                <Link className="secondaryButton backButton" href={`/?chainId=${selectedChainId}&rail=${selectedRailId}`}>
                  <ArrowLeft size={14} />
                  Go back to store
                </Link>
              ) : null}
              <span>{isCheckoutPage ? formatTokenAmount(basePrice, tokenSymbol) : `${products.length} items available`}</span>
            </div>
          </div>
          {isCheckoutPage ? (
            <div className="checkoutProduct">
              <NftProductCard
                bankrupt={chainReady && !canUnderwrite}
                price={basePrice}
                product={product}
                redeemValue={redeemValue}
                symbol={tokenSymbol}
              />
            </div>
          ) : (
            <div className="productGrid">
              {products.map((item) => {
                const itemBasePrice = getProductPrice(item, selectedChainId)
                const itemRedeemValue = quoteRedeemValue(itemBasePrice)
                const productSolvent = !chainReady || availableReserve >= itemRedeemValue
                return (
                  <NftProductCard
                    bankrupt={!productSolvent}
                    key={item.id}
                    onClick={() => router.push(`/checkout/${item.id}?chainId=${selectedChainId}&rail=${selectedRailId}`)}
                    price={itemBasePrice}
                    product={item}
                    redeemValue={itemRedeemValue}
                    symbol={tokenSymbol}
                  />
                )
              })}
            </div>
          )}
        </div>

        {isCheckoutPage ? (
          <aside className="checkout" id="checkout">
          <div className="checkoutHeader">
            <p className="eyebrow">Maybe Pay checkout</p>
            <h2>{product.name}</h2>
            <p>{product.description}</p>
            <div className="skuLine">
              <span>{product.sku}</span>
              <span>{product.category}</span>
            </div>
          </div>

          <div className={`bankrollPanel ${canUnderwrite ? '' : 'bankrupt'}`}>
            <div>
              <Banknote size={18} />
              <span>NFT cost</span>
              <strong>{formatTokenAmount(basePrice, tokenSymbol)}</strong>
            </div>
            <div>
              <Flame size={18} />
              <span>This NFT claim</span>
              <strong>{formatTokenAmount(redeemValue, tokenSymbol)}</strong>
            </div>
            <div>
              <Clock3 size={18} />
              <span>Cash-out window</span>
              <strong>1 hour</strong>
            </div>
          </div>

          <div className="oddsPanel" style={oddsStyle}>
            <label className="sliderLabel">
              <span>Chances its free</span>
              <strong>{formatPercent(freeProbabilityBps)}</strong>
              <input
                min={0}
                max={9900}
                step={100}
                type="range"
                value={freeProbabilityBps}
                onChange={(event) => setFreeProbabilityBps(Number(event.target.value))}
                disabled={busy}
              />
            </label>

            <div className={`oddsTrack ${result ? 'resolved' : ''}`}>
              <div className="paySegment">pay</div>
              <div className="freeSegment">free</div>
              <span className="thresholdMarker" />
              {result ? (
                <span className={`rollMarker ${result.status}`} title={`Roll ${result.roll}`}>
                  {result.roll}
                </span>
              ) : null}
            </div>

            <div className="mathGrid">
              <div>
                <span>Free if roll is</span>
                <strong>{freeRollRange}</strong>
              </div>
              <div>
                <span>Pay if roll is</span>
                <strong>{paidRollRange}</strong>
              </div>
              <div>
                <span>If free</span>
                <strong>{formatTokenAmount(0n, tokenSymbol)}</strong>
              </div>
              <div>
                <span>If paid</span>
                <strong>{formatTokenAmount(maxEscrow, tokenSymbol)}</strong>
              </div>
              <div>
                <span>Expected payment</span>
                <strong>{formatTokenAmount(basePrice, tokenSymbol)}</strong>
              </div>
              <div>
                <span>NFT cash-out</span>
                <strong>{formatTokenAmount(redeemValue, tokenSymbol)}</strong>
              </div>
              <div>
                <span>Paid multiplier</span>
                <strong>{multiplier.toFixed(2)}x</strong>
              </div>
              <div>
                <span>House EV</span>
                <strong>{formatTokenAmount(basePrice - redeemValue, tokenSymbol)}</strong>
              </div>
            </div>
          </div>

          {!chainReady ? (
            <div className="notice">Checkout is not available on this network yet.</div>
          ) : null}
          {address && selectedChainId === 42431 && selectedRailId === 'pathusd' && !hasFunds ? (
            <a
              className="notice linkNotice"
              href="https://docs.tempo.xyz/quickstart/faucet"
              rel="noreferrer"
              target="_blank"
            >
              Get pathUSD <ExternalLink size={14} />
            </a>
          ) : null}
          {error ? <div className="error">{error}</div> : null}
          {!canUnderwrite && chainReady ? (
            <div className="error">The house cannot underwrite this NFT right now. Smaller items may still work.</div>
          ) : null}

          <button
            className="primaryButton"
            type="button"
            disabled={!isConnected || !chainReady || busy || !hasFunds || !canUnderwrite}
            onClick={() => void beginCheckout()}
          >
            {busy ? <RefreshCw className="spin" size={18} /> : <ShieldCheck size={18} />}
            {stage === 'epoch'
              ? 'Opening committed epoch'
              : stage === 'placing'
                ? 'Escrowing order'
                : stage === 'processing'
                  ? 'Revealing roll'
                  : stage === 'redeeming'
                    ? 'Redeeming NFT'
                    : stage === 'expiring'
                      ? 'Expiring claim'
                  : 'Place order'}
            <ArrowRight size={18} />
          </button>

          {result ? (
            <div className={`result ${result.status}`}>
              <CheckCircle2 size={20} />
              <div>
                <strong>{result.status === 'paid' ? 'Paid in full' : 'Free order - escrow returned'}</strong>
                <span>
                  Roll {result.roll} {result.status === 'paid' ? 'fell below' : 'landed at or above'} threshold{' '}
                  {result.threshold}. Item token #{result.tokenId} minted to payer
                  {result.status === 'free' ? `, and the escrowed ${tokenSymbol} was returned to their wallet.` : '.'}
                </span>
                {result.status === 'free' ? (
                  <div className="escrowReturnCallout">
                    <span>Escrow returned to wallet</span>
                    <strong>{formatTokenAmount(result.refundedAmount, tokenSymbol)}</strong>
                  </div>
                ) : null}
                <div className="receiptRows">
                  <div>
                    <span>Escrowed</span>
                    <strong>{formatTokenAmount(result.maxEscrow, tokenSymbol)}</strong>
                  </div>
                  <div>
                    <span>{result.status === 'paid' ? 'Kept by house' : 'Returned to payer'}</span>
                    <strong>
                      {formatTokenAmount(result.status === 'paid' ? result.paidAmount : result.refundedAmount, tokenSymbol)}
                    </strong>
                  </div>
                  <div>
                    <span>NFT cash-out value</span>
                    <strong>{formatTokenAmount(result.redeemValue, tokenSymbol)}</strong>
                  </div>
                  <div>
                    <span>Cash-out timer</span>
                    <strong>
                      {result.redeemActive
                        ? formatCountdown(BigInt(result.redeemDeadline), nowSeconds)
                        : 'Claim closed'}
                    </strong>
                  </div>
                  <div>
                    <span>House bankroll</span>
                    <strong>{formatTokenAmount(result.houseBankroll, tokenSymbol)}</strong>
                  </div>
                  <div>
                    <span>Live claims</span>
                    <strong>{formatTokenAmount(result.houseOutstandingLiability, tokenSymbol)}</strong>
                  </div>
                  <div>
                    <span>Epoch</span>
                    <strong>{result.epochId}</strong>
                  </div>
                  <div>
                    <span>Commitment</span>
                    <strong>{shortValue(result.commitment, 8)}</strong>
                  </div>
                  <div>
                    <span>Revealed seed</span>
                    <strong>{shortValue(result.seed, 8)}</strong>
                  </div>
                  <div>
                    <span>Token owner</span>
                    <strong>{shortValue(result.nftOwner)}</strong>
                  </div>
                </div>
                {result.redeemActive && Number(result.redeemDeadline) >= nowSeconds ? (
                  <button
                    className="secondaryButton dangerButton"
                    type="button"
                    disabled={busy}
                    onClick={() => void redeemToken(BigInt(result.tokenId))}
                  >
                    {stage === 'redeeming' ? <RefreshCw className="spin" size={16} /> : <RotateCcw size={16} />}
                    Redeem NFT for {formatTokenAmount(result.redeemValue, tokenSymbol)}
                  </button>
                ) : result.redeemActive ? (
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={busy}
                    onClick={() => void expireToken(BigInt(result.tokenId))}
                  >
                    {stage === 'expiring' ? <RefreshCw className="spin" size={16} /> : <Clock3 size={16} />}
                    Release expired claim
                  </button>
                ) : (
                  <div className="notice">This NFT claim is closed. The token remains collectible.</div>
                )}
                <div className="linkStack">
                  <a href={explorerAddressUrl(selectedChainId, result.nftOwner)} rel="noreferrer" target="_blank">
                    Wallet address <ExternalLink size={13} />
                  </a>
                  {result.merchant ? (
                    <a href={explorerAddressUrl(selectedChainId, result.merchant)} rel="noreferrer" target="_blank">
                      Merchant admin <ExternalLink size={13} />
                    </a>
                  ) : null}
                  {placeTransactionHash ? (
                    <a href={explorerTxUrl(selectedChainId, placeTransactionHash)} rel="noreferrer" target="_blank">
                      Order transaction <ExternalLink size={13} />
                    </a>
                  ) : null}
                  {result.processTransactionHash ? (
                    <a
                      href={explorerTxUrl(selectedChainId, result.processTransactionHash)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Resolution transaction <ExternalLink size={13} />
                    </a>
                  ) : null}
                  {redemptionTransactionHash ? (
                    <a
                      href={explorerTxUrl(selectedChainId, redemptionTransactionHash)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Redemption transaction <ExternalLink size={13} />
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          ) : placeTransactionHash ? (
            <a
              className="txLink"
              href={explorerTxUrl(selectedChainId, placeTransactionHash)}
              rel="noreferrer"
              target="_blank"
            >
              Order transaction <ExternalLink size={14} />
            </a>
          ) : null}

          {address && chainReady ? (
            <div className="redemptionPanel">
              <div className="redemptionHeader">
                <div>
                  <p className="eyebrow">My NFTs</p>
                  <h3>Cash-out window</h3>
                </div>
                <span>{ownedTokenIds.length} owned</span>
              </div>

              {activeClaims.length === 0 && expiredClaims.length === 0 && collectibleClaims.length === 0 ? (
                <div className="notice">No Tempo Maybe Pay NFTs in this wallet yet.</div>
              ) : null}

              {activeClaims.length > 0 ? (
                <div className="claimList">
                  {activeClaims.map((claim) => (
                    <div className="claimCard activeClaim" key={claim.tokenId.toString()}>
                      <div>
                        <strong>
                          #{claim.tokenId.toString()} {claim.productName}
                        </strong>
                        <span>{formatCountdown(claim.deadline, nowSeconds)} left</span>
                      </div>
                      <button
                        className="secondaryButton dangerButton"
                        type="button"
                        disabled={busy}
                        onClick={() => void redeemToken(claim.tokenId)}
                      >
                        {stage === 'redeeming' ? <RefreshCw className="spin" size={15} /> : <RotateCcw size={15} />}
                        Redeem {formatTokenAmount(claim.redeemValue, tokenSymbol)}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {expiredClaims.length > 0 ? (
                <div className="claimList">
                  {expiredClaims.map((claim) => (
                    <div className="claimCard expiredClaim" key={claim.tokenId.toString()}>
                      <div>
                        <strong>
                          #{claim.tokenId.toString()} {claim.productName}
                        </strong>
                        <span>Expired claim still counts until settled on-chain</span>
                      </div>
                      <button
                        className="secondaryButton"
                        type="button"
                        disabled={busy}
                        onClick={() => void expireToken(claim.tokenId)}
                      >
                        {stage === 'expiring' ? <RefreshCw className="spin" size={15} /> : <Clock3 size={15} />}
                        Release
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {collectibleClaims.length > 0 ? (
                <div className="collectibleLine">
                  {collectibleClaims.length} collectible NFT{collectibleClaims.length === 1 ? '' : 's'} with no live
                  cash-out claim.
                </div>
              ) : null}
            </div>
          ) : null}

          </aside>
        ) : null}
      </section>
    </main>
  )
}
