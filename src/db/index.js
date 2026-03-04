import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/sniper.db');

// Ensure data directory exists
import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    deployer TEXT,
    buy_tx TEXT,
    sell_tx TEXT,
    buy_price_eth REAL,
    sell_price_eth REAL,
    amount_eth_in REAL,
    amount_eth_out REAL,
    amount_tokens REAL,
    score INTEGER,
    status TEXT DEFAULT 'open',   -- open | sold | failed
    pnl_eth REAL,
    pnl_percent REAL,
    buy_block INTEGER,
    sell_block INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS deployers (
    address TEXT PRIMARY KEY,
    tokens_launched INTEGER DEFAULT 0,
    rugs INTEGER DEFAULT 0,
    successful_tokens INTEGER DEFAULT 0,
    avg_liquidity_eth REAL,
    reputation_score REAL DEFAULT 50,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS skipped_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT,
    reason TEXT,
    score INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Trade operations ──────────────────────────────────────────────────

export function insertTrade(trade) {
  const stmt = db.prepare(`
    INSERT INTO trades (token_address, token_name, token_symbol, deployer,
      buy_tx, buy_price_eth, amount_eth_in, amount_tokens, score, status, buy_block)
    VALUES (@token_address, @token_name, @token_symbol, @deployer,
      @buy_tx, @buy_price_eth, @amount_eth_in, @amount_tokens, @score, 'open', @buy_block)
  `);
  return stmt.run(trade);
}

export function closeTrade(tokenAddress, sellData) {
  const stmt = db.prepare(`
    UPDATE trades SET
      sell_tx = @sell_tx,
      sell_price_eth = @sell_price_eth,
      amount_eth_out = @amount_eth_out,
      pnl_eth = @pnl_eth,
      pnl_percent = @pnl_percent,
      sell_block = @sell_block,
      status = 'sold',
      updated_at = CURRENT_TIMESTAMP
    WHERE token_address = @token_address AND status = 'open'
  `);
  return stmt.run({ token_address: tokenAddress, ...sellData });
}

export function getOpenTrades() {
  return db.prepare(`SELECT * FROM trades WHERE status = 'open'`).all();
}

export function getTradeSummary() {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'sold' AND pnl_eth > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status = 'sold' AND pnl_eth <= 0 THEN 1 ELSE 0 END) as losses,
      SUM(pnl_eth) as total_pnl_eth,
      AVG(pnl_percent) as avg_pnl_percent
    FROM trades WHERE status = 'sold'
  `).get();
}

// ── Deployer operations ───────────────────────────────────────────────

export function upsertDeployer(address) {
  db.prepare(`
    INSERT INTO deployers (address) VALUES (?)
    ON CONFLICT(address) DO UPDATE SET
      tokens_launched = tokens_launched + 1,
      last_seen = CURRENT_TIMESTAMP
  `).run(address);
}

export function getDeployer(address) {
  return db.prepare(`SELECT * FROM deployers WHERE address = ?`).get(address);
}

export function markDeployerRug(address) {
  db.prepare(`
    UPDATE deployers SET rugs = rugs + 1,
      reputation_score = MAX(0, reputation_score - 20)
    WHERE address = ?
  `).run(address);
}

export function markDeployerSuccess(address) {
  db.prepare(`
    UPDATE deployers SET successful_tokens = successful_tokens + 1,
      reputation_score = MIN(100, reputation_score + 10)
    WHERE address = ?
  `).run(address);
}

// ── Skip log ─────────────────────────────────────────────────────────

export function logSkipped(tokenAddress, reason, score = null) {
  db.prepare(`INSERT INTO skipped_tokens (token_address, reason, score) VALUES (?, ?, ?)`)
    .run(tokenAddress, reason, score);
}

export default db;
