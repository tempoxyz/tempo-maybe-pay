export type NetworkFeeDeployment = {
  chainId: 4217 | 42431
  paymentToken: `0x${string}`
}

export function withNetworkFees(
  args: Record<string, unknown>,
  deployment: NetworkFeeDeployment,
): Record<string, unknown> {
  if (deployment.chainId === 42431) return { ...args, feePayer: true }
  return { ...args, feePayer: false, feeToken: deployment.paymentToken }
}
