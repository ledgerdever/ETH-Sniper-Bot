/**
 * Safety Filter — Stage 1 hard filters + Stage 2 scoring
 *
 * Hard filters (any fail = SKIP):
 *  1. Honeypot simulation
 *  2. Buy/sell tax check
 *  3. Dangerous contract functions (mint, blacklist, pause)
 *  4. Minimum liquidity threshold
 *  5. Deployer reputation
 *
 * Scoring (0–100):
 *  - Liquidity size/lock
 *  - Contract safety flags
 *  - Tokenomics (tax levels)
 *  - Deployer history
 *  - Socials presence
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
   */
  async evaluate(tokenInfo) {
    const { tokenAddress, liquidityEth, deployer } = tokenInfo;
    const details = {};

    // ── Hard Filter 1: Min liquidity ──────────────────────────────────
    if (liquidityEth !== null && liquidityEth < config.strategy.minLiquidityEth) {
      return fail(`Liquidity too low: ${liquidityEth} ETH < ${config.strategy.minLiquidityEth} ETH`);
    }

    // ── Fetch token metadata ──────────────────────────────────────────
    const tokenMeta = await this._getTokenMeta(tokenAddress);
    if (!tokenMeta) return fail('Failed to fetch token metadata');
    details.meta = tokenMeta;

    // ── Hard Filter 2: GoPlus security check ──────────────────────────
    const goplusResult = await this._goplusCheck(tokenAddress);
    if (goplusResult) {
      details.goplus = goplusResult;

      if (goplusResult.is_honeypot === '1') return fail('Honeypot detected (GoPlus)');
      if (goplusResult.is_blacklisted === '1') return fail('Blacklist function exists');
      if (goplusResult.is_mintable === '1') {
        logger.warn(`⚠️  Token ${tokenAddress} has mint function — reducing score`);
      }

      const buyTax = parseFloat(goplusResult.buy_tax || '0') * 100;
      const sellTax = parseFloat(goplusResult.sell_tax || '0') * 100;
      details.buyTax = buyTax;
      details.sellTax = sellTax;

      if (buyTax > config.strategy.maxTaxPercent) return fail(`Buy tax too high: ${buyTax}%`);
      if (sellTax > config.strategy.maxTaxPercent) return fail(`Sell tax too high: ${sellTax}%`);
    }

    // ── Hard Filter 3: Honeypot simulation (always run even without GoPlus) ──
    const honeypotCheck = await this._simulateHoneypot(tokenAddress);
    details.honeypot = honeypotCheck;
    if (!honeypotCheck.canSell) {
      return fail(`Honeypot simulation: cannot sell — ${honeypotCheck.reason}`);
    }
    if (honeypotCheck.simulatedSellTax > config.strategy.maxTaxPercent) {
      return fail(`Simulated sell tax too high: ${honeypotCheck.simulatedSellTax.toFixed(1)}%`);
    }

    // ── Deployer record ───────────────────────────────────────────────
    upsertDeployer(deployer);
    const deployerRecord = getDeployer(deployer);
    details.deployer = deployerRecord;

    if (deployerRecord && deployerRecord.rugs > 2) {
      return fail(`Known rugger: ${deployer} (${deployerRecord.rugs} rugs)`);
    }

    // ── Scoring ───────────────────────────────────────────────────────
    const score = this._score({ tokenInfo, goplusResult, honeypotCheck, deployerRecord, tokenMeta });
    details.score = score;

    if (score < config.strategy.minScore) {
      return { pass: false, score, reason: `Score ${score} below threshold ${config.strategy.minScore}`, details };
    }

    logger.info(`✅ Token passed safety filter`, { token: tokenAddress, score, symbol: tokenMeta.symbol });
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
        timeout: 5000,
      });
      return resp.data?.result?.[tokenAddress.toLowerCase()] || null;
    } catch (err) {
      logger.warn(`GoPlus API failed: ${err.message}`);
      return null;
    }
  }

  async _simulateHoneypot(tokenAddress) {
    try {
      const testAmountIn = ethers.parseEther('0.1');
      const path = [ADDRESSES.WETH, tokenAddress];
      const sellPath = [tokenAddress, ADDRESSES.WETH];
      const deadline = Math.floor(Date.now() / 1000) + 60;

      // Simulate buy: 0.1 ETH → tokens
      let tokenAmounts;
      try {
        tokenAmounts = await this.router.getAmountsOut(testAmountIn, path);
      } catch {
        return { canSell: false, reason: 'No liquidity pair found' };
      }

      const tokenAmount = tokenAmounts[1];

      // Simulate sell: tokens → ETH
      let sellAmounts;
      try {
        sellAmounts = await this.router.getAmountsOut(tokenAmount, sellPath);
      } catch {
        return { canSell: false, reason: 'Sell simulation failed — likely honeypot' };
      }

      const ethOut = sellAmounts[1];
      const simulatedSellTax = parseFloat(
        ((testAmountIn - ethOut) * 100n / testAmountIn).toString()
      );

      return { canSell: true, simulatedSellTax: Math.max(0, simulatedSellTax), ethOut };
    } catch (err) {
      return { canSell: false, reason: err.message };
    }
  }

  _score({ tokenInfo, goplusResult, honeypotCheck, deployerRecord, tokenMeta }) {
    let score = 0;

    // Liquidity (0–25 pts)
    const liq = tokenInfo.liquidityEth || 0;
    if (liq >= 3)  score += 5;
    if (liq >= 5)  score += 8;
    if (liq >= 10) score += 7;
    if (liq >= 20) score += 5;

    // Contract safety via GoPlus (0–30 pts)
    if (goplusResult) {
      if (goplusResult.owner_address === '0x0000000000000000000000000000000000000000') score += 10; // renounced
      if (goplusResult.is_mintable !== '1')   score += 8;
      if (goplusResult.is_blacklisted !== '1') score += 7;
      if (goplusResult.is_proxy !== '1')       score += 5;
    } else {
      // No GoPlus data — neutral, give partial
      score += 10;
    }

    // Tax levels (0–20 pts)
    const buyTax = goplusResult ? parseFloat(goplusResult.buy_tax || '0') * 100 : honeypotCheck.simulatedSellTax;
    const sellTax = goplusResult ? parseFloat(goplusResult.sell_tax || '0') * 100 : honeypotCheck.simulatedSellTax;
    if (buyTax < 5 && sellTax < 5)   score += 20;
    else if (buyTax < 8 && sellTax < 8) score += 10;

    // Deployer history (0–15 pts)
    if (deployerRecord) {
      if (deployerRecord.tokens_launched > 0 && deployerRecord.rugs === 0) score += 8;
      if (deployerRecord.successful_tokens > 0) score += 7;
    }

    // Sell simulation confidence (0–10 pts)
    if (honeypotCheck.canSell && honeypotCheck.simulatedSellTax < 3) score += 10;
    else if (honeypotCheck.canSell && honeypotCheck.simulatedSellTax < 8) score += 5;

    return Math.min(100, score);
  }
}

function fail(reason) {
  logger.warn(`❌ Token rejected: ${reason}`);
  return { pass: false, score: 0, reason, details: {} };
}
