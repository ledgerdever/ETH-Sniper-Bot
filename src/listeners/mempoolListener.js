import { ethers } from 'ethers';
import { ADDRESSES, config } from '../config/index.js';
import { UNISWAP_V2_ROUTER_ABI } from '../config/abis.js';
import { logger } from '../utils/logger.js';

const V2_ROUTER_IFACE = new ethers.Interface(UNISWAP_V2_ROUTER_ABI);

// Function selectors we care about
const ADD_LIQUIDITY_ETH_SIG   = V2_ROUTER_IFACE.getFunction('addLiquidityETH').selector;
const ADD_LIQUIDITY_SIG       = V2_ROUTER_IFACE.getFunction('addLiquidity').selector;

export class MempoolListener {
  constructor(provider, onNewToken) {
    this.provider = provider;
    this.onNewToken = onNewToken;
    this.running = false;
    this.seen = new Set(); // dedupe
  }

  start() {
    this.running = true;
    logger.info('👂 Mempool listener started — watching for new liquidity events');

    this.provider.on('pending', async (txHash) => {
      if (!this.running) return;
      try {
        await this._handlePendingTx(txHash);
      } catch (err) {
        // Silently skip failed fetches (normal on busy mempool)
      }
    });
  }

  stop() {
    this.running = false;
    this.provider.removeAllListeners('pending');
    logger.info('Mempool listener stopped');
  }

  async _handlePendingTx(txHash) {
    if (this.seen.has(txHash)) return;
    this.seen.add(txHash);

    // Trim seen set to avoid memory leak
    if (this.seen.size > 10000) {
      const iter = this.seen.values();
      for (let i = 0; i < 5000; i++) this.seen.delete(iter.next().value);
    }

    const tx = await this.provider.getTransaction(txHash);
    if (!tx || !tx.to || !tx.data) return;

    const toAddr = tx.to.toLowerCase();

    // V2 Router
    if (toAddr === ADDRESSES.UNISWAP_V2_ROUTER.toLowerCase()) {
      const selector = tx.data.slice(0, 10);

      if (selector === ADD_LIQUIDITY_ETH_SIG) {
        const decoded = V2_ROUTER_IFACE.parseTransaction({ data: tx.data, value: tx.value });
        logger.info(`🔔 V2 addLiquidityETH detected`, {
          token: decoded.args.token,
          ethValue: ethers.formatEther(tx.value || 0n),
          txHash,
        });
        await this.onNewToken({
          type: 'v2',
          method: 'addLiquidityETH',
          tokenAddress: decoded.args.token,
          liquidityEth: parseFloat(ethers.formatEther(tx.value || 0n)),
          deployer: tx.from,
          rawTx: tx,
          decoded,
        });
      }

      else if (selector === ADD_LIQUIDITY_SIG) {
        const decoded = V2_ROUTER_IFACE.parseTransaction({ data: tx.data, value: tx.value });
        const { tokenA, tokenB } = decoded.args;
        const weth = ADDRESSES.WETH.toLowerCase();

        // Only care if one side is WETH
        const tokenAddress = tokenA.toLowerCase() === weth ? tokenB : tokenA;
        if (tokenA.toLowerCase() !== weth && tokenB.toLowerCase() !== weth) return;

        logger.info(`🔔 V2 addLiquidity (WETH pair) detected`, { tokenAddress, txHash });
        await this.onNewToken({
          type: 'v2',
          method: 'addLiquidity',
          tokenAddress,
          liquidityEth: null, // need to calculate from reserves
          deployer: tx.from,
          rawTx: tx,
          decoded,
        });
      }
    }
  }
}
