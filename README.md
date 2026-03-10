# ETH Sniper Bot 🎯

Ethereum token launch sniper — same-block buy via Flashbots, safety scoring, and tiered auto-sell.

## Architecture

```
Mempool Listener
  └─→ Safety Filter (hard filters + scoring)
        └─→ Buy Executor (Flashbots bundle, same-block)
              └─→ Sell Manager (tiered exit + stop loss)
                    └─→ SQLite DB (trade log + P&L)
```

## Strategy

### Buy Logic
- Detects `addLiquidityETH` in the mempool (Uniswap V2)
  - **Default:** polls `txpool_content` (QuickNode / any RPC with txpool enabled)
  - **Optional:** WebSocket listener when high-speed streams are available
- Bundles buy tx with the liquidity tx via **Flashbots** → same block, guaranteed order
- If liquidity tx doesn't land → our buy also fails → **zero wasted gas**

### Token Selection (Safety Filter)

**Hard Filters (any fail = skip):**
- Honeypot simulation via `getAmountsOut` sell check
- Buy/sell tax > 10%
- GoPlus: mint function, blacklist, honeypot flag
- Liquidity < 3 ETH
- Known rugger deployer

**Scoring (0–100):**
| Factor | Max Points |
|---|---|
| Liquidity size | 25 |
| Contract safety (GoPlus) | 30 |
| Tax levels | 20 |
| Deployer history | 15 |
| Sell simulation confidence | 10 |

Score < 55 → skip. Buy amount scales with score (higher score = larger position).

### Sell Logic (Tiered Exit)

| Tier | Trigger | Action |
|---|---|---|
| Tier 1 | 2x | Sell 30% |
| Tier 2 | 5x | Sell 40% remaining |
| Tier 3 | 10x | Sell moonbag |
| Stop Loss | -30% | Sell all |
| Time Stop | No 2x in 5 min | Sell all |
| Trailing Stop | 30% below peak | Sell remaining |

## Setup

```bash
# 1. Clone and install
git clone https://github.com/ledgerdever/ETH-Sniper-Bot
cd ETH-Sniper-Bot
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your RPC, wallet key, etc.

# 3. Run
npm start

# Dry run (no real txs)
DRY_RUN=true npm start
```

### TxPool Listener Configuration
- `TXPOOL_ENABLED=true` (default) → use `txpool_content` polling
- `TXPOOL_POLL_MS` → interval between polls (200 ms recommended for QuickNode Build)
- `TXPOOL_MAX_SEEN` → size of the dedupe cache (prevents reprocessing the same hash)
- To fall back to WebSocket mempool, set `TXPOOL_ENABLED=false` and provide `RPC_WSS`

## Requirements

- **Private RPC with txpool access** (`txpool_content` must be enabled)
  - QuickNode: enable the *Archive + Txpool* add-on
  - Self-hosted: run Geth / Nethermind with txpool RPC exposed
- **Flashbots auth key** (optional but recommended for reputation)
- **GoPlus API key** (optional, improves safety detection)
- Funded wallet (suggest starting with 0.5–2 ETH)

## Project Structure

```
src/
├── config/       # Addresses, ABIs, env config
├── listeners/    # Mempool WebSocket listener
├── filters/      # Safety filter + scoring
├── executors/    # Flashbots buy executor
├── managers/     # Sell strategy manager
├── db/           # SQLite trade log
└── utils/        # Logger
data/
└── sniper.db     # Auto-created SQLite DB
```

## Branches

| Branch | Description |
|---|---|
| `main` | Stable releases |
| `feature/mempool-listener` | Mempool detection |
| `feature/safety-filter` | Token scoring |
| `feature/buy-executor` | Flashbots buy |
| `feature/sell-manager` | Sell strategy |

## Disclaimer

This bot interacts with live Ethereum mainnet. Use at your own risk. Start with `DRY_RUN=true` and small amounts. Most newly launched tokens are scams — the safety filter helps but is not foolproof.
