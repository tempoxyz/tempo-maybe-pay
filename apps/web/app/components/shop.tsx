'use client'

import {
  explorerAddressUrl,
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
import { useMemo, useState } from 'react'
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
  orderId: Hex
  status: 'paid' | 'free'
  roll: string
  tokenId: string
  processTransactionHash?: Hex
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function randomOrderId(): Hex {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
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
  const freeProbability = 10_000 - payProbabilityBps
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
    } catch (caught) {
      setStage('idle')
      setError(caught instanceof Error ? caught.message : 'Checkout failed.')
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Tempo · Maybe Pay</p>
          <h1>Buy now, pay maybe</h1>
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
              {shortAddress(address)}
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
          <span>Base price</span>
          <strong>{formatPathUsd(product.basePrice)} pathUSD</strong>
        </div>
        <div>
          <span>Chance free</span>
          <strong>{(freeProbability / 100).toFixed(0)}%</strong>
        </div>
        <div>
          <span>Max escrow</span>
          <strong>{formatPathUsd(maxEscrow)} pathUSD</strong>
        </div>
        <div>
          <span>Expected payment</span>
          <strong>{formatPathUsd(product.basePrice)} pathUSD</strong>
        </div>
      </section>

      <section className="layout">
        <div className="productGrid">
          {products.map((item) => (
            <button
              className={`productCard ${item.id === product.id ? 'selected' : ''}`}
              key={item.id}
              onClick={() => setSelectedProductId(item.id)}
              style={{ '--accent': item.accent } as React.CSSProperties}
              type="button"
            >
              <img alt="" src={item.image} />
              <span>{item.name}</span>
              <em>{item.tagline}</em>
              <strong>{formatPathUsd(item.basePrice)} pathUSD</strong>
            </button>
          ))}
        </div>

        <aside className="checkout">
          <img className="largeArt" alt="" src={product.image} />
          <div>
            <p className="eyebrow">Selected NFT</p>
            <h2>{product.name}</h2>
            <p>{product.description}</p>
          </div>

          <label className="sliderLabel">
            <span>Chance you pay: {(payProbabilityBps / 100).toFixed(0)}%</span>
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

          <div className="mathRows">
            <div>
              <span>Pay outcome</span>
              <strong>{formatPathUsd(maxEscrow)} pathUSD</strong>
            </div>
            <div>
              <span>Free outcome</span>
              <strong>0 pathUSD</strong>
            </div>
            <div>
              <span>Your balance</span>
              <strong>{address ? `${formatPathUsd(balance)} pathUSD` : '-'}</strong>
            </div>
          </div>

          {!chainReady ? (
            <div className="notice">Mainnet addresses are ready to configure after funding and deployment.</div>
          ) : null}
          {address && selectedChainId === 42431 && !hasFunds ? (
            <a className="notice linkNotice" href="https://docs.tempo.xyz/quickstart/faucet" target="_blank">
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
              ? 'Committing odds'
              : stage === 'placing'
                ? 'Escrowing order'
                : stage === 'processing'
                  ? 'Resolving order'
                  : 'Buy maybe'}
            <ArrowRight size={18} />
          </button>

          {placeTransactionHash ? (
            <a className="txLink" href={explorerTxUrl(selectedChainId, placeTransactionHash)} target="_blank">
              Order transaction <ExternalLink size={14} />
            </a>
          ) : null}

          {result ? (
            <div className={`result ${result.status}`}>
              <CheckCircle2 size={20} />
              <div>
                <strong>{result.status === 'paid' ? 'Paid in full' : 'Free order'}</strong>
                <span>
                  NFT #{result.tokenId} minted · roll {result.roll}/10000
                </span>
                {result.processTransactionHash ? (
                  <a href={explorerTxUrl(selectedChainId, result.processTransactionHash)} target="_blank">
                    Resolution transaction <ExternalLink size={13} />
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}

          {deployment.store ? (
            <a className="contractLink" href={explorerAddressUrl(selectedChainId, deployment.store)} target="_blank">
              Store contract <ExternalLink size={13} />
            </a>
          ) : null}
        </aside>
      </section>
    </main>
  )
}
