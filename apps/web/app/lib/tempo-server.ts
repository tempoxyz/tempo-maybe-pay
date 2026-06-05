import {
  getDeployment,
  tip20Abi,
  maybePayNftAbi,
  maybePayStoreAbi,
  normalizeChainId,
  type ChainId,
  type Deployment,
} from '@tempo-maybe-pay/shared'
import {
  createClient,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  publicActions,
  walletActions,
  type Hex,
  type Log,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo, tempoModerato } from 'viem/chains'
import { tempoActions } from 'viem/tempo'

type EpochTuple = readonly [Hex, bigint, bigint, boolean]
type RedemptionTuple = readonly [bigint, bigint, boolean]
type TempoRpcCall = {
  to?: Hex
  input?: Hex
  data?: Hex | null
}
type TempoRpcTransaction = {
  from?: Hex
  to?: Hex | null
  input?: Hex
  data?: Hex | null
  calls?: readonly TempoRpcCall[]
}
type TempoRpcReceipt = {
  logs?: readonly Log[]
  status?: Hex | 'success' | boolean
}

const transferWithMemoEventAbi = [
  {
    type: 'event',
    name: 'TransferWithMemo',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'memo', type: 'bytes32', indexed: true },
    ],
  },
] as const

function sameAddress(left: string, right: string): boolean {
  if (!isAddress(left) || !isAddress(right)) return false
  return getAddress(left) === getAddress(right)
}

function receiptSucceeded(status: TempoRpcReceipt['status']): boolean {
  return status === '0x1' || status === 'success' || status === true
}

function receiptHasEscrowTransfer({
  buyer,
  deployment,
  maxEscrow,
  orderId,
  receipt,
}: {
  buyer: Hex
  deployment: Deployment
  maxEscrow: bigint
  orderId: Hex
  receipt: TempoRpcReceipt
}): boolean {
  if (!deployment.store) return false

  for (const log of receipt.logs ?? []) {
    if (!sameAddress(log.address, deployment.paymentToken)) continue

    try {
      const decoded = decodeEventLog({
        abi: transferWithMemoEventAbi,
        data: log.data,
        topics: log.topics,
      })
      if (decoded.eventName !== 'TransferWithMemo') continue

      const args = decoded.args
      if (
        sameAddress(args.from, buyer) &&
        sameAddress(args.to, deployment.store) &&
        args.amount === maxEscrow &&
        args.memo.toLowerCase() === orderId.toLowerCase()
      ) {
        return true
      }
    } catch {
      continue
    }
  }

  return false
}

function transactionCallsEscrow({
  deployment,
  maxEscrow,
  orderId,
  transaction,
}: {
  deployment: Deployment
  maxEscrow: bigint
  orderId: Hex
  transaction: TempoRpcTransaction
}): boolean {
  if (!deployment.store) return false

  const calls =
    transaction.calls && transaction.calls.length > 0
      ? transaction.calls
      : [{ to: transaction.to ?? undefined, input: transaction.input ?? transaction.data ?? undefined }]

  for (const call of calls) {
    const data = call.input ?? call.data ?? undefined
    if (!call.to || !data || !sameAddress(call.to, deployment.paymentToken)) continue

    try {
      const decoded = decodeFunctionData({ abi: tip20Abi, data })
      if (decoded.functionName !== 'transferWithMemo') continue

      const [to, amount, memo] = decoded.args
      if (
        sameAddress(to, deployment.store) &&
        amount === maxEscrow &&
        String(memo).toLowerCase() === orderId.toLowerCase()
      ) {
        return true
      }
    } catch {
      continue
    }
  }

  return false
}

function getOperatorPrivateKey(): Hex {
  const key = process.env.MAYBEPAY_PROCESSOR_PRIVATE_KEY ?? process.env.OPERATOR_PRIVATE_KEY
  if (!key?.match(/^0x[0-9a-fA-F]{64}$/)) {
    throw new Error('MAYBEPAY_PROCESSOR_PRIVATE_KEY is missing or invalid')
  }
  return key as Hex
}

function getSeedSecret(): Hex {
  const secret = process.env.MAYBEPAY_SEED_SECRET
  if (!secret?.match(/^0x[0-9a-fA-F]{64}$/)) {
    throw new Error('MAYBEPAY_SEED_SECRET is missing or invalid')
  }
  return secret as Hex
}

export function getServerDeployment(chainIdInput: string | number | null | undefined): Deployment {
  const deployment = getDeployment(chainIdInput)
  if (!deployment.store) throw new Error(`${deployment.name} store is not deployed yet`)
  return deployment
}

export function getTempoClient(chainIdInput: string | number | null | undefined) {
  const chainId = normalizeChainId(chainIdInput)
  const deployment = getServerDeployment(chainId)
  const chain = chainId === 4217 ? tempo : tempoModerato
  const rpcUrl =
    chainId === 4217
      ? (process.env.TEMPO_MAINNET_RPC_URL ?? deployment.rpcUrl)
      : (process.env.TEMPO_TESTNET_RPC_URL ?? deployment.rpcUrl)

  return createClient({
    account: privateKeyToAccount(getOperatorPrivateKey()),
    chain: {
      ...chain,
      rpcUrls: {
        default: { http: [rpcUrl], webSocket: [deployment.wsUrl] },
      },
    },
    transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }),
  })
    .extend(publicActions)
    .extend(walletActions)
    .extend(tempoActions())
}

export async function verifyEscrowPayment({
  buyer,
  chainId,
  maxEscrow,
  orderId,
  paymentTransactionHash,
}: {
  buyer: Hex
  chainId: ChainId
  maxEscrow: bigint
  orderId: Hex
  paymentTransactionHash: Hex
}) {
  const deployment = getServerDeployment(chainId)
  if (!deployment.store) throw new Error('Store is not deployed')
  if (!isHex(paymentTransactionHash, { strict: true }) || paymentTransactionHash.length !== 66) {
    throw new Error('Invalid payment transaction hash')
  }

  const client = getTempoClient(chainId)
  const [transaction, receipt] = await Promise.all([
    client.request({
      method: 'eth_getTransactionByHash',
      params: [paymentTransactionHash],
    }) as Promise<TempoRpcTransaction | null>,
    client.request({
      method: 'eth_getTransactionReceipt',
      params: [paymentTransactionHash],
    }) as Promise<TempoRpcReceipt | null>,
  ])

  if (!transaction || !receipt) throw new Error('Payment transaction was not found')
  if (!receiptSucceeded(receipt.status)) throw new Error('Payment transaction did not succeed')
  if (receiptHasEscrowTransfer({ buyer, deployment, maxEscrow, orderId, receipt })) {
    return
  }

  if (!transaction.from || !sameAddress(transaction.from, buyer)) {
    throw new Error('Payment transaction was not sent by the buyer wallet')
  }
  if (transactionCallsEscrow({ deployment, maxEscrow, orderId, transaction })) {
    return
  }

  throw new Error('Payment transaction did not escrow the expected pathUSD with the order memo')
}

export function deriveEpochSeed(deployment: Deployment, epochId: bigint): Hex {
  if (!deployment.store) throw new Error('Store is not deployed')
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'secret', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
        { name: 'store', type: 'address' },
        { name: 'epochId', type: 'uint256' },
      ],
      [getSeedSecret(), BigInt(deployment.chainId), deployment.store, epochId],
    ),
  )
}

export function commitmentForSeed(seed: Hex): Hex {
  return keccak256(seed)
}

export async function ensureEpoch(chainIdInput: string | number | null | undefined) {
  const deployment = getServerDeployment(chainIdInput)
  const client = getTempoClient(deployment.chainId)
  const store = deployment.store
  if (!store) throw new Error('Store is not deployed')

  const currentEpochId = (await client.readContract({
    abi: maybePayStoreAbi,
    address: store,
    functionName: 'currentEpochId',
  })) as bigint

  if (currentEpochId > 0n) {
    const epoch = (await client.readContract({
      abi: maybePayStoreAbi,
      address: store,
      args: [currentEpochId],
      functionName: 'epochs',
    })) as EpochTuple
    const [, , revealDeadline, revealed] = epoch
    const hasOpenSlot = !revealed && Number(revealDeadline) > Math.floor(Date.now() / 1000) + 60
    if (hasOpenSlot) {
      return { epochId: currentEpochId.toString(), opened: false }
    }
  }

  const nextEpochId = currentEpochId + 1n
  const seed = deriveEpochSeed(deployment, nextEpochId)
  const commitment = commitmentForSeed(seed)
  const revealDeadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60)
  const data = encodeFunctionData({
    abi: maybePayStoreAbi,
    args: [commitment, revealDeadline],
    functionName: 'openEpoch',
  })

  const receipt = await client.sendTransactionSync({
    calls: [{ data, to: store }],
    feeToken: deployment.paymentToken,
  } as never)

  return {
    epochId: nextEpochId.toString(),
    opened: true,
    transactionHash: receipt.transactionHash as Hex,
  }
}

export async function readCurrentEpochId(chainIdInput: string | number | null | undefined) {
  const deployment = getServerDeployment(chainIdInput)
  const client = getTempoClient(deployment.chainId)
  const store = deployment.store
  if (!store) throw new Error('Store is not deployed')

  return client.readContract({
    abi: maybePayStoreAbi,
    address: store,
    functionName: 'currentEpochId',
  }) as Promise<bigint>
}

export async function readProcessedOrder(chainIdInput: string | number | null | undefined, orderId: Hex) {
  const deployment = getServerDeployment(chainIdInput)
  const client = getTempoClient(deployment.chainId)
  const store = deployment.store
  if (!store) throw new Error('Store is not deployed')

  return client.readContract({
    abi: maybePayStoreAbi,
    address: store,
    args: [orderId],
    functionName: 'processedOrders',
  }) as Promise<boolean>
}

export async function readEpoch(chainIdInput: string | number | null | undefined, epochId: bigint) {
  const deployment = getServerDeployment(chainIdInput)
  const client = getTempoClient(deployment.chainId)
  const store = deployment.store
  if (!store) throw new Error('Store is not deployed')

  const epoch = (await client.readContract({
    abi: maybePayStoreAbi,
    address: store,
    args: [epochId],
    functionName: 'epochs',
  })) as EpochTuple

  return {
    commitment: epoch[0],
    openedAt: epoch[1],
    revealDeadline: epoch[2],
    orderId: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
    revealed: epoch[3],
  }
}

export async function readNftOwner(chainIdInput: string | number | null | undefined, tokenId: bigint) {
  const deployment = getServerDeployment(chainIdInput)
  if (!deployment.nft) throw new Error(`${deployment.name} item token contract is not deployed yet`)

  const client = getTempoClient(deployment.chainId)
  return client.readContract({
    abi: maybePayNftAbi,
    address: deployment.nft,
    args: [tokenId],
    functionName: 'ownerOf',
  }) as Promise<Hex>
}

export async function readRedemption(chainIdInput: string | number | null | undefined, tokenId: bigint) {
  const deployment = getServerDeployment(chainIdInput)
  const client = getTempoClient(deployment.chainId)
  const store = deployment.store
  if (!store) throw new Error('Store is not deployed')

  const redemption = (await client.readContract({
    abi: maybePayStoreAbi,
    address: store,
    args: [tokenId],
    functionName: 'redemptions',
  })) as RedemptionTuple

  return {
    value: redemption[0],
    deadline: redemption[1],
    active: redemption[2],
  }
}

export async function readHouseStats(chainIdInput: string | number | null | undefined) {
  const deployment = getServerDeployment(chainIdInput)
  const client = getTempoClient(deployment.chainId)
  const store = deployment.store
  if (!store) throw new Error('Store is not deployed')

  const [bankroll, availableReserve, outstandingLiability, pendingEscrow] = await Promise.all([
    client.readContract({
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ type: 'uint256' }],
        },
      ],
      address: deployment.paymentToken,
      args: [store],
      functionName: 'balanceOf',
    }) as Promise<bigint>,
    client.readContract({
      abi: maybePayStoreAbi,
      address: store,
      functionName: 'availableHouseReserve',
    }) as Promise<bigint>,
    client.readContract({
      abi: maybePayStoreAbi,
      address: store,
      functionName: 'outstandingRedemptionLiability',
    }) as Promise<bigint>,
    client.readContract({
      abi: maybePayStoreAbi,
      address: store,
      functionName: 'pendingEscrowTotal',
    }) as Promise<bigint>,
  ])

  return {
    availableReserve,
    bankroll,
    outstandingLiability,
    pendingEscrow,
  }
}
