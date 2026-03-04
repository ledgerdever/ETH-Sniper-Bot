import 'dotenv/config';

export const config = {
  rpc: {
    wss: process.env.RPC_WSS,
    https: process.env.RPC_HTTPS,
  },
  wallet: {
    privateKey: process.env.PRIVATE_KEY,
  },
  flashbots: {
    relayUrl: process.env.FLASHBOTS_RELAY_URL || 'https://relay.flashbots.net',
    authKey: process.env.FLASHBOTS_AUTH_KEY,
  },
  goplus: {
    apiKey: process.env.GOPLUS_API_KEY,
  },
  strategy: {
    minLiquidityEth: parseFloat(process.env.MIN_LIQUIDITY_ETH || '3'),
    buyAmountEth: parseFloat(process.env.BUY_AMOUNT_ETH || '0.05'),
    minScore: parseInt(process.env.MIN_SCORE || '55'),
    takeProfitMultiplier: parseFloat(process.env.TAKE_PROFIT_MULTIPLIER || '3'),
    stopLossMultiplier: parseFloat(process.env.STOP_LOSS_MULTIPLIER || '0.7'),
    tier2Multiplier: parseFloat(process.env.TIER2_MULTIPLIER || '5'),
    tier3Multiplier: parseFloat(process.env.TIER3_MULTIPLIER || '10'),
    maxTaxPercent: parseFloat(process.env.MAX_TAX_PERCENT || '10'),
    maxHoldSeconds: parseInt(process.env.MAX_HOLD_SECONDS || '300'),
  },
  dryRun: process.env.DRY_RUN === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Uniswap addresses (mainnet)
export const ADDRESSES = {
  UNISWAP_V2_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  UNISWAP_V2_FACTORY: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  UNISWAP_V3_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  UNISWAP_V3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
};
