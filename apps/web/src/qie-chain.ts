export const qieMainnet = {
  id: 1990,
  name: 'QIE Mainnet',
  nativeCurrency: { name: 'QIE', symbol: 'QIEV3', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc1mainnet.qie.digital/'] } },
  blockExplorers: { default: { name: 'QIE Explorer', url: 'https://mainnet.qie.digital/' } },
} as const;
