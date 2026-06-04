'use client'

import {
  explorerAddressUrl,
  explorerNftUrl,
  explorerTxUrl,
  formatPathUsd,
  getDeployment,
  maybePayStoreAbi,
  normalizeChainId,
  products,
  quoteMaxEscrow,
  tip20Abi,
  type ChainId,
} from '@tempo-maybe-pay/shared'
import { ArrowRight, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useState, type CSSProperties } from 'react'
import { encodeFunctionData, keccak256, stringToHex, zeroAddress, type Hex } from 'viem'
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useReadContract,
  useSendTransactionSync,
  useSwitchChain,
} from 'wagmi'

type Stage = 'idle' | 'epoch' | 'placing' | 'processing' | 'resolved'

type ProcessResult = {
  basePrice: string
  buyer: Hex
  commitment: Hex
  epochId: string
  maxEscrow: string
  merchant?: Hex
  metadataHash: Hex
  nftOwner: Hex
  orderId: Hex
  paidAmount: string
  payProbabilityBps: number
  processTransactionHash?: Hex
  productId: string
  refundedAmount: string
  roll: string
  seed: Hex
  status: 'paid' | 'free'
  threshold: string
  tokenId: string
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

function formatRawPathUsd(raw: string | bigint): string {
  return formatPathUsd(typeof raw === 'bigint' ? raw : BigInt(raw))
}

export function Shop() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const selectedChainId = normalizeChainId(searchParams.get('chainId'))
  const deployment = getDeployment(selectedChainId)
  const chainId = useChainId()
  const { address, isConnected } = useAccount()
  const { connectors, connectAsync, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain()
  const sendTransactionSync = useSendTransactionSync() as unknown as {
    mutateAsync: (args: Record<string, unknown>) => Promise<{ transactionHash?: Hex; hash?: Hex }>
    isPending: boolean
  }

  const [selectedProductId, setSelectedProductId] = useState<number>(products[0].id)
  const [payProbabilityBps, setPayProbabilityBps] = useState(5000)
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | undefined>()
  const [placeTransactionHash, setPlaceTransactionHash] = useState<Hex | undefined>()
  const [result, setResult] = useState<ProcessResult | undefined>()

  const product = products.find((item) => item.id === selectedProductId) ?? products[0]
  const maxEscrow = useMemo(
    () => quoteMaxEscrow(product.basePrice, payProbabilityBps),
    [payProbabilityBps, product.basePrice],
  )
  const multiplier = Number((maxEscrow * 100n) / product.basePrice) / 100
  const paidRollRange = `0-${payProbabilityBps - 1}`
  const freeRollRange = payProbabilityBps === 10_000 ? 'none' : `${payProbabilityBps}-9999`
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
  const hasFunds = !address || balance >= maxEscrow
  const busy = stage === 'epoch' || stage === 'placing' || stage === 'processing' || sendTransactionSync.isPending
  const roll = result ? Number(result.roll) : undefined
  const rollPercent = roll === undefined ? undefined : `${roll / 100}%`
  const oddsStyle = {
    '--pay-pct': `${payProbabilityBps / 100}%`,
    '--roll-pct': rollPercent ?? '0%',
  } as CSSProperties

  async function changeNetwork(nextChainId: ChainId) {
    router.replace(`/?chainId=${nextChainId}`)
    if (isConnected && chainId !== nextChainId) {
      await switchChainAsync({ chainId: nextChainId })
    }
  }

  async function beginCheckout() {
    if (!address) {
      setError('Connect a wallet first.')
      return
    }
    if (!deployment.store) {
      setError('Mainnet contracts are configured but not deployed yet.')
      return
    }
    if (!hasFunds) {
      setError(`Wallet needs at least ${formatPathUsd(maxEscrow)} pathUSD for this probability.`)
      return
    }

    setError(undefined)
    setResult(undefined)
    setPlaceTransactionHash(undefined)

    try {
      if (!connectedToSelectedChain) {
        await switchChainAsync({ chainId: selectedChainId })
      }

      setStage('epoch')
      const epochResponse = await fetch(`/api/epoch/ensure?chainId=${selectedChainId}`, { method: 'POST' })
      if (!epochResponse.ok) throw new Error(await epochResponse.text())

      const orderId = randomOrderId()
      const metadataHash = keccak256(
        stringToHex(
          JSON.stringify({
            buyer: address,
            chainId: selectedChainId,
            orderId,
            payProbabilityBps,
            productId: product.id,
          }),
        ),
      )

      const approveData = encodeFunctionData({
        abi: tip20Abi,
        args: [deployment.store, maxEscrow],
        functionName: 'approve',
      })
      const placeOrderData = encodeFunctionData({
        abi: maybePayStoreAbi,
        args: [orderId, BigInt(product.id), payProbabilityBps, metadataHash],
        functionName: 'placeOrder',
      })

      setStage('placing')
      const receipt = await sendTransactionSync.mutateAsync({
        calls: [
          { data: approveData, to: deployment.paymentToken },
          { data: placeOrderData, to: deployment.store },
        ],
        chainId: selectedChainId,
        feeToken: deployment.paymentToken,
      })
      const hash = receipt.transactionHash ?? receipt.hash
      setPlaceTransactionHash(hash)

      setStage('processing')
      const processResponse = await fetch(`/api/orders/${orderId}/process?chainId=${selectedChainId}`, {
        method: 'POST',
      })
      if (!processResponse.ok) throw new Error(await processResponse.text())
      const processed = (await processResponse.json()) as ProcessResult
      setResult(processed)
      setStage('resolved')
      await balanceQuery.refetch()
    } catch (caught) {
      setStage('idle')
      setError(caught instanceof Error ? caught.message : 'Checkout failed.')
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brandBlock">
          <span className="brandMark">tempo</span>
          <div>
            <p className="eyebrow">Maybe Pay merchant demo</p>
            <h1>Storefront settlement with probabilistic pathUSD.</h1>
          </div>
        </div>
        <div className="controls">
          <label className="selectLabel">
            <span>Network</span>
            <select
              value={selectedChainId}
              onChange={(event) => void changeNetwork(Number(event.target.value) as ChainId)}
              disabled={isSwitching || busy}
            >
              <option value={42431}>Tempo testnet</option>
              <option value={4217}>Tempo mainnet</option>
            </select>
          </label>
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
                  onClick={() => void connectAsync({ connector })}
                >
                  <Wallet size={17} />
                  {connector.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <section className="statusBand">
        <div>
          <span>Expected value</span>
          <strong>{formatPathUsd(product.basePrice)} pathUSD</strong>
        </div>
        <div>
          <span>Pay threshold</span>
          <strong>{payProbabilityBps} / 10000</strong>
        </div>
        <div>
          <span>Max escrow</span>
          <strong>{formatPathUsd(maxEscrow)} pathUSD</strong>
        </div>
        <div>
          <span>Mint recipient</span>
          <strong>{address ? shortValue(address) : 'Connect wallet'}</strong>
        </div>
      </section>

      <section className="layout">
        <div className="catalog">
          <div className="sectionHeader">
            <div>
              <p className="eyebrow">Merchant inventory</p>
              <h2>Choose a store item</h2>
            </div>
            <span>{products.length} NFTs available</span>
          </div>
          <div className="productGrid">
            {products.map((item) => (
              <button
                className={`productCard ${item.id === product.id ? 'selected' : ''}`}
                disabled={busy}
                key={item.id}
                onClick={() => setSelectedProductId(item.id)}
                style={{ '--accent': item.accent } as CSSProperties}
                type="button"
              >
                <img alt={item.name} src={item.image} />
                <span className="productCategory">{item.category}</span>
                <strong>{item.name}</strong>
                <em>{item.tagline}</em>
                <span className="priceLine">{formatPathUsd(item.basePrice)} pathUSD</span>
              </button>
            ))}
          </div>
        </div>

        <aside className="checkout">
          <div className="checkoutHeader">
            <p className="eyebrow">Checkout</p>
            <h2>{product.name}</h2>
            <p>{product.description}</p>
            <div className="skuLine">
              <span>{product.sku}</span>
              <span>{product.category}</span>
            </div>
          </div>

          <div className="oddsPanel" style={oddsStyle}>
            <label className="sliderLabel">
              <span>Chance you pay</span>
              <strong>{formatPercent(payProbabilityBps)}</strong>
              <input
                min={100}
                max={10000}
                step={100}
                type="range"
                value={payProbabilityBps}
                onChange={(event) => setPayProbabilityBps(Number(event.target.value))}
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
                <span>Pay if roll is</span>
                <strong>{paidRollRange}</strong>
              </div>
              <div>
                <span>Free if roll is</span>
                <strong>{freeRollRange}</strong>
              </div>
              <div>
                <span>Pay outcome</span>
                <strong>{formatPathUsd(maxEscrow)} pathUSD</strong>
              </div>
              <div>
                <span>Free outcome</span>
                <strong>0 pathUSD</strong>
              </div>
              <div>
                <span>Expected payment</span>
                <strong>{formatPathUsd(product.basePrice)} pathUSD</strong>
              </div>
              <div>
                <span>Multiplier</span>
                <strong>{multiplier.toFixed(2)}x</strong>
              </div>
            </div>
          </div>

          <div className="explainPanel">
            <div>
              <span className="stepIndex">1</span>
              <p>Epoch commitment is already on-chain before your order uses it.</p>
            </div>
            <div>
              <span className="stepIndex">2</span>
              <p>Your transaction escrows max pathUSD and writes the order ID.</p>
            </div>
            <div>
              <span className="stepIndex">3</span>
              <p>
                Processor reveals the seed; the contract rolls <code>hash(seed, order) % 10000</code>.
              </p>
            </div>
            <div>
              <span className="stepIndex">4</span>
              <p>Roll below threshold sweeps escrow to treasury. Otherwise escrow returns to you.</p>
            </div>
          </div>

          <div className="balanceLine">
            <span>Your balance</span>
            <strong>{address ? `${formatPathUsd(balance)} pathUSD` : '-'}</strong>
          </div>

          {!chainReady ? (
            <div className="notice">Mainnet contracts are ready to configure after funding and deployment.</div>
          ) : null}
          {address && selectedChainId === 42431 && !hasFunds ? (
            <a
              className="notice linkNotice"
              href="https://docs.tempo.xyz/quickstart/faucet"
              rel="noreferrer"
              target="_blank"
            >
              Get testnet pathUSD <ExternalLink size={14} />
            </a>
          ) : null}
          {error ? <div className="error">{error}</div> : null}

          <button
            className="primaryButton"
            type="button"
            disabled={!isConnected || !chainReady || busy || !hasFunds}
            onClick={() => void beginCheckout()}
          >
            {busy ? <RefreshCw className="spin" size={18} /> : <ShieldCheck size={18} />}
            {stage === 'epoch'
              ? 'Opening committed epoch'
              : stage === 'placing'
                ? 'Escrowing order'
                : stage === 'processing'
                  ? 'Revealing roll'
                  : 'Buy maybe'}
            <ArrowRight size={18} />
          </button>

          {result ? (
            <div className={`result ${result.status}`}>
              <CheckCircle2 size={20} />
              <div>
                <strong>{result.status === 'paid' ? 'Paid in full' : 'Free order'}</strong>
                <span>
                  Roll {result.roll} {result.status === 'paid' ? 'fell below' : 'landed at or above'} threshold{' '}
                  {result.threshold}. NFT #{result.tokenId} minted to payer.
                </span>
                <div className="receiptRows">
                  <div>
                    <span>Escrowed</span>
                    <strong>{formatRawPathUsd(result.maxEscrow)} pathUSD</strong>
                  </div>
                  <div>
                    <span>{result.status === 'paid' ? 'Swept to treasury' : 'Refunded'}</span>
                    <strong>
                      {formatRawPathUsd(result.status === 'paid' ? result.paidAmount : result.refundedAmount)} pathUSD
                    </strong>
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
                    <span>NFT owner</span>
                    <strong>{shortValue(result.nftOwner)}</strong>
                  </div>
                </div>
                <div className="linkStack">
                  {deployment.nft ? (
                    <a
                      href={explorerNftUrl(selectedChainId, deployment.nft, result.tokenId)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      View NFT #{result.tokenId} on Tempo Explorer <ExternalLink size={13} />
                    </a>
                  ) : null}
                  <a href={explorerAddressUrl(selectedChainId, result.nftOwner)} rel="noreferrer" target="_blank">
                    Payer address <ExternalLink size={13} />
                  </a>
                  {result.merchant ? (
                    <a href={explorerAddressUrl(selectedChainId, result.merchant)} rel="noreferrer" target="_blank">
                      Treasury address <ExternalLink size={13} />
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

          {deployment.store ? (
            <a
              className="contractLink"
              href={explorerAddressUrl(selectedChainId, deployment.store)}
              rel="noreferrer"
              target="_blank"
            >
              Store contract <ExternalLink size={13} />
            </a>
          ) : null}
        </aside>
      </section>
    </main>
  )
}
