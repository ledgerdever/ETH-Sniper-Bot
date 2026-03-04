/**
 * Sell Manager — monitors open positions and executes sell strategy
 *
 * Strategy: Tiered exit
 *   - Tier 1: Sell 30% at 2x  (recover capital + profit)
 *   - Tier 2: Sell 40% at 5x  (major profit)
 *   - Tier 3: Sell 30% at 10x (moonbag)
 *
 * Stop loss:
 *   - Hard stop: -30% from buy
 *   - Time stop: if no 2x within maxHoldSeconds → sell all at market
 *
 * Trailing stop (after tier 1 hit):
 *   - Trail 30% below peak price
 */

import { ethers } from 'ethers';
import { ADDRESSES, config } from '../config/index.js';
import { UNISWAP_V2_ROUTER_ABI, ERC20_ABI } from '../config/abis.js';
import { closeTrade, markDeployerRug, markDeployerSuccess } from '../db/index.js';
import { logger } from '../utils/logger.js';

const POLL_INTERVAL_MS = 2000;

export class SellManager {
  constructor(provider, wallet) {
    this.provider = provider;
    this.wallet = wallet;
    this.router = new ethers.Contract(ADDRESSES.UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, wallet);
    this.positions = new Map(); // tokenAddress → position
  }

  /**
   * Start tracking a new position after a successful buy
   */
  track(tokenAddress, { tokensReceived, ethIn, buyPrice, buyBlock, deployer, tradeId }) {
    if (this.positions.has(tokenAddress)) return;

    const position = {
      tokenAddress,
      tokensReceived,
      ethIn,
      buyPrice,
      buyBlock,
      deployer,
      tradeId,
      tier1Sold: false,
      tier2Sold: false,
      peakPrice: buyPrice,
      buyTime: Date.now(),
      interval: null,
    };

    position.interval = setInterval(
      () => this._checkPosition(tokenAddress),
      POLL_INTERVAL_MS
    );

    this.positions.set(tokenAddress, position);
    logger.info(`📊 Tracking position`, { token: tokenAddress, ethIn, buyPrice });
  }

  async _checkPosition(tokenAddress) {
    const pos = this.positions.get(tokenAddress);
    if (!pos) return;

    try {
      const currentPrice = await this._getPrice(tokenAddress);
      if (currentPrice <= 0) return;

      const multiplier = currentPrice / pos.buyPrice;
      const holdSeconds = (Date.now() - pos.buyTime) / 1000;

      // Update peak
      if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

      const peakMultiplier = pos.peakPrice / pos.buyPrice;

      // ── Stop Loss: -30% from buy ──────────────────────────────────
      if (multiplier <= config.strategy.stopLossMultiplier) {
        logger.warn(`🛑 Stop loss triggered`, { token: tokenAddress, multiplier: multiplier.toFixed(3) });
        await this._sell(tokenAddress, pos.tokensReceived, 'stop_loss');
        return;
      }

      // ── Time Stop: no 2x in maxHoldSeconds ───────────────────────
      if (!pos.tier1Sold && holdSeconds >= config.strategy.maxHoldSeconds && multiplier < 2) {
        logger.warn(`⏱️  Time stop triggered`, { token: tokenAddress, holdSeconds: holdSeconds.toFixed(0), multiplier: multiplier.toFixed(3) });
        await this._sell(tokenAddress, pos.tokensReceived, 'time_stop');
        return;
      }

      // ── Trailing Stop (after peak > 2x): 30% below peak ──────────
      if (pos.tier1Sold && peakMultiplier > 2 && multiplier < pos.peakPrice * 0.7 / pos.buyPrice) {
        logger.info(`📉 Trailing stop triggered`, { token: tokenAddress, peakMultiplier: peakMultiplier.toFixed(2), currentMultiplier: multiplier.toFixed(2) });
        await this._sell(tokenAddress, await this._getBalance(tokenAddress), 'trailing_stop');
        return;
      }

      // ── Tier 1: 2x → sell 30% ────────────────────────────────────
      if (!pos.tier1Sold && multiplier >= 2) {
        const sellAmount = pos.tokensReceived * 30n / 100n;
        logger.info(`🎯 Tier 1 (2x) hit — selling 30%`, { token: tokenAddress, multiplier: multiplier.toFixed(2) });
        await this._sell(tokenAddress, sellAmount, 'tier1');
        pos.tier1Sold = true;
        return;
      }

      // ── Tier 2: 5x → sell 40% of remaining ──────────────────────
      if (pos.tier1Sold && !pos.tier2Sold && multiplier >= config.strategy.tier2Multiplier) {
        const remaining = await this._getBalance(tokenAddress);
        const sellAmount = remaining * 57n / 100n; // ~40% of original
        logger.info(`🎯 Tier 2 (5x) hit — selling 57% of remaining`, { token: tokenAddress });
        await this._sell(tokenAddress, sellAmount, 'tier2');
        pos.tier2Sold = true;
        return;
      }

      // ── Tier 3: 10x → sell all remaining (moonbag exit) ──────────
      if (pos.tier2Sold && multiplier >= config.strategy.tier3Multiplier) {
        const remaining = await this._getBalance(tokenAddress);
        logger.info(`🚀 Tier 3 (10x) hit — selling moonbag`, { token: tokenAddress });
        await this._sell(tokenAddress, remaining, 'tier3');
        return;
      }

      // Log current status every 30s
      if (Math.floor(holdSeconds) % 30 === 0) {
        logger.debug(`📈 Position update`, {
          token: tokenAddress,
          multiplier: multiplier.toFixed(3),
          holdSeconds: holdSeconds.toFixed(0),
          tier1: pos.tier1Sold,
          tier2: pos.tier2Sold,
        });
      }

    } catch (err) {
      logger.error(`Error checking position ${tokenAddress}: ${err.message}`);
    }
  }

  async _sell(tokenAddress, amount, reason) {
    const pos = this.positions.get(tokenAddress);
    if (!pos) return;

    // Stop polling this position (for full exits)
    const isFullExit = ['stop_loss', 'time_stop', 'trailing_stop', 'tier3'].includes(reason);
    if (isFullExit) {
      clearInterval(pos.interval);
      this.positions.delete(tokenAddress);
    }

    if (config.dryRun) {
      logger.info(`[DRY RUN] Would sell ${amount} tokens of ${tokenAddress} (${reason})`);
      return;
    }

    try {
      // Approve router
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
      const allowance = await token.allowance(this.wallet.address, ADDRESSES.UNISWAP_V2_ROUTER);
      if (allowance < amount) {
        await (await token.approve(ADDRESSES.UNISWAP_V2_ROUTER, ethers.MaxUint256)).wait();
      }

      const deadline = Math.floor(Date.now() / 1000) + 60;
      const tx = await this.router.swapExactTokensForETHSupportingFeeOnTransferTokens(
        amount,
        0n,
        [tokenAddress, ADDRESSES.WETH],
        this.wallet.address,
        deadline,
        { gasLimit: 300000n }
      );

      const receipt = await tx.wait();
      const ethOut = await this._extractEthFromReceipt(receipt);

      logger.info(`✅ Sell executed`, {
        token: tokenAddress,
        reason,
        ethOut: ethOut?.toFixed(4),
        txHash: tx.hash,
      });

      // Update DB for full exits
      if (isFullExit && pos.tradeId) {
        const pnlEth = (ethOut || 0) - pos.ethIn;
        const pnlPercent = (pnlEth / pos.ethIn) * 100;
        closeTrade(tokenAddress, {
          sell_tx: tx.hash,
          sell_price_eth: await this._getPrice(tokenAddress),
          amount_eth_out: ethOut || 0,
          pnl_eth: pnlEth,
          pnl_percent: pnlPercent,
          sell_block: receipt.blockNumber,
        });

        if (pnlEth > 0) markDeployerSuccess(pos.deployer);
        else markDeployerRug(pos.deployer);

        logger.info(`💰 P&L: ${pnlEth >= 0 ? '+' : ''}${pnlEth.toFixed(4)} ETH (${pnlPercent.toFixed(1)}%)`);
      }

    } catch (err) {
      logger.error(`Failed to sell ${tokenAddress}: ${err.message}`);
    }
  }

  async _getPrice(tokenAddress) {
    try {
      const amounts = await this.router.getAmountsOut(
        ethers.parseEther('1'),
        [tokenAddress, ADDRESSES.WETH]
      );
      return parseFloat(ethers.formatEther(amounts[1]));
    } catch {
      return 0;
    }
  }

  async _getBalance(tokenAddress) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    return token.balanceOf(this.wallet.address);
  }

  async _extractEthFromReceipt(receipt) {
    try {
      // Look for WETH Transfer event or ETH received
      const ethBefore = await this.provider.getBalance(this.wallet.address, receipt.blockNumber - 1);
      const ethAfter = await this.provider.getBalance(this.wallet.address, receipt.blockNumber);
      return parseFloat(ethers.formatEther(ethAfter - ethBefore));
    } catch {
      return null;
    }
  }
}
