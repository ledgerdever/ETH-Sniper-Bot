import { ethers } from 'ethers';
import { ADDRESSES, config } from '../config/index.js';
import { UNISWAP_V2_ROUTER_ABI } from '../config/abis.js';
import { logger } from '../utils/logger.js';

const V2_ROUTER_IFACE = new ethers.Interface(UNISWAP_V2_ROUTER_ABI);
const ROUTER_ADDRESS = ADDRESSES.UNISWAP_V2_ROUTER.toLowerCase();

/**
 * TxPoolListener
 * Polls txpool_content on an interval (default 200ms) and forwards
 * new Uniswap Router addLiquidity transactions to the handler.
 */
export class TxPoolListener {
  constructor(provider, onNewToken, options = {}) {
    this.provider = provider;
    this.onNewToken = onNewToken;
    this.intervalMs = options.intervalMs || 200;
    this.maxSeen = options.maxSeen || 20000;
    this.running = false;
    this.timer = null;
    this.seen = new Map(); // txHash → timestamp
  }

  start() {
    if (this.running) return;
    this.running = true;
    logger.info(
      `🕸️  TxPool listener started (interval=${this.intervalMs}ms, maxSeen=${this.maxSeen})`
    );
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info('TxPool listener stopped');
  }

  async _loop() {
    if (!this.running) return;
    const started = Date.now();

    try {
      await this._poll();
    } catch (err) {
      logger.warn(`txpool_content poll failed: ${err.message}`);
    }

    const elapsed = Date.now() - started;
    const delay = Math.max(50, this.intervalMs - elapsed);
    this.timer = setTimeout(() => this._loop(), delay);
  }

  async _poll() {
    const result = await this.provider.send('txpool_content', []);
    if (!result) return;

    const txs = [
      ...this._flatten(result.pending || {}),
      ...this._flatten(result.queued || {}),
    ];

    for (const tx of txs) {
      this._handleTx(tx);
    }
  }

  _flatten(tree) {
    const arr = [];
    for (const from of Object.keys(tree)) {
      const nonces = tree[from];
      for (const nonce of Object.keys(nonces)) {
        const tx = nonces[nonce];
        if (tx) arr.push(tx);
      }
    }
    return arr;
  }

  _handleTx(tx) {
    const hash = tx?.hash?.toLowerCase();
    if (!hash || this.seen.has(hash)) return;
    this._remember(hash);

    if (!tx.to) return;
    if (tx.to.toLowerCase() !== ROUTER_ADDRESS) return;
    if (!tx.input || tx.input.length < 10) return;

    const selector = tx.input.slice(0, 10);
    if (selector !== this._selector('addLiquidityETH') && selector !== this._selector('addLiquidity')) {
      return;
    }

    let decoded;
    try {
      decoded = V2_ROUTER_IFACE.parseTransaction({
        data: tx.input,
        value: tx.value ? BigInt(tx.value) : 0n,
      });
    } catch (err) {
      logger.debug(`Failed to decode router tx ${hash}: ${err.message}`);
      return;
    }

    if (decoded?.name === 'addLiquidityETH') {
      const tokenAddress = decoded.args.token;
      const liquidityEth = parseFloat(ethers.formatEther(tx.value || '0x0'));
      this._emitToken({
        type: 'v2',
        method: 'addLiquidityETH',
        tokenAddress,
        liquidityEth,
        deployer: tx.from,
        rawTx: { hash: tx.hash },
        decoded,
      });
    }

    if (decoded?.name === 'addLiquidity') {
      const { tokenA, tokenB } = decoded.args;
      const weth = ADDRESSES.WETH.toLowerCase();
      const tokenAddress = tokenA.toLowerCase() === weth ? tokenB : tokenA;
      if (tokenA.toLowerCase() !== weth && tokenB.toLowerCase() !== weth) return;

      this._emitToken({
        type: 'v2',
        method: 'addLiquidity',
        tokenAddress,
        liquidityEth: null,
        deployer: tx.from,
        rawTx: { hash: tx.hash },
        decoded,
      });
    }
  }

  _emitToken(info) {
    try {
      this.onNewToken(info);
    } catch (err) {
      logger.error(`Error in TxPool listener handler: ${err.message}`);
    }
  }

  _remember(hash) {
    this.seen.set(hash, Date.now());
    if (this.seen.size > this.maxSeen) {
      const oldestKey = this.seen.keys().next().value;
      this.seen.delete(oldestKey);
    }
  }

  _selector(name) {
    return V2_ROUTER_IFACE.getFunction(name).selector;
  }
}
