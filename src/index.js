/**
 * ETH Sniper Bot — Main Entry Point
 *
 * Flow:
 *  1. TxPool/Mempool listener detects new addLiquidity tx
 *  2. SafetyFilter evaluates + scores the token
 *  3. BuyExecutor bundles our buy with the liquidity tx via Flashbots
 *  4. SellManager tracks the position and executes tiered exit
 */

import { ethers } from 'ethers';
import { config } from './config/index.js';
import { MempoolListener } from './listeners/mempoolListener.js';
import { TxPoolListener } from './listeners/txpoolListener.js';
import { SafetyFilter } from './filters/safetyFilter.js';
import { BuyExecutor } from './executors/buyExecutor.js';
import { SellManager } from './managers/sellManager.js';
import { insertTrade, getTradeSummary, logSkipped } from './db/index.js';
import { logger } from './utils/logger.js';

// ── Validate config ──────────────────────────────────────────────────
if (!config.rpc.https) throw new Error('RPC_HTTPS is required');
if (!config.wallet.privateKey) throw new Error('PRIVATE_KEY is required');

// ── Init providers ───────────────────────────────────────────────────
const httpsProvider = new ethers.JsonRpcProvider(config.rpc.https);
const wallet = new ethers.Wallet(config.wallet.privateKey, httpsProvider);

logger.info(`🤖 ETH Sniper Bot starting`, {
  wallet: wallet.address,
  dryRun: config.dryRun,
  minScore: config.strategy.minScore,
  buyAmount: config.strategy.buyAmountEth,
  txpool: config.txpool.enabled,
});

// ── Init modules ─────────────────────────────────────────────────────
const safetyFilter = new SafetyFilter(httpsProvider);
const buyExecutor = new BuyExecutor(httpsProvider, wallet);
const sellManager = new SellManager(httpsProvider, wallet);

// Tokens currently being evaluated (prevent duplicate processing)
const processing = new Set();

// ── Core handler ─────────────────────────────────────────────────────
async function handleNewToken(tokenInfo) {
  const { tokenAddress } = tokenInfo;

  if (processing.has(tokenAddress)) return;
  processing.add(tokenAddress);

  try {
    logger.info(`🔍 Evaluating token: ${tokenAddress}`);

    // Stage 1 + 2: Safety filter + scoring
    const filterResult = await safetyFilter.evaluate(tokenInfo);

    if (!filterResult.pass) {
      logSkipped(tokenAddress, filterResult.reason, filterResult.score);
      logger.info(`⏭️  Skipped: ${filterResult.reason}`);
      return;
    }

    const { score, details } = filterResult;

    // Scale buy amount by score
    const buyAmountEth = BuyExecutor.scaleBuyAmount(config.strategy.buyAmountEth, score);
    logger.info(`💸 Buying ${buyAmountEth} ETH of ${details.meta?.symbol || tokenAddress} (score: ${score})`);

    // Execute same-block buy via Flashbots
    const buyResult = await buyExecutor.buy(tokenInfo, score, buyAmountEth);

    if (!buyResult.success) {
      logger.warn(`Buy failed or dry run for ${tokenAddress}`);
      return;
    }

    // Log to DB
    const dbResult = insertTrade({
      token_address: tokenAddress,
      token_name: details.meta?.name,
      token_symbol: details.meta?.symbol,
      deployer: tokenInfo.deployer,
      buy_tx: null, // we don't get a single txHash from bundle easily
      buy_price_eth: buyResult.pricePerToken,
      amount_eth_in: buyResult.ethIn,
      amount_tokens: buyResult.tokensReceived?.toString(),
      score,
      buy_block: buyResult.buyBlock,
    });

    // Start sell monitoring
    sellManager.track(tokenAddress, {
      tokensReceived: buyResult.tokensReceived,
      ethIn: buyResult.ethIn,
      buyPrice: buyResult.pricePerToken,
      buyBlock: buyResult.buyBlock,
      deployer: tokenInfo.deployer,
      tradeId: dbResult.lastInsertRowid,
    });

  } catch (err) {
    logger.error(`Error handling token ${tokenAddress}: ${err.message}`, err.stack);
  } finally {
    // Remove from processing after 30s to allow retry on new liquidity event
    setTimeout(() => processing.delete(tokenAddress), 30000);
  }
}

// ── Start ─────────────────────────────────────────────────────────────
async function main() {
  await buyExecutor.init();

  const listeners = [];

  if (config.txpool.enabled) {
    const txPoolListener = new TxPoolListener(httpsProvider, handleNewToken, {
      intervalMs: config.txpool.pollIntervalMs,
      maxSeen: config.txpool.maxSeen,
    });
    txPoolListener.start();
    listeners.push(txPoolListener);
  } else if (config.rpc.wss) {
    const wssProvider = new ethers.WebSocketProvider(config.rpc.wss);
    const mempoolListener = new MempoolListener(wssProvider, handleNewToken);
    mempoolListener.start();
    listeners.push(mempoolListener);
  } else {
    throw new Error('No listener enabled. Provide RPC_WSS or enable txpool listener.');
  }

  // Print P&L summary every 5 minutes
  setInterval(() => {
    const summary = getTradeSummary();
    if (summary.total > 0) {
      logger.info(`📊 P&L Summary`, summary);
    }
  }, 5 * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    listeners.forEach((l) => l.stop?.());
    process.exit(0);
  });

  logger.info(`✅ Bot is live. Listening for new token launches...`);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`, err.stack);
  process.exit(1);
});
