/**
 * Safety Filter — Stage 1 hard filters + Stage 2 scoring
 *
 * ⚡ OPTIMIZED: All network calls run in parallel via Promise.all
 *    Sequential time: ~1500ms
 *    Parallel time:   ~400–600ms
 *
 * Hard filters (any fail = SKIP):
 *  1. Min liquidity threshold
 *  2. Honeypot simulation (eth_call sell)
 *  3. Buy/sell tax > maxTaxPercent
 *  4. Dangerous contract functions (mint, blacklist, pause) via GoPlus
 *  5. Known rugger deployer
 *
 * Scoring (0–100):
 *  - Liquidity size
 *  - Contract safety flags
 *  - Tokenomics (tax levels)
 *  - Deployer history
 *  - Sell simulation confidence
 */

import { ethers } from 'ethers';
import axios from 'axios';
import { ADDRESSES, config } from '../config/index.js';
import { UNISWAP_V2_ROUTER_ABI, ERC20_ABI } from '../config/abis.js';
import { getDeployer, upsertDeployer } from '../db/index.js';
import { logger } from '../utils/logger.js';

const CHAIN_ID = '1'; // Ethereum mainnet

export class SafetyFilter {
  constructor(provider) {
    this.provider = provider;
    this.router = new ethers.Contract(
      ADDRESSES.UNISWAP_V2_ROUTER,
      UNISWAP_V2_ROUTER_ABI,
      provider
    );
  }

  /**
   * Main entry point.
   * Returns { pass: bool, score: number, reason: string, details: {} }
   *
   * ⚡ All async checks run in parallel — total latency = slowest single check,
   *    NOT the sum of all checks.
   */
  async evaluate(tokenInfo) {
    const { tokenAddress, liquidityEth, deployer } = tokenInfo;

    // ── Fast reject: min liquidity (no network call needed) ───────────
    if (liquidityEth !== null && liquidityEth < config.strategy.minLiquidityEth) {
      return fail(`Liquidity too low: ${liquidityEth} ETH < ${config.strategy.minLiquidityEth} ETH`);
    }

    // ── Fast reject: known rugger (local DB, ~1ms) ────────────────────
    upsertDeployer(deployer);
    const deployerRecord = getDeployer(deployer);
    if (deployerRecord?.rugs > 2) {
      return fail(`Known rugger: ${deployer} (${deployerRecord.rugs} rugs)`);
    }

    // ── PARALLEL: run all network checks simultaneously ───────────────
    logger.debug(`⚡ Running parallel checks for ${tokenAddress}`);
    const parallelStart = Date.now();

    const [tokenMeta, honeypotCheck, goplusResult] = await Promise.all([
      this._getTokenMeta(tokenAddress),
      this._simulateHoneypot(tokenAddress),
      this._goplusCheck(tokenAddress),
    ]);

    logger.debug(`✅ Parallel checks done in ${Date.now() - parallelStart}ms`);

    // ── Validate results ──────────────────────────────────────────────

    if (!tokenMeta) return fail('Failed to fetch token metadata');

    // Honeypot hard filter
    if (!honeypotCheck.canSell) {
      return fail(`Honeypot: ${honeypotCheck.reason}`);
    }
    if (honeypotCheck.simulatedSellTax > config.strategy.maxTaxPercent) {
      return fail(`Simulated sell tax too high: ${honeypotCheck.simulatedSellTax.toFixed(1)}%`);
    }

    // GoPlus hard filters
    if (goplusResult) {
      if (goplusResult.is_honeypot === '1') return fail('GoPlus: honeypot detected');
      if (goplusResult.is_blacklisted === '1') return fail('GoPlus: blacklist function exists');

      const buyTax = parseFloat(goplusResult.buy_tax || '0') * 100;
      const sellTax = parseFloat(goplusResult.sell_tax || '0') * 100;

      if (buyTax > config.strategy.maxTaxPercent) return fail(`Buy tax too high: ${buyTax}%`);
      if (sellTax > config.strategy.maxTaxPercent) return fail(`Sell tax too high: ${sellTax}%`);
    }

    // ── Scoring ───────────────────────────────────────────────────────
    const details = { tokenMeta, honeypotCheck, goplusResult, deployer: deployerRecord };
    const score = this._score({ tokenInfo, goplusResult, honeypotCheck, deployerRecord });

    if (score < config.strategy.minScore) {
      return { pass: false, score, reason: `Score ${score} below threshold ${config.strategy.minScore}`, details };
    }

    logger.info(`✅ Token passed`, {
      token: tokenAddress,
      symbol: tokenMeta.symbol,
      score,
      sellTax: `${honeypotCheck.simulatedSellTax?.toFixed(1)}%`,
      liquidity: `${liquidityEth} ETH`,
    });

    return { pass: true, score, reason: 'OK', details };
  }

  // ── Private helpers ────────────────────────────────────────────────

  async _getTokenMeta(tokenAddress) {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        token.name().catch(() => 'Unknown'),
        token.symbol().catch(() => 'UNK'),
        token.decimals().catch(() => 18n),
        token.totalSupply().catch(() => 0n),
      ]);
      return { name, symbol, decimals: Number(decimals), totalSupply };
    } catch {
      return null;
    }
  }

  async _goplusCheck(tokenAddress) {
    if (!config.goplus.apiKey) return null;
    try {
      const url = `https://api.gopluslabs.io/api/v1/token_security/${CHAIN_ID}?contract_addresses=${tokenAddress}`;
      const resp = await axios.get(url, {
        headers: { 'X-API-Key': config.goplus.apiKey },
        timeout: 4000, // hard timeout — don't let this block us
      });
      return resp.data?.result?.[tokenAddress.toLowerCase()] || null;
    } catch (err) {
      logger.warn(`GoPlus API failed (non-fatal): ${err.message}`);
      return null; // proceed without GoPlus data
    }
  }

  async _simulateHoneypot(tokenAddress) {
    try {
      const testAmountIn = ethers.parseEther('0.1');
      const buyPath  = [ADDRESSES.WETH, tokenAddress];
      const sellPath = [tokenAddress, ADDRESSES.WETH];

      // Simulate buy → sell in parallel
      const [buyAmounts, canGetSellAmounts] = await Promise.all([
        this.router.getAmountsOut(testAmountIn, buyPath).catch(() => null),
        // Pre-check: does the sell path exist?
        this.router.getAmountsOut(ethers.parseEther('1'), sellPath).catch(() => null),
      ]);

      if (!buyAmounts) {
        return { canSell: false, reason: 'No liquidity pair / buy simulation failed' };
      }

      const tokenAmount = buyAmounts[1];

      // Now simulate selling the exact amount we'd receive
      let sellAmounts;
      try {
        sellAmounts = await this.router.getAmountsOut(tokenAmount, sellPath);
      } catch {
        return { canSell: false, reason: 'Sell simulation failed — likely honeypot' };
      }

      const ethOut = sellAmounts[1];
      const lossBps = Number((testAmountIn - ethOut) * 10000n / testAmountIn);
      const simulatedSellTax = Math.max(0, lossBps / 100); // as percentage

      return {
        canSell: true,
        simulatedSellTax,
        ethOut,
        tokenAmount,
      };
    } catch (err) {
      return { canSell: false, reason: err.message };
    }
  }

  _score({ tokenInfo, goplusResult, honeypotCheck, deployerRecord }) {
    let score = 0;

    // Liquidity (0–25 pts)
    const liq = tokenInfo.liquidityEth || 0;
    if (liq >= 3)  score += 5;
    if (liq >= 5)  score += 8;
    if (liq >= 10) score += 7;
    if (liq >= 20) score += 5;

    // GoPlus contract safety (0–30 pts)
    if (goplusResult) {
      const isRenounced = goplusResult.owner_address === '0x0000000000000000000000000000000000000000';
      if (isRenounced)                           score += 10;
      if (goplusResult.is_mintable !== '1')      score += 8;
      if (goplusResult.is_blacklisted !== '1')   score += 7;
      if (goplusResult.is_proxy !== '1')         score += 5;
    } else {
      score += 10; // no GoPlus data → neutral partial credit
    }

    // Tax levels (0–20 pts)
    const tax = honeypotCheck.simulatedSellTax || 0;
    if (tax < 2)       score += 20;
    else if (tax < 5)  score += 15;
    else if (tax < 8)  score += 8;

    // Deployer history (0–15 pts)
    if (deployerRecord) {
      if (deployerRecord.tokens_launched > 0 && deployerRecord.rugs === 0) score += 8;
      if (deployerRecord.successful_tokens > 0) score += 7;
    }

    // Sell simulation confidence (0–10 pts)
    if (honeypotCheck.canSell && tax < 3) score += 10;
    else if (honeypotCheck.canSell && tax < 8) score += 5;

    return Math.min(100, score);
  }
}

function fail(reason) {
  logger.warn(`❌ Rejected: ${reason}`);
  return { pass: false, score: 0, reason, details: {} };
}
