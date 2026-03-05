/**
 * QuickNode connection speed test
 * Usage: node scripts/test-connection.js
 *
 * Tests:
 *  1. WebSocket connection and mempool speed
 *  2. HTTP provider latency
 *  3. Uniswap V2 Router reachability
 */

import 'dotenv/config';
import { ethers } from 'ethers';

const RPC_WSS   = process.env.RPC_WSS;
const RPC_HTTPS = process.env.RPC_HTTPS;
const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

if (!RPC_WSS || !RPC_HTTPS) {
  console.error('❌ Set RPC_WSS and RPC_HTTPS in your .env file first');
  process.exit(1);
}

// ── Test 1: HTTP latency ─────────────────────────────────────────────
async function testHttp() {
  console.log('\n📡 Test 1: HTTP Provider Latency');
  const provider = new ethers.JsonRpcProvider(RPC_HTTPS);

  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    await provider.getBlockNumber();
    times.push(Date.now() - start);
  }

  const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(0);
  console.log(`  Latency (5 calls): ${times.join('ms, ')}ms`);
  console.log(`  Average: ${avg}ms ${avg < 100 ? '✅ Excellent' : avg < 200 ? '🟡 OK' : '🔴 Slow'}`);
  return provider;
}

// ── Test 2: WebSocket mempool speed ──────────────────────────────────
async function testMempool() {
  console.log('\n📡 Test 2: Mempool Speed (first 50 pending txs)');
  const provider = new ethers.WebSocketProvider(RPC_WSS);

  return new Promise((resolve) => {
    let count = 0;
    const start = Date.now();

    provider.on('pending', (txHash) => {
      count++;
      if (count === 50) {
        const elapsed = Date.now() - start;
        const rate = (50 / (elapsed / 1000)).toFixed(1);
        console.log(`  50 txs received in ${elapsed}ms (${rate} tx/sec)`);
        console.log(`  ${rate > 100 ? '✅ Excellent' : rate > 30 ? '🟡 OK' : '🔴 Slow — check Mempool Streaming add-on'}`);
        provider.destroy();
        resolve();
      }
    });

    setTimeout(() => {
      if (count < 50) {
        console.log(`  ⚠️  Only got ${count} txs in 10s — mempool may not be enabled`);
        provider.destroy();
        resolve();
      }
    }, 10000);
  });
}

// ── Test 3: Uniswap V2 Router reachability ────────────────────────────
async function testUniswap(provider) {
  console.log('\n📡 Test 3: Uniswap V2 Router Simulation');
  const router = new ethers.Contract(
    UNISWAP_V2_ROUTER,
    ['function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)'],
    provider
  );

  try {
    const start = Date.now();
    const amounts = await router.getAmountsOut(ethers.parseEther('1'), [WETH, USDC]);
    const elapsed = Date.now() - start;
    const usdcPrice = (Number(amounts[1]) / 1e6).toFixed(2);
    console.log(`  ETH price: $${usdcPrice} (fetched in ${elapsed}ms) ✅`);
  } catch (err) {
    console.log(`  ❌ Failed: ${err.message}`);
  }
}

// ── Run all tests ─────────────────────────────────────────────────────
async function main() {
  console.log('🔍 QuickNode Connection Test');
  console.log(`   HTTP: ${RPC_HTTPS.replace(/\/[^/]+\/?$/, '/***')}`);
  console.log(`   WSS:  ${RPC_WSS.replace(/\/[^/]+\/?$/, '/***')}`);

  const httpProvider = await testHttp();
  await testUniswap(httpProvider);
  await testMempool();

  console.log('\n✅ Tests complete\n');
  process.exit(0);
}

main().catch(console.error);
