import { config } from '../config/index.js';

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

const colors = {
  debug: '\x1b[36m',  // cyan
  info:  '\x1b[32m',  // green
  warn:  '\x1b[33m',  // yellow
  error: '\x1b[31m',  // red
  reset: '\x1b[0m',
};

function log(level, msg, data) {
  if (levels[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const color = colors[level] || '';
  const prefix = `${color}[${ts}] [${level.toUpperCase()}]${colors.reset}`;
  if (data !== undefined) {
    console.log(`${prefix} ${msg}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

export const logger = {
  debug: (msg, data) => log('debug', msg, data),
  info:  (msg, data) => log('info', msg, data),
  warn:  (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
};
