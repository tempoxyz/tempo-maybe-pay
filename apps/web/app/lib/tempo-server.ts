import {
  getDeployment,
  maybePayNftAbi,
  maybePayStoreAbi,
  normalizeChainId,
  type ChainId,
  type Deployment,
} from '@tempo-maybe-pay/shared'
import { createClient, encodeAbiParameters, encodeFunctionData, http, keccak256, publicActions, walletActions, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo, tempoModerato } from 'viem/chains'
import { tempoActions } from 'viem/tempo'

const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

type EpochTuple = readonly [Hex, bigint, bigint, Hex, boolean]
type OrderTuple = readonly [Hex, bigint, bigint, bigint, bigint, number, Hex, number, bigint, bigint]

function getOperatorPrivateKey(): Hex {
  const key = process.env.OPERATOR_PRIVATE_KEY
  if (!key?.match(/^0x[0-9a-fA-F]{64}$/)) {
    throw new Error('OPERATOR_PRIVATE_KEY is missing or invalid')
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
    const [, , revealDeadline, orderId, revealed] = epoch
    const hasOpenSlot = orderId === zeroBytes32 && !revealed && Number(revealDeadline) > Math.floor(Date.now() / 1000) + 60
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

export async function readOrder(chainIdInput: string | number | null | undefined, orderId: Hex) {
  const deployment = getServerDeployment(chainIdInput)
  const client = getTempoClient(deployment.chainId)
  const store = deployment.store
  if (!store) throw new Error('Store is not deployed')

  const order = (await client.readContract({
    abi: maybePayStoreAbi,
    address: store,
    args: [orderId],
    functionName: 'orders',
  })) as OrderTuple

  return {
    buyer: order[0],
    productId: order[1],
    epochId: order[2],
    basePrice: order[3],
    maxEscrow: order[4],
    payProbabilityBps: order[5],
    metadataHash: order[6],
    status: order[7],
    roll: order[8],
    tokenId: order[9],
  }
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
    orderId: epoch[3],
    revealed: epoch[4],
  }
}

export async function readNftOwner(chainIdInput: string | number | null | undefined, tokenId: bigint) {
  const deployment = getServerDeployment(chainIdInput)
  if (!deployment.nft) throw new Error(`${deployment.name} NFT is not deployed yet`)

  const client = getTempoClient(deployment.chainId)
  return client.readContract({
    abi: maybePayNftAbi,
    address: deployment.nft,
    args: [tokenId],
    functionName: 'ownerOf',
  }) as Promise<Hex>
}

export function orderStatusName(status: number): 'none' | 'pending' | 'paid' | 'free' | 'refunded' {
  if (status === 1) return 'pending'
  if (status === 2) return 'paid'
  if (status === 3) return 'free'
  if (status === 4) return 'refunded'
  return 'none'
}
