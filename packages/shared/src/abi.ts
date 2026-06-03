export const maybePayStoreAbi = [
  {
    type: 'function',
    name: 'currentEpochId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'epochs',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint256' }],
    outputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'openedAt', type: 'uint64' },
      { name: 'revealDeadline', type: 'uint64' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'revealed', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'orders',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'bytes32' }],
    outputs: [
      { name: 'buyer', type: 'address' },
      { name: 'productId', type: 'uint256' },
      { name: 'epochId', type: 'uint256' },
      { name: 'basePrice', type: 'uint256' },
      { name: 'maxEscrow', type: 'uint256' },
      { name: 'payProbabilityBps', type: 'uint16' },
      { name: 'metadataHash', type: 'bytes32' },
      { name: 'status', type: 'uint8' },
      { name: 'roll', type: 'uint256' },
      { name: 'tokenId', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'quoteMaxEscrow',
    stateMutability: 'view',
    inputs: [
      { name: 'productId', type: 'uint256' },
      { name: 'payProbabilityBps', type: 'uint16' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'openEpoch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'revealDeadline', type: 'uint64' },
    ],
    outputs: [{ name: 'epochId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'placeOrder',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderId', type: 'bytes32' },
      { name: 'productId', type: 'uint256' },
      { name: 'payProbabilityBps', type: 'uint16' },
      { name: 'metadataHash', type: 'bytes32' },
    ],
    outputs: [{ name: 'maxEscrow', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'processOrder',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderId', type: 'bytes32' },
      { name: 'seed', type: 'bytes32' },
    ],
    outputs: [
      { name: 'paid', type: 'bool' },
      { name: 'tokenId', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'OrderResolved',
    inputs: [
      { name: 'orderId', type: 'bytes32', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'status', type: 'uint8' },
      { name: 'roll', type: 'uint256' },
      { name: 'paidAmount', type: 'uint256' },
      { name: 'refundedAmount', type: 'uint256' },
    ],
  },
] as const

export const tip20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export const maybePayNftAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
] as const

