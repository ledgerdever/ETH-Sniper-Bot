/**
 * Buy Executor — Same-block buy via Flashbots bundle
 *
 * Bundles:
 *   [0] deployer's addLiquidityETH tx (signed raw)
 *   [1] our buy tx
 *
 * If the deployer tx doesn't land, our buy also fails → zero gas wasted.
 */

import { ethers } from 'ethers';
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { ADDRESSES, config } from '../config/index.js';
import { UNISWAP_V2_ROUTER_ABI } from '../config/abis.js';
import { logger } from '../utils/logger.js';

export class BuyExecutor {
  constructor(provider, wallet) {
    this.provider = provider;
    this.wallet = wallet;
    this.flashbotsProvider = null;
    this.router = new ethers.Contract(ADDRESSES.UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, wallet);
  }

  async init() {
    const authSigner = config.flashbots.authKey
      ? new ethers.Wallet(config.flashbots.authKey)
      : ethers.Wallet.createRandom();

    this.flashbotsProvider = await FlashbotsBundleProvider.create(
      this.provider,
      authSigner,
      config.flashbots.relayUrl
    );
    logger.info('⚡ Flashbots provider initialized');
  }

  /**
   * Execute a same-block buy
   * @param {object} tokenInfo - from mempool listener
   * @param {number} score - from safety filter
   * @param {number} buyAmountEth - scaled by score
   * @returns {object} - { success, txHash, tokensReceived, pricePerToken }
   */
  async buy(tokenInfo, score, buyAmountEth) {
    const { tokenAddress, rawTx } = tokenInfo;

    if (config.dryRun) {
      logger.info(`[DRY RUN] Would buy ${buyAmountEth} ETH of ${tokenAddress} (score: ${score})`);
      return { success: false, dryRun: true };
    }

    const targetBlock = await this.provider.getBlockNumber() + 1;
    const buyAmountWei = ethers.parseEther(buyAmountEth.toString());

    // ⚡ Fetch gas data + nonce in parallel
    const [block, nonce] = await Promise.all([
      this.provider.getBlock('latest'),
      this.provider.getTransactionCount(this.wallet.address, 'latest'),
    ]);

    // Dynamic gas: 2x base fee + priority tip (outbid most bots)
    const baseFee = block.baseFeePerGas || ethers.parseUnits('10', 'gwei');
    const priorityFee = ethers.parseUnits('3', 'gwei');
    const maxFeePerGas = baseFee * 2n + priorityFee;

    // Build our buy tx
    const deadline = Math.floor(Date.now() / 1000) + 60;
    const path = [ADDRESSES.WETH, tokenAddress];

    // Use SupportingFeeOnTransfer variant to handle tax tokens
    const buyTx = await this.router.swapExactETHForTokensSupportingFeeOnTransferTokens.populateTransaction(
      0n,       // amountOutMin = 0 (we already validated via simulation)
      path,
      this.wallet.address,
      deadline,
      { value: buyAmountWei, gasLimit: 300000n }
    );

    // Sign our buy tx
    const signedBuyTx = await this.wallet.signTransaction({
      ...buyTx,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      chainId: 1,
      type: 2,
    });

    // Bundle: deployer tx + our buy tx
    const bundle = [
      { signedTransaction: rawTx.rawTransaction || await this._getRawTx(rawTx.hash) },
      { signedTransaction: signedBuyTx },
    ];

    logger.info(`📦 Submitting Flashbots bundle for block ${targetBlock}`, {
      token: tokenAddress,
      buyEth: buyAmountEth,
      score,
    });

    // Submit bundle to current + next 2 blocks for higher inclusion chance
    const results = await Promise.allSettled([
      this.flashbotsProvider.sendBundle(bundle, targetBlock),
      this.flashbotsProvider.sendBundle(bundle, targetBlock + 1),
      this.flashbotsProvider.sendBundle(bundle, targetBlock + 2),
    ]);

    // Wait for bundle simulation result
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const sim = await result.value.simulate().catch(() => null);
        if (sim && !sim.error) {
          logger.info(`✅ Bundle simulation OK`, { bundleHash: result.value.bundleHash });
        }
      }
    }

    // Poll for our tx landing
    return await this._waitForLanding(tokenAddress, buyAmountWei, targetBlock);
  }

  async _waitForLanding(tokenAddress, buyAmountWei, targetBlock) {
    // Wait up to 3 blocks for our tx to land
    for (let i = 0; i < 3; i++) {
      await this._waitForBlock(targetBlock + i);

      // Check our wallet's token balance
      const { ERC20_ABI } = await import('../config/abis.js');
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
      const balance = await token.balanceOf(this.wallet.address).catch(() => 0n);

      if (balance > 0n) {
        const ethIn = parseFloat(ethers.formatEther(buyAmountWei));
        // Get price from reserves
        const pricePerToken = await this._getPrice(tokenAddress).catch(() => 0);

        logger.info(`🎉 Buy landed!`, {
          token: tokenAddress,
          tokensReceived: balance.toString(),
          ethIn,
          block: targetBlock + i,
        });

        return {
          success: true,
          tokensReceived: balance,
          ethIn,
          pricePerToken,
          buyBlock: targetBlock + i,
        };
      }
    }

    logger.warn(`Bundle did not land within 3 blocks for ${tokenAddress}`);
    return { success: false };
  }

  async _waitForBlock(targetBlock) {
    return new Promise((resolve) => {
      const check = async () => {
        const current = await this.provider.getBlockNumber();
        if (current >= targetBlock) resolve();
        else setTimeout(check, 500);
      };
      check();
    });
  }

  async _getRawTx(txHash) {
    // Fetch raw transaction by hash if not already available
    const tx = await this.provider.getTransaction(txHash);
    return ethers.Transaction.from(tx).serialized;
  }

  async _getPrice(tokenAddress) {
    try {
      const amountsOut = await this.router.getAmountsOut(
        ethers.parseEther('1'),
        [ADDRESSES.WETH, tokenAddress]
      );
      return parseFloat(ethers.formatEther(amountsOut[1]));
    } catch {
      return 0;
    }
  }

  /**
   * Scale buy amount based on score (higher confidence = larger position)
   */
  static scaleBuyAmount(baseAmountEth, score) {
    if (score >= 80) return baseAmountEth * 4;  // 4x base
    if (score >= 70) return baseAmountEth * 2;  // 2x base
    if (score >= 60) return baseAmountEth * 1.5;
    return baseAmountEth;                         // base
  }
}
