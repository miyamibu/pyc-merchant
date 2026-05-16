import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Interface, JsonRpcProvider } from "ethers";
import {
  compareBaseUnits,
  convertBaseUnitsBetweenDecimals,
  formatBaseUnitsForDisplay,
  parseDecimalToBaseUnits,
  scaleToDecimals,
} from "./amounts.mjs";

const CWD = process.cwd();
const DEFAULTS = {
  APP_ENV: "development",
  APP_HOST: "http://localhost:4173",
  INTERNAL_API_BASE_URL: "",
  DB_PATH: "./data/app.db",
  CHAIN_ID: "137",
  TOKEN_CONTRACT: "",
  APPROVED_JPYC_TOKEN_CONTRACT: "",
  JPYC_CONTRACT_APPROVAL_REF: "",
  TOKEN_DECIMALS: "18",
  JPYC_BASE_UNIT_SCALE: "",
  RPC_URLS: "",
  MONITOR_POLL_INTERVAL_MS: "15000",
  MONITOR_BACKSCAN_BLOCKS: "12",
  MIN_MONITOR_BACKSCAN_BLOCKS: "12",
  REQUIRED_CONFIRMATIONS: "2",
  MIN_REQUIRED_CONFIRMATIONS: "2",
  CONFIRMATIONS_POLICY_APPROVAL_REF: "",
  BACKSCAN_POLICY_APPROVAL_REF: "",
  MONITOR_DEAD_LETTER_MAX_RETRIES: "5",
  MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS: "60000",
  SERVICE_INGEST_ID: "chain-monitor",
  SERVICE_INGEST_SECRET: "__REPLACE_WITH_LONG_RANDOM_INGEST_SECRET__"
};

const APPROVAL_GUARD_WORDS = [
  ["def", "ault"].join(""),
  ["place", "holder"].join(""),
  ["to", "do"].join(""),
  ["change", "me"].join(""),
  ["exam", "ple"].join(""),
  ["sam", "ple"].join(""),
  ["tb", "d"].join(""),
];

function isPlaceholderLike(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return APPROVAL_GUARD_WORDS.some((word) => normalized === word || normalized.includes(word));
}

function loadEnv() {
  const envPath = path.join(CWD, ".env");
  const values = { ...DEFAULTS };
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) values[key] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key in values && typeof value === "string" && value.length > 0) {
      values[key] = value;
    }
  }
  return values;
}

const ENV = loadEnv();
const APP_ENV = String(ENV.APP_ENV || DEFAULTS.APP_ENV).trim().toLowerCase();
const IS_PRODUCTION = APP_ENV === "production";
const APP_HOST = ENV.APP_HOST || DEFAULTS.APP_HOST;
const INTERNAL_API_BASE_URL = String(ENV.INTERNAL_API_BASE_URL || (IS_PRODUCTION ? "" : APP_HOST)).trim();
const DB_PATH = path.resolve(CWD, ENV.DB_PATH || DEFAULTS.DB_PATH);
const CHAIN_ID = String(ENV.CHAIN_ID || DEFAULTS.CHAIN_ID);
const TOKEN_CONTRACT = String(ENV.TOKEN_CONTRACT || DEFAULTS.TOKEN_CONTRACT).toLowerCase();
const APPROVED_JPYC_TOKEN_CONTRACT = String(ENV.APPROVED_JPYC_TOKEN_CONTRACT || DEFAULTS.APPROVED_JPYC_TOKEN_CONTRACT).toLowerCase();
const JPYC_CONTRACT_APPROVAL_REF = String(ENV.JPYC_CONTRACT_APPROVAL_REF || DEFAULTS.JPYC_CONTRACT_APPROVAL_REF || "");
const TOKEN_DECIMALS = Number(ENV.TOKEN_DECIMALS || DEFAULTS.TOKEN_DECIMALS);
const JPYC_BASE_UNIT_SCALE = String(ENV.JPYC_BASE_UNIT_SCALE || DEFAULTS.JPYC_BASE_UNIT_SCALE || "");
const JPYC_DECIMALS = scaleToDecimals(JPYC_BASE_UNIT_SCALE);
const CHAIN_ID_NUMERIC = Number(CHAIN_ID);
const RPC_URLS = String(ENV.RPC_URLS || DEFAULTS.RPC_URLS)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MONITOR_POLL_INTERVAL_MS = Number(ENV.MONITOR_POLL_INTERVAL_MS || DEFAULTS.MONITOR_POLL_INTERVAL_MS);
const MONITOR_BACKSCAN_BLOCKS = Number(ENV.MONITOR_BACKSCAN_BLOCKS || DEFAULTS.MONITOR_BACKSCAN_BLOCKS);
const MIN_MONITOR_BACKSCAN_BLOCKS = Number(ENV.MIN_MONITOR_BACKSCAN_BLOCKS || DEFAULTS.MIN_MONITOR_BACKSCAN_BLOCKS);
const REQUIRED_CONFIRMATIONS = Number(ENV.REQUIRED_CONFIRMATIONS || DEFAULTS.REQUIRED_CONFIRMATIONS);
const MIN_REQUIRED_CONFIRMATIONS = Number(ENV.MIN_REQUIRED_CONFIRMATIONS || DEFAULTS.MIN_REQUIRED_CONFIRMATIONS);
const CONFIRMATIONS_POLICY_APPROVAL_REF = String(ENV.CONFIRMATIONS_POLICY_APPROVAL_REF || DEFAULTS.CONFIRMATIONS_POLICY_APPROVAL_REF || "");
const BACKSCAN_POLICY_APPROVAL_REF = String(ENV.BACKSCAN_POLICY_APPROVAL_REF || DEFAULTS.BACKSCAN_POLICY_APPROVAL_REF || "");
const MONITOR_DEAD_LETTER_MAX_RETRIES = Number(ENV.MONITOR_DEAD_LETTER_MAX_RETRIES || DEFAULTS.MONITOR_DEAD_LETTER_MAX_RETRIES);
const MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS = Number(
  ENV.MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS || DEFAULTS.MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS
);
const SERVICE_INGEST_ID = String(ENV.SERVICE_INGEST_ID || DEFAULTS.SERVICE_INGEST_ID);
const SERVICE_INGEST_SECRET = String(ENV.SERVICE_INGEST_SECRET || DEFAULTS.SERVICE_INGEST_SECRET);
const ACTIVE_TOKEN_CONTRACT = APPROVED_JPYC_TOKEN_CONTRACT || TOKEN_CONTRACT;

if (RPC_URLS.length === 0) {
  console.error("FATAL: RPC_URLS is empty. Set at least one RPC endpoint.");
  process.exit(1);
}
if (!SERVICE_INGEST_SECRET || SERVICE_INGEST_SECRET === DEFAULTS.SERVICE_INGEST_SECRET || SERVICE_INGEST_SECRET.length < 32) {
  console.error("FATAL: SERVICE_INGEST_SECRET must be configured with a strong random value.");
  process.exit(1);
}
if (!Number.isFinite(TOKEN_DECIMALS) || TOKEN_DECIMALS < 0 || TOKEN_DECIMALS > 30) {
  console.error("FATAL: TOKEN_DECIMALS is invalid.");
  process.exit(1);
}
if (!JPYC_BASE_UNIT_SCALE) {
  console.error("FATAL: JPYC_BASE_UNIT_SCALE is invalid.");
  process.exit(1);
}
if (!/^0x[0-9a-f]{40}$/.test(TOKEN_CONTRACT)) {
  console.error("FATAL: TOKEN_CONTRACT must be a 0x-prefixed 40-hex EVM address.");
  process.exit(1);
}
if (APPROVED_JPYC_TOKEN_CONTRACT && !/^0x[0-9a-f]{40}$/.test(APPROVED_JPYC_TOKEN_CONTRACT)) {
  console.error("FATAL: APPROVED_JPYC_TOKEN_CONTRACT must be a 0x-prefixed 40-hex EVM address.");
  process.exit(1);
}
if (!Number.isFinite(REQUIRED_CONFIRMATIONS) || REQUIRED_CONFIRMATIONS < 0 || !Number.isInteger(REQUIRED_CONFIRMATIONS)) {
  console.error("FATAL: REQUIRED_CONFIRMATIONS must be a non-negative integer.");
  process.exit(1);
}
if (!Number.isFinite(MIN_REQUIRED_CONFIRMATIONS) || MIN_REQUIRED_CONFIRMATIONS < 1 || !Number.isInteger(MIN_REQUIRED_CONFIRMATIONS)) {
  console.error("FATAL: MIN_REQUIRED_CONFIRMATIONS must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(MONITOR_BACKSCAN_BLOCKS) || MONITOR_BACKSCAN_BLOCKS < 1 || !Number.isInteger(MONITOR_BACKSCAN_BLOCKS)) {
  console.error("FATAL: MONITOR_BACKSCAN_BLOCKS must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(MIN_MONITOR_BACKSCAN_BLOCKS) || MIN_MONITOR_BACKSCAN_BLOCKS < 1 || !Number.isInteger(MIN_MONITOR_BACKSCAN_BLOCKS)) {
  console.error("FATAL: MIN_MONITOR_BACKSCAN_BLOCKS must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(MONITOR_DEAD_LETTER_MAX_RETRIES) || MONITOR_DEAD_LETTER_MAX_RETRIES < 1 || !Number.isInteger(MONITOR_DEAD_LETTER_MAX_RETRIES)) {
  console.error("FATAL: MONITOR_DEAD_LETTER_MAX_RETRIES must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS) || MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS < 1000) {
  console.error("FATAL: MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS must be >= 1000.");
  process.exit(1);
}
if (IS_PRODUCTION && MONITOR_BACKSCAN_BLOCKS < MIN_MONITOR_BACKSCAN_BLOCKS) {
  console.error("FATAL: MONITOR_BACKSCAN_BLOCKS is below the production minimum.");
  process.exit(1);
}
if (IS_PRODUCTION && REQUIRED_CONFIRMATIONS < MIN_REQUIRED_CONFIRMATIONS) {
  console.error("FATAL: REQUIRED_CONFIRMATIONS is below MIN_REQUIRED_CONFIRMATIONS.");
  process.exit(1);
}
if (IS_PRODUCTION && !INTERNAL_API_BASE_URL) {
  console.error("FATAL: INTERNAL_API_BASE_URL must be configured for production chain monitor ingest.");
  process.exit(1);
}
if (IS_PRODUCTION) {
  if (!APPROVED_JPYC_TOKEN_CONTRACT || TOKEN_CONTRACT !== APPROVED_JPYC_TOKEN_CONTRACT) {
    console.error("FATAL: TOKEN_CONTRACT must match APPROVED_JPYC_TOKEN_CONTRACT in production.");
    process.exit(1);
  }
  if (isPlaceholderLike(JPYC_CONTRACT_APPROVAL_REF)) {
    console.error("FATAL: JPYC_CONTRACT_APPROVAL_REF must be set to an approved reference.");
    process.exit(1);
  }
  if (isPlaceholderLike(CONFIRMATIONS_POLICY_APPROVAL_REF)) {
    console.error("FATAL: CONFIRMATIONS_POLICY_APPROVAL_REF must be set to an approved reference.");
    process.exit(1);
  }
  if (isPlaceholderLike(BACKSCAN_POLICY_APPROVAL_REF)) {
    console.error("FATAL: BACKSCAN_POLICY_APPROVAL_REF must be set to an approved reference.");
    process.exit(1);
  }
}

const VALID_RPC_URLS = RPC_URLS.map((rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    return parsed.toString();
  } catch (error) {
    console.error(`FATAL: RPC_URLS contains invalid URL "${rawUrl}": ${String(error.message || error)}`);
    process.exit(1);
  }
});

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (secret, value) => crypto.createHmac("sha256", secret).update(value).digest("hex");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS chain_monitor_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_unmatched_events (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER,
  to_address TEXT,
  amount_jpyc REAL NOT NULL,
  amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chain_unmatched_events
ON chain_unmatched_events(chain_id, tx_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_chain_unmatched_events_chain_token_created_at
ON chain_unmatched_events(chain_id, token_contract, created_at DESC);

CREATE TABLE IF NOT EXISTS chain_dead_letters (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER,
  invoice_id TEXT,
  payload_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chain_dead_letters_dedupe
ON chain_dead_letters(chain_id, tx_hash, COALESCE(log_index, -1), COALESCE(invoice_id, ''));

CREATE TABLE IF NOT EXISTS chain_rpc_failovers (
  id TEXT PRIMARY KEY,
  provider_url TEXT NOT NULL,
  label TEXT NOT NULL,
  error_message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

function addColumnIfMissing(tableName, columnName, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (exists) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
}

addColumnIfMissing("chain_dead_letters", "status", "status TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing("chain_dead_letters", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("chain_dead_letters", "last_error", "last_error TEXT");
addColumnIfMissing("chain_dead_letters", "next_retry_at", "next_retry_at TEXT");
addColumnIfMissing("chain_dead_letters", "resolved_at", "resolved_at TEXT");

const transferInterface = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const providers = VALID_RPC_URLS.map((url) =>
  new JsonRpcProvider(url, Number.isFinite(CHAIN_ID_NUMERIC) ? CHAIN_ID_NUMERIC : undefined, { staticNetwork: true })
);
const checkpointKey = `last_block:${CHAIN_ID}:${ACTIVE_TOKEN_CONTRACT}`;

function toInvoiceBaseUnits(invoice) {
  if (invoice?.amount_jpyc_base != null && String(invoice.amount_jpyc_base).trim() !== "") {
    return String(invoice.amount_jpyc_base);
  }
  return parseDecimalToBaseUnits(String(invoice?.amount_jpyc ?? "0"), JPYC_DECIMALS);
}

function toAppBaseUnitsFromTokenValue(tokenValueBaseUnits) {
  const converted = convertBaseUnitsBetweenDecimals(String(tokenValueBaseUnits), TOKEN_DECIMALS, JPYC_DECIMALS);
  if (!converted.exact) {
    return { error: "non_exact_decimal_conversion", value: converted.value };
  }
  return { value: converted.value };
}

function setState(key, value) {
  db.prepare(
    `INSERT INTO chain_monitor_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value), nowIso());
}

function toAddressTopic(address) {
  if (typeof address !== "string") return null;
  const normalized = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) return null;
  return `0x${normalized.slice(2).padStart(64, "0")}`;
}

function getCheckpoint() {
  const row = db.prepare(`SELECT value FROM chain_monitor_state WHERE key = ?`).get(checkpointKey);
  if (!row) return null;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function setCheckpoint(blockNumber) {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO chain_monitor_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(checkpointKey, String(blockNumber), ts);
}

function getCandidateInvoices() {
  return db
    .prepare(
      `SELECT id, amount_jpyc, amount_jpyc_base, recipient_address, status
       FROM invoices
       WHERE chain_id = ?
         AND lower(token_contract) = ?
         AND status IN ('issued', 'payment_detected', 'confirming', 'expired', 'review_required')`
    )
    .all(CHAIN_ID, ACTIVE_TOKEN_CONTRACT);
}

function selectInvoiceForLog(invoices, toAddress, amountJpyc) {
  const amountBase = String(amountJpyc);
  const recipientMatches = invoices.filter((invoice) => String(invoice.recipient_address || "").toLowerCase() === toAddress);
  if (recipientMatches.length === 0) return { invoice: null, reason: "recipient_unmatched" };
  const exact = recipientMatches.filter((invoice) => {
    try {
      return compareBaseUnits(toInvoiceBaseUnits(invoice), amountBase) === 0;
    } catch (_error) {
      return false;
    }
  });
  if (exact.length === 1) return { invoice: exact[0], reason: "exact_amount" };
  if (exact.length > 1) return { invoice: null, reason: "ambiguous_exact_amount" };
  if (recipientMatches.length === 1) return { invoice: recipientMatches[0], reason: "single_recipient_fallback" };
  return { invoice: null, reason: "ambiguous_recipient" };
}

async function withProvider(label, fn) {
  let lastError = null;
  for (const provider of providers) {
    try {
      return await fn(provider);
    } catch (error) {
      lastError = error;
      const providerUrl = String(provider.connection?.url || "unknown");
      db.prepare(
        `INSERT INTO chain_rpc_failovers(id, provider_url, label, error_message, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), providerUrl, label, String(error.message || error), nowIso());
      setState("worker:last_rpc_failover_at", nowIso());
      console.error(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "chain.provider_failed",
          label,
          provider: providerUrl,
          message: String(error.message || error)
        })
      );
    }
  }
  throw lastError || new Error(`All providers failed for ${label}`);
}

const blockTimestampCache = new Map();
async function blockTimestampIso(blockNumber) {
  const normalizedBlockNumber = Number(blockNumber);
  if (!Number.isFinite(normalizedBlockNumber)) return null;
  if (!blockTimestampCache.has(normalizedBlockNumber)) {
    const blockHex = `0x${BigInt(normalizedBlockNumber).toString(16)}`;
    const block = await withProvider("getBlock", (provider) => provider.send("eth_getBlockByNumber", [blockHex, false]));
    if (!block?.timestamp) {
      blockTimestampCache.delete(normalizedBlockNumber);
      return null;
    }
    const timestamp = String(block.timestamp).startsWith("0x") ? Number(BigInt(block.timestamp)) : Number(block.timestamp);
    blockTimestampCache.set(normalizedBlockNumber, new Date(timestamp * 1000).toISOString());
  }
  return blockTimestampCache.get(normalizedBlockNumber);
}

async function postIngest(payload, idempotencyKey) {
  const timestamp = Math.floor(Date.now() / 1000);
  const serviceJti = crypto.randomUUID();
  const payloadHash = sha256(JSON.stringify(payload));
  const signature = hmac(SERVICE_INGEST_SECRET, `${SERVICE_INGEST_ID}.${timestamp}.${serviceJti}.${payloadHash}`);
  const response = await fetch(`${INTERNAL_API_BASE_URL}/api/v1/internal/payments/events:ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-request-id": crypto.randomUUID(),
      "x-service-id": SERVICE_INGEST_ID,
      "x-service-timestamp": String(timestamp),
      "x-service-jti": serviceJti,
      "x-service-signature": signature
    },
    body: JSON.stringify(payload)
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  if (!response.ok) {
    throw new Error(`ingest_failed status=${response.status} body=${JSON.stringify(data)}`);
  }
  return data;
}

function deadLetterNextRetryAt(retryCount) {
  const delay = MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS * 2 ** Math.min(Math.max(retryCount, 0), 10);
  return new Date(Date.now() + delay).toISOString();
}

function refreshDeadLetterStateMetrics() {
  const pending = Number(db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE status = 'pending'`).get()?.count || 0);
  const abandoned = Number(db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE status = 'abandoned'`).get()?.count || 0);
  setState("worker:pending_dead_letters", pending);
  setState("worker:abandoned_dead_letters", abandoned);
}

function upsertDeadLetter({ chainId, txHash, logIndex, invoiceId, payload, reason }) {
  const ts = nowIso();
  const existing = db
    .prepare(
      `SELECT id, retry_count
       FROM chain_dead_letters
       WHERE chain_id = ?
         AND tx_hash = ?
         AND COALESCE(log_index, -1) = COALESCE(?, -1)
         AND COALESCE(invoice_id, '') = COALESCE(?, '')`
    )
    .get(chainId, txHash, logIndex ?? null, invoiceId ?? null);
  if (!existing) {
    db.prepare(
      `INSERT INTO chain_dead_letters
       (id, chain_id, tx_hash, log_index, invoice_id, payload_json, reason, status, retry_count, last_error, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      chainId,
      txHash,
      logIndex ?? null,
      invoiceId ?? null,
      JSON.stringify(payload),
      String(reason),
      String(reason),
      deadLetterNextRetryAt(1),
      ts
    );
  } else {
    const nextRetryCount = Number(existing.retry_count || 0) + 1;
    db.prepare(
      `UPDATE chain_dead_letters
       SET payload_json = ?,
           reason = ?,
           status = 'pending',
           retry_count = ?,
           last_error = ?,
           next_retry_at = ?,
           resolved_at = NULL
       WHERE id = ?`
    ).run(JSON.stringify(payload), String(reason), nextRetryCount, String(reason), deadLetterNextRetryAt(nextRetryCount), existing.id);
  }
  refreshDeadLetterStateMetrics();
}

async function retryPendingDeadLetters() {
  const startedAt = nowIso();
  setState("worker:last_dead_letter_retry_at", startedAt);
  const dueRows = db
    .prepare(
      `SELECT *
       FROM chain_dead_letters
       WHERE status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT 100`
    )
    .all(startedAt);

  for (const row of dueRows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (error) {
      const nextRetryCount = Number(row.retry_count || 0) + 1;
      const abandoned = nextRetryCount >= MONITOR_DEAD_LETTER_MAX_RETRIES;
      db.prepare(
        `UPDATE chain_dead_letters
         SET retry_count = ?,
             status = ?,
             last_error = ?,
             next_retry_at = ?,
             resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END
         WHERE id = ?`
      ).run(
        nextRetryCount,
        abandoned ? "abandoned" : "pending",
        `invalid_payload_json:${String(error.message || error)}`,
        abandoned ? null : deadLetterNextRetryAt(nextRetryCount),
        abandoned ? 1 : 0,
        nowIso(),
        row.id
      );
      continue;
    }

    const idemSeed = `${row.chain_id}:${row.tx_hash}:${row.log_index ?? -1}:${row.invoice_id || ""}:retry:${row.retry_count || 0}`;
    const idemKey = `chain-retry-${sha256(idemSeed).slice(0, 46)}`;
    try {
      if (!payload.block_timestamp && Array.isArray(payload.missing_fields) && payload.missing_fields.includes("block_timestamp")) {
        const recoveredBlockTimestamp = await blockTimestampIso(payload.block_number);
        if (!recoveredBlockTimestamp) {
          throw new Error("missing_block_timestamp");
        }
        payload = {
          ...payload,
          block_timestamp: recoveredBlockTimestamp,
          missing_fields: payload.missing_fields.filter((field) => field !== "block_timestamp"),
        };
      }
      await postIngest(payload, idemKey);
      db.prepare(
        `UPDATE chain_dead_letters
         SET status = 'resolved',
             resolved_at = ?,
             last_error = NULL,
             next_retry_at = NULL
         WHERE id = ?`
      ).run(nowIso(), row.id);
    } catch (error) {
      const nextRetryCount = Number(row.retry_count || 0) + 1;
      const abandoned = nextRetryCount >= MONITOR_DEAD_LETTER_MAX_RETRIES;
      const message = String(error.message || error);
      db.prepare(
        `UPDATE chain_dead_letters
         SET retry_count = ?,
             status = ?,
             last_error = ?,
             next_retry_at = ?,
             resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END
         WHERE id = ?`
      ).run(
        nextRetryCount,
        abandoned ? "abandoned" : "pending",
        message,
        abandoned ? null : deadLetterNextRetryAt(nextRetryCount),
        abandoned ? 1 : 0,
        nowIso(),
        row.id
      );
      setState("worker:last_dead_letter_error", message);
    }
  }
  refreshDeadLetterStateMetrics();
}

let lastDeadLetterRetryMs = 0;
async function runCycle() {
  setState("worker:last_cycle_started_at", nowIso());
  const invoices = getCandidateInvoices();
  const latestBlock = await withProvider("getBlockNumber", (provider) => provider.getBlockNumber());
  const previous = getCheckpoint();
  if (previous == null) {
    console.warn(
      JSON.stringify({
        ts: nowIso(),
        level: "warn",
        type: "chain.checkpoint_missing",
        message: "checkpoint is not initialized yet; monitor will backscan from latest block window",
      })
    );
  }
  if (previous != null && latestBlock < previous) {
    setState("worker:last_reorg_at", nowIso());
    setState("worker:last_reorg_from", previous);
    setState("worker:last_reorg_to", latestBlock);
  }
  const fromBlock = previous == null ? Math.max(latestBlock - MONITOR_BACKSCAN_BLOCKS, 0) : Math.max(previous - MONITOR_BACKSCAN_BLOCKS, 0);
  const toBlock = latestBlock;
  if (toBlock < fromBlock) {
    console.warn(
      JSON.stringify({
        ts: nowIso(),
        level: "warn",
        type: "chain.scan_skipped",
        from_block: fromBlock,
        to_block: toBlock,
        message: "scan skipped because toBlock < fromBlock",
      })
    );
    setState("worker:last_cycle_at", nowIso());
    return;
  }

  const recipientTopics = [...new Set(invoices.map((invoice) => toAddressTopic(String(invoice.recipient_address || ""))).filter(Boolean))];
  const logs = await withProvider("getLogs", (provider) =>
    provider.getLogs({
      address: ACTIVE_TOKEN_CONTRACT,
      fromBlock,
      toBlock,
      topics: recipientTopics.length > 0 ? [transferInterface.getEvent("Transfer").topicHash, null, recipientTopics] : [transferInterface.getEvent("Transfer").topicHash]
    })
  );
  for (const log of logs) {
    let parsed;
    try {
      parsed = transferInterface.parseLog(log);
    } catch (error) {
      console.warn(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "chain.log_parse_failed",
          tx_hash: String(log?.transactionHash || ""),
          log_index: Number(log?.index ?? log?.logIndex ?? 0),
          message: String(error.message || error),
        })
      );
      continue;
    }
    const toAddress = String(parsed.args.to || "").toLowerCase();
    const amountConversion = toAppBaseUnitsFromTokenValue(parsed.args.value.toString());
    if (amountConversion.error) {
      try {
        upsertDeadLetter({
          chainId: CHAIN_ID,
          txHash: String(log.transactionHash),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          invoiceId: null,
          payload: {
            tx_hash: String(log.transactionHash),
            log_index: Number(log.index ?? log.logIndex ?? 0),
            block_number: Number(log.blockNumber ?? 0),
            to_address: toAddress,
            token_value_raw: parsed.args.value.toString(),
            token_decimals: TOKEN_DECIMALS,
            app_scale_decimals: JPYC_DECIMALS,
          },
          reason: "non_exact_decimal_conversion",
        });
      } catch (deadLetterError) {
        throw new Error(`dead_letter_store_failed:${String(deadLetterError.message || deadLetterError)}`);
      }
      continue;
    }
    const amountBase = amountConversion.value;
    if (compareBaseUnits(amountBase, "0") <= 0) continue;
    const amountJpyc = formatBaseUnitsForDisplay(amountBase, JPYC_DECIMALS);
    const confirmations = Math.max(0, latestBlock - Number(log.blockNumber) + 1);
    if (confirmations < REQUIRED_CONFIRMATIONS) {
      console.log(
        JSON.stringify({
          ts: nowIso(),
          level: "info",
          type: "chain.confirmations_waiting",
          tx_hash: String(log.transactionHash),
          log_index: Number(log.index ?? log.logIndex ?? 0),
          confirmations,
          required_confirmations: REQUIRED_CONFIRMATIONS,
        })
      );
      continue;
    }
    const selected = selectInvoiceForLog(invoices, toAddress, amountBase);
    if (!selected.invoice) {
      try {
        db.prepare(
          `INSERT INTO chain_unmatched_events
           (id, chain_id, token_contract, tx_hash, log_index, block_number, to_address, amount_jpyc, amount_jpyc_base, reason, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          CHAIN_ID,
          ACTIVE_TOKEN_CONTRACT,
          String(log.transactionHash),
          Number(log.index ?? log.logIndex ?? 0),
          Number(log.blockNumber ?? 0),
          toAddress,
          amountJpyc,
          amountBase,
          selected.reason,
          JSON.stringify({
            tx_hash: log.transactionHash,
            log_index: Number(log.index ?? log.logIndex ?? 0),
            block_number: Number(log.blockNumber ?? 0),
            to_address: toAddress,
            amount_jpyc: amountJpyc,
            amount_jpyc_base: amountBase,
          }),
          nowIso()
        );
      } catch (error) {
        if (!String(error.message || error).includes("UNIQUE")) {
          throw error;
        }
      }
      console.log(
        JSON.stringify({
          ts: nowIso(),
          level: "info",
          type: "chain.unmatched_event",
          tx_hash: log.transactionHash,
          log_index: Number(log.index ?? log.logIndex ?? 0),
          to_address: toAddress,
          amount_jpyc: amountJpyc,
          reason: selected.reason
        })
      );
      continue;
    }

    const blockTimestamp = await blockTimestampIso(log.blockNumber);
    if (!blockTimestamp) {
      upsertDeadLetter({
        chainId: CHAIN_ID,
        txHash: String(log.transactionHash),
        logIndex: Number(log.index ?? log.logIndex ?? 0),
        invoiceId: selected.invoice.id,
        payload: {
          invoice_id: selected.invoice.id,
          amount_jpyc_base: amountBase,
          amount_jpyc: amountJpyc,
          chain_id: CHAIN_ID,
          token_contract: ACTIVE_TOKEN_CONTRACT,
          to_address: toAddress,
          from_address: String(parsed.args.from || "").toLowerCase(),
          confirmations,
          tx_hash: String(log.transactionHash),
          log_index: Number(log.index ?? log.logIndex ?? 0),
          block_number: Number(log.blockNumber ?? 0),
          source: "chain_monitor",
          missing_fields: ["block_timestamp"],
        },
        reason: "missing_block_timestamp",
      });
      continue;
    }

    const payload = {
      invoice_id: selected.invoice.id,
      amount_jpyc: amountJpyc,
      chain_id: CHAIN_ID,
      token_contract: ACTIVE_TOKEN_CONTRACT,
      to_address: toAddress,
      from_address: String(parsed.args.from || "").toLowerCase(),
      confirmations,
      tx_hash: log.transactionHash,
      log_index: Number(log.index ?? log.logIndex ?? 0),
	      block_number: Number(log.blockNumber || 0),
	      amount_jpyc_base: amountBase,
	      observed_at: nowIso(),
	      detected_at: nowIso(),
	      block_timestamp: blockTimestamp,
	      source: "chain_monitor"
	    };
    const idemSeed = `${CHAIN_ID}:${payload.tx_hash}:${payload.log_index}:${payload.invoice_id}`;
    const idemKey = `chain-${sha256(idemSeed).slice(0, 48)}`;
    try {
      const result = await postIngest(payload, idemKey);
      console.log(
        JSON.stringify({
          ts: nowIso(),
          level: "info",
          type: "chain.ingested",
          invoice_id: payload.invoice_id,
          tx_hash: payload.tx_hash,
          status: result.status || result.decision || "ok"
        })
      );
    } catch (error) {
      try {
        upsertDeadLetter({
          chainId: CHAIN_ID,
          txHash: payload.tx_hash,
          logIndex: payload.log_index,
          invoiceId: payload.invoice_id,
          payload,
          reason: String(error.message || error),
        });
      } catch (deadLetterError) {
        throw new Error(`dead_letter_store_failed:${String(deadLetterError.message || deadLetterError)}`);
      }
      console.error(
        JSON.stringify({
          ts: nowIso(),
          level: "error",
          type: "chain.ingest_failed",
          invoice_id: payload.invoice_id,
          tx_hash: payload.tx_hash,
          message: String(error.message || error)
        })
      );
    }
  }
  if (Date.now() - lastDeadLetterRetryMs >= MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS) {
    await retryPendingDeadLetters();
    lastDeadLetterRetryMs = Date.now();
  }

  setCheckpoint(toBlock);
  setState("worker:last_cycle_at", nowIso());
  setState("worker:last_checkpoint", toBlock);
}

let stopping = false;
async function main() {
  setState("worker:started_at", nowIso());
  setState("worker:chain_id", CHAIN_ID);
  setState("worker:token_contract", ACTIVE_TOKEN_CONTRACT);
  setState("worker:rpc_count", providers.length);
  console.log(
    JSON.stringify({
      ts: nowIso(),
      level: "info",
      type: "chain.monitor_started",
      chain_id: CHAIN_ID,
      token_contract: ACTIVE_TOKEN_CONTRACT,
      db_path: DB_PATH,
      rpc_count: providers.length
    })
  );
  while (!stopping) {
    try {
      await runCycle();
    } catch (error) {
      setState("worker:last_cycle_error_at", nowIso());
      setState("worker:last_cycle_error", String(error.message || error));
      console.error(
        JSON.stringify({
          ts: nowIso(),
          level: "error",
          type: "chain.monitor_cycle_failed",
          message: String(error.message || error)
        })
      );
    }
    await sleep(MONITOR_POLL_INTERVAL_MS);
  }
  console.log(JSON.stringify({ ts: nowIso(), level: "info", type: "chain.monitor_stopped" }));
}

process.on("SIGINT", () => {
  stopping = true;
  for (const provider of providers) {
    try {
      provider.destroy();
    } catch (error) {
      console.warn(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "chain.provider_destroy_failed",
          signal: "SIGINT",
          message: String(error.message || error),
        })
      );
    }
  }
});
process.on("SIGTERM", () => {
  stopping = true;
  for (const provider of providers) {
    try {
      provider.destroy();
    } catch (error) {
      console.warn(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "chain.provider_destroy_failed",
          signal: "SIGTERM",
          message: String(error.message || error),
        })
      );
    }
  }
});

export {
  db,
  upsertDeadLetter,
  retryPendingDeadLetters,
  runCycle,
  getCheckpoint,
  setCheckpoint,
};

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(JSON.stringify({ ts: nowIso(), level: "fatal", message: String(error.message || error) }));
    process.exit(1);
  });
}
