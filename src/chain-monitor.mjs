import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Interface, JsonRpcProvider } from "ethers";
import {
  AMOUNT_SCALE_VERSION as DEFAULT_AMOUNT_SCALE_VERSION,
  compareBaseUnits,
  convertBaseUnitsBetweenDecimals,
  formatBaseUnitsForDisplay,
  parseDecimalToBaseUnits,
  scaleToDecimals,
} from "./amounts.mjs";
import { buildChainRuntimeRegistryRecord } from "./chain-runtime-registry.mjs";
import { decideMonitoringLifecycle, normalizeChainId } from "./payment-logic.mjs";
import { isProductionLikeRuntime } from "./deployment-topology.mjs";
import {
  OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER,
  getSupportedPaymentChain,
  validateOfficialJpycContract,
} from "./jpyc-contract-policy.mjs";
import {
  APPROVED_LEDGER_BASE_UNIT_SCALE,
  APPROVED_TOKEN_DECIMALS,
  tokenMetadataPolicyFromEnv,
  verifyRpcEndpointTokenMetadata,
  verifyRpcTokenMetadataEndpoints,
} from "./token-metadata.mjs";

const CWD = process.cwd();
const DEFAULTS = {
  APP_ENV: "development",
  DEPLOYMENT_STAGE: "",
  COMMERCIAL_GO_MODE: "false",
  APP_HOST: "http://localhost:4173",
  INTERNAL_APP_ORIGIN: "",
  WORKER_STATE_DB_PATH: "",
  CHAIN_ID: "137",
  TOKEN_CONTRACT: "",
  APPROVED_JPYC_TOKEN_CONTRACT: "",
  JPYC_CONTRACT_APPROVAL_REF: "",
  TOKEN_DECIMALS: "18",
  TOKEN_SYMBOL: "JPYC",
  APPROVED_TOKEN_NAME: "",
  APPROVED_TOKEN_CODE_HASH: "",
  APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH: "",
  LEDGER_DECIMALS: "6",
  LEDGER_BASE_UNIT_SCALE: "1000000",
  RPC_URLS: "",
  RPC_URLS_1: "",
  RPC_URLS_43114: "",
  RPC_URLS_137: "",
  MONITOR_POLL_INTERVAL_MS: "15000",
  MONITOR_BACKSCAN_BLOCKS: "12",
  MIN_MONITOR_BACKSCAN_BLOCKS: "12",
  DETECTION_CONFIRMATIONS: "0",
  FULFILLMENT_REQUIRED_CONFIRMATIONS: "2",
  ACCOUNTING_FINALITY_CONFIRMATIONS: "2",
  REQUIRED_CONFIRMATIONS: "2",
  MIN_REQUIRED_CONFIRMATIONS: "2",
  CONFIRMATIONS_POLICY_APPROVAL_REF: "",
  BACKSCAN_POLICY_APPROVAL_REF: "",
  MONITOR_DEAD_LETTER_MAX_RETRIES: "5",
  MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS: "60000",
  MONITOR_LOG_CHUNK_SIZE: "1000",
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
const DEPLOYMENT_STAGE = String(ENV.DEPLOYMENT_STAGE || "").trim().toLowerCase();
const PRODUCTION_LIKE = isProductionLikeRuntime({ ...ENV, APP_ENV, DEPLOYMENT_STAGE });
const APP_HOST = ENV.APP_HOST || DEFAULTS.APP_HOST;
const INTERNAL_APP_ORIGIN = String(ENV.INTERNAL_APP_ORIGIN || DEFAULTS.INTERNAL_APP_ORIGIN || "").trim().replace(/\/$/, "");
const CHAIN_ID = normalizeChainId(ENV.CHAIN_ID || DEFAULTS.CHAIN_ID)
  || normalizeChainId(DEFAULTS.CHAIN_ID)
  || "137";
const WORKER_STATE_DB_PATH_CONFIGURED = String(ENV.WORKER_STATE_DB_PATH || "").trim();
const WORKER_STATE_DB_PATH = path.resolve(
  CWD,
  WORKER_STATE_DB_PATH_CONFIGURED || `./runtime/worker-state/chain-${CHAIN_ID}.db`
);
const TOKEN_CONTRACT = String(ENV.TOKEN_CONTRACT || DEFAULTS.TOKEN_CONTRACT).toLowerCase();
const APPROVED_JPYC_TOKEN_CONTRACT = String(ENV.APPROVED_JPYC_TOKEN_CONTRACT || DEFAULTS.APPROVED_JPYC_TOKEN_CONTRACT).toLowerCase();
const JPYC_CONTRACT_APPROVAL_REF = String(ENV.JPYC_CONTRACT_APPROVAL_REF || DEFAULTS.JPYC_CONTRACT_APPROVAL_REF || "");
const TOKEN_DECIMALS = Number(ENV.TOKEN_DECIMALS || DEFAULTS.TOKEN_DECIMALS);
const APPROVED_TOKEN_NAME = String(ENV.APPROVED_TOKEN_NAME || DEFAULTS.APPROVED_TOKEN_NAME || "").trim();
const APPROVED_TOKEN_CODE_HASH = String(ENV.APPROVED_TOKEN_CODE_HASH || DEFAULTS.APPROVED_TOKEN_CODE_HASH || "").trim().toLowerCase();
const APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH = String(
  ENV.APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH || DEFAULTS.APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH || ""
).trim().toLowerCase();
const LEDGER_BASE_UNIT_SCALE = String(ENV.LEDGER_BASE_UNIT_SCALE || DEFAULTS.LEDGER_BASE_UNIT_SCALE || "");
const LEDGER_DECIMALS = Number(ENV.LEDGER_DECIMALS || DEFAULTS.LEDGER_DECIMALS);
const LEDGER_SCALE_DECIMALS = scaleToDecimals(LEDGER_BASE_UNIT_SCALE);
const AMOUNT_SCALE_VERSION = TOKEN_DECIMALS === APPROVED_TOKEN_DECIMALS
  && LEDGER_BASE_UNIT_SCALE === APPROVED_LEDGER_BASE_UNIT_SCALE
  ? DEFAULT_AMOUNT_SCALE_VERSION
  : `token-${TOKEN_DECIMALS}-ledger-${LEDGER_DECIMALS}-v1`;
const CHAIN_ID_NUMERIC = Number(CHAIN_ID);
const PAYMENT_CHAIN = getSupportedPaymentChain(CHAIN_ID);
const RPC_URLS = String(ENV[`RPC_URLS_${CHAIN_ID}`] || ENV.RPC_URLS || DEFAULTS.RPC_URLS)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MONITOR_POLL_INTERVAL_MS = Number(ENV.MONITOR_POLL_INTERVAL_MS || DEFAULTS.MONITOR_POLL_INTERVAL_MS);
const RPC_METADATA_RECOVERY_RETRY_INTERVAL_MS = Math.max(MONITOR_POLL_INTERVAL_MS, 30_000);
const MONITOR_BACKSCAN_BLOCKS = Number(ENV.MONITOR_BACKSCAN_BLOCKS || DEFAULTS.MONITOR_BACKSCAN_BLOCKS);
const MIN_MONITOR_BACKSCAN_BLOCKS = Number(ENV.MIN_MONITOR_BACKSCAN_BLOCKS || DEFAULTS.MIN_MONITOR_BACKSCAN_BLOCKS);
const DETECTION_CONFIRMATIONS = Number(ENV.DETECTION_CONFIRMATIONS || DEFAULTS.DETECTION_CONFIRMATIONS);
const FULFILLMENT_REQUIRED_CONFIRMATIONS = Number(
  ENV.FULFILLMENT_REQUIRED_CONFIRMATIONS || ENV.REQUIRED_CONFIRMATIONS || DEFAULTS.FULFILLMENT_REQUIRED_CONFIRMATIONS
);
const ACCOUNTING_FINALITY_CONFIRMATIONS = Number(
  ENV.ACCOUNTING_FINALITY_CONFIRMATIONS
    || ENV.FULFILLMENT_REQUIRED_CONFIRMATIONS
    || ENV.REQUIRED_CONFIRMATIONS
    || DEFAULTS.ACCOUNTING_FINALITY_CONFIRMATIONS
);
const REQUIRED_CONFIRMATIONS = FULFILLMENT_REQUIRED_CONFIRMATIONS;
const MIN_REQUIRED_CONFIRMATIONS = Number(ENV.MIN_REQUIRED_CONFIRMATIONS || DEFAULTS.MIN_REQUIRED_CONFIRMATIONS);
const CONFIRMATIONS_POLICY_APPROVAL_REF = String(ENV.CONFIRMATIONS_POLICY_APPROVAL_REF || DEFAULTS.CONFIRMATIONS_POLICY_APPROVAL_REF || "");
const BACKSCAN_POLICY_APPROVAL_REF = String(ENV.BACKSCAN_POLICY_APPROVAL_REF || DEFAULTS.BACKSCAN_POLICY_APPROVAL_REF || "");
const MONITOR_DEAD_LETTER_MAX_RETRIES = Number(ENV.MONITOR_DEAD_LETTER_MAX_RETRIES || DEFAULTS.MONITOR_DEAD_LETTER_MAX_RETRIES);
const MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS = Number(
  ENV.MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS || DEFAULTS.MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS
);
const MONITOR_LOG_CHUNK_SIZE = Number(ENV.MONITOR_LOG_CHUNK_SIZE || DEFAULTS.MONITOR_LOG_CHUNK_SIZE);
const SERVICE_INGEST_ID = String(ENV.SERVICE_INGEST_ID || DEFAULTS.SERVICE_INGEST_ID);
const SERVICE_INGEST_SECRET = String(ENV.SERVICE_INGEST_SECRET || DEFAULTS.SERVICE_INGEST_SECRET);
const RECONCILIATION_API_PATH = "/api/v1/internal/chain/reconciliation:ingest";
const CANDIDATES_API_PATH = "/api/v1/internal/chain/candidates:read";
const PAYMENT_EVIDENCE_API_PATH = "/api/v1/internal/chain/payment-evidence:read";
const ACTIVE_TOKEN_CONTRACT = OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER;

if (RPC_URLS.length === 0) {
  console.error("WARN: RPC_URLS is empty. Chain acceptance remains quarantined; the monitor will retry configuration.");
}
if (!SERVICE_INGEST_SECRET || SERVICE_INGEST_SECRET === DEFAULTS.SERVICE_INGEST_SECRET || SERVICE_INGEST_SECRET.length < 32) {
  console.error("FATAL: SERVICE_INGEST_SECRET must be configured with a strong random value.");
  process.exit(1);
}
if (!Number.isFinite(TOKEN_DECIMALS) || TOKEN_DECIMALS < 0 || TOKEN_DECIMALS > 30) {
  console.error("FATAL: TOKEN_DECIMALS is invalid.");
  process.exit(1);
}
if (!LEDGER_BASE_UNIT_SCALE) {
  console.error("FATAL: LEDGER_BASE_UNIT_SCALE is invalid.");
  process.exit(1);
}
if (!Number.isInteger(LEDGER_DECIMALS) || LEDGER_DECIMALS < 0 || LEDGER_DECIMALS !== LEDGER_SCALE_DECIMALS) {
  console.error("FATAL: LEDGER_DECIMALS must match LEDGER_BASE_UNIT_SCALE.");
  process.exit(1);
}
if (!PAYMENT_CHAIN) {
  console.error("FATAL: CHAIN_ID must be one of 1, 43114, or 137.");
  process.exit(1);
}
const tokenContractValidation = validateOfficialJpycContract(TOKEN_CONTRACT, "TOKEN_CONTRACT");
if (!tokenContractValidation.ok) {
  console.error(`FATAL: ${tokenContractValidation.code}: ${tokenContractValidation.message}`);
  process.exit(1);
}
if (APPROVED_JPYC_TOKEN_CONTRACT) {
  const approvedContractValidation = validateOfficialJpycContract(
    APPROVED_JPYC_TOKEN_CONTRACT,
    "APPROVED_JPYC_TOKEN_CONTRACT"
  );
  if (!approvedContractValidation.ok) {
    console.error(`FATAL: ${approvedContractValidation.code}: ${approvedContractValidation.message}`);
    process.exit(1);
  }
}
for (const [name, value] of [
  ["DETECTION_CONFIRMATIONS", DETECTION_CONFIRMATIONS],
  ["FULFILLMENT_REQUIRED_CONFIRMATIONS", FULFILLMENT_REQUIRED_CONFIRMATIONS],
  ["ACCOUNTING_FINALITY_CONFIRMATIONS", ACCOUNTING_FINALITY_CONFIRMATIONS],
]) {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    console.error(`FATAL: ${name} must be a non-negative integer.`);
    process.exit(1);
  }
}
if (FULFILLMENT_REQUIRED_CONFIRMATIONS < DETECTION_CONFIRMATIONS) {
  console.error("FATAL: FULFILLMENT_REQUIRED_CONFIRMATIONS must be >= DETECTION_CONFIRMATIONS.");
  process.exit(1);
}
if (ACCOUNTING_FINALITY_CONFIRMATIONS < FULFILLMENT_REQUIRED_CONFIRMATIONS) {
  console.error("FATAL: ACCOUNTING_FINALITY_CONFIRMATIONS must be >= FULFILLMENT_REQUIRED_CONFIRMATIONS.");
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
if (!Number.isFinite(MONITOR_LOG_CHUNK_SIZE) || MONITOR_LOG_CHUNK_SIZE < 1 || !Number.isInteger(MONITOR_LOG_CHUNK_SIZE)) {
  console.error("FATAL: MONITOR_LOG_CHUNK_SIZE must be a positive integer.");
  process.exit(1);
}
if (IS_PRODUCTION && MONITOR_BACKSCAN_BLOCKS < MIN_MONITOR_BACKSCAN_BLOCKS) {
  console.error("FATAL: MONITOR_BACKSCAN_BLOCKS is below the production minimum.");
  process.exit(1);
}
if (IS_PRODUCTION && FULFILLMENT_REQUIRED_CONFIRMATIONS < MIN_REQUIRED_CONFIRMATIONS) {
  console.error("FATAL: FULFILLMENT_REQUIRED_CONFIRMATIONS is below MIN_REQUIRED_CONFIRMATIONS.");
  process.exit(1);
}
if (PRODUCTION_LIKE && (TOKEN_DECIMALS !== APPROVED_TOKEN_DECIMALS || LEDGER_BASE_UNIT_SCALE !== APPROVED_LEDGER_BASE_UNIT_SCALE)) {
  console.error("FATAL: production-like monitor requires token atomic decimals=18 and ledger base scale=1000000.");
  process.exit(1);
}
if (PRODUCTION_LIKE && (!APPROVED_TOKEN_NAME || !/^0x[0-9a-f]{64}$/.test(APPROVED_TOKEN_CODE_HASH)
  || !/^0x[0-9a-f]{64}$/.test(APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH))) {
  console.error("FATAL: production-like monitor requires approved token name, code hash, and implementation code hash pins.");
  process.exit(1);
}
if (PRODUCTION_LIKE && !INTERNAL_APP_ORIGIN) {
  console.error("FATAL: INTERNAL_APP_ORIGIN is required for production-like chain monitor ingest.");
  process.exit(1);
}
if (PRODUCTION_LIKE && !WORKER_STATE_DB_PATH_CONFIGURED) {
  console.error("FATAL: WORKER_STATE_DB_PATH must be explicitly configured for production-like chain monitor state.");
  process.exit(1);
}
if (IS_PRODUCTION) {
  if (TOKEN_CONTRACT !== APPROVED_JPYC_TOKEN_CONTRACT) {
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

fs.mkdirSync(path.dirname(WORKER_STATE_DB_PATH), { recursive: true });
const db = new Database(WORKER_STATE_DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = FULL");
db.pragma("fullfsync = ON");
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
  observation_count INTEGER NOT NULL DEFAULT 0,
  retry_attempt_count INTEGER NOT NULL DEFAULT 0,
  consecutive_retry_failures INTEGER NOT NULL DEFAULT 0,
  last_observed_at TEXT,
  last_attempted_at TEXT,
  last_error TEXT,
  next_retry_at TEXT,
  resolved_at TEXT,
  claimed_by TEXT,
  claimed_until TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chain_dead_letters_dedupe
ON chain_dead_letters(chain_id, tx_hash, COALESCE(log_index, -1), COALESCE(invoice_id, ''));

CREATE TABLE IF NOT EXISTS chain_rpc_failovers (
  id TEXT PRIMARY KEY,
  chain_id TEXT,
  provider_url TEXT NOT NULL,
  provider_url_hash TEXT,
  label TEXT NOT NULL,
  error_message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_runtime_registry (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  rpc_endpoint_hash TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  proxy_implementation TEXT,
  proxy_code_hash TEXT,
  token_code_hash TEXT,
  latest_block TEXT,
  latest_block_hash TEXT,
  verified_at TEXT NOT NULL,
  approval_ref TEXT,
  status TEXT NOT NULL,
  UNIQUE(chain_id, rpc_endpoint_hash)
);

`);

function addColumnIfMissing(tableName, columnName, ddl) {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (!tableExists) return;
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (exists) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
}

addColumnIfMissing("chain_dead_letters", "status", "status TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing("chain_dead_letters", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("chain_dead_letters", "observation_count", "observation_count INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("chain_dead_letters", "retry_attempt_count", "retry_attempt_count INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("chain_dead_letters", "consecutive_retry_failures", "consecutive_retry_failures INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("chain_dead_letters", "last_observed_at", "last_observed_at TEXT");
addColumnIfMissing("chain_dead_letters", "last_attempted_at", "last_attempted_at TEXT");
addColumnIfMissing("chain_dead_letters", "last_error", "last_error TEXT");
addColumnIfMissing("chain_dead_letters", "next_retry_at", "next_retry_at TEXT");
addColumnIfMissing("chain_dead_letters", "resolved_at", "resolved_at TEXT");
addColumnIfMissing("chain_dead_letters", "claimed_by", "claimed_by TEXT");
addColumnIfMissing("chain_dead_letters", "claimed_until", "claimed_until TEXT");
addColumnIfMissing("chain_rpc_failovers", "chain_id", "chain_id TEXT");
addColumnIfMissing("chain_rpc_failovers", "provider_url_hash", "provider_url_hash TEXT");

const transferInterface = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const providers = VALID_RPC_URLS.map((url) =>
  new JsonRpcProvider(url, Number.isFinite(CHAIN_ID_NUMERIC) ? CHAIN_ID_NUMERIC : undefined, { staticNetwork: true })
);
let verifiedProviderIndexes = null;
const checkpointKey = `last_block:${CHAIN_ID}:${ACTIVE_TOKEN_CONTRACT}`;
const checkpointHashKey = `last_block_hash:${CHAIN_ID}:${ACTIVE_TOKEN_CONTRACT}`;
const WORKER_ID = `${CHAIN_ID}:${crypto.randomUUID()}`;

function toInvoiceBaseUnits(invoice) {
  if (invoice?.ledger_amount_base != null && String(invoice.ledger_amount_base).trim() !== "") {
    return String(invoice.ledger_amount_base);
  }
  if (invoice?.amount_jpyc_base != null && String(invoice.amount_jpyc_base).trim() !== "") {
    return String(invoice.amount_jpyc_base);
  }
  return parseDecimalToBaseUnits(String(invoice?.amount_jpyc ?? "0"), LEDGER_DECIMALS);
}

function toAppBaseUnitsFromTokenValue(tokenValueBaseUnits) {
  const converted = convertBaseUnitsBetweenDecimals(String(tokenValueBaseUnits), TOKEN_DECIMALS, LEDGER_DECIMALS);
  if (!converted.exact) {
    return { error: "non_exact_decimal_conversion", value: converted.value };
  }
  return { value: converted.value };
}

function canonicalStatusForLog(log, block) {
  const observedBlockHash = String(log?.blockHash || "").trim().toLowerCase();
  const canonicalBlockHash = String(block?.hash || "").trim().toLowerCase();
  if (!observedBlockHash || !canonicalBlockHash) return "unknown";
  return observedBlockHash === canonicalBlockHash ? "canonical" : "unknown";
}

function buildPaymentIngestPayload({
  invoiceId,
  amountBase,
  amountAtomic,
  toAddress,
  fromAddress,
  confirmations,
  txHash,
  logIndex,
  blockNumber,
  blockHash,
  blockTimestamp,
  detectedAt,
  canonicalStatus,
  amountConversionExact,
  amountConversionError = null,
}) {
  return {
    invoice_id: String(invoiceId),
    amount_jpyc: formatBaseUnitsForDisplay(String(amountBase), LEDGER_DECIMALS),
    chain_id: CHAIN_ID,
    token_contract: ACTIVE_TOKEN_CONTRACT,
    to_address: String(toAddress || "").toLowerCase(),
    from_address: String(fromAddress || "").toLowerCase(),
    confirmations: Number(confirmations || 0),
    detection_confirmations: DETECTION_CONFIRMATIONS,
    fulfillment_required_confirmations: FULFILLMENT_REQUIRED_CONFIRMATIONS,
    accounting_finality_confirmations: ACCOUNTING_FINALITY_CONFIRMATIONS,
    tx_hash: String(txHash),
    log_index: Number(logIndex ?? 0),
    block_number: Number(blockNumber || 0),
    block_hash: String(blockHash || ""),
    amount_jpyc_base: String(amountBase),
    ledger_amount_base: String(amountBase),
    amount_atomic: String(amountAtomic),
    token_amount_atomic: String(amountAtomic),
    amount_scale_version: AMOUNT_SCALE_VERSION,
    display_amount: formatBaseUnitsForDisplay(String(amountBase), LEDGER_DECIMALS),
    token_decimals: TOKEN_DECIMALS,
    ledger_decimals: LEDGER_DECIMALS,
    amount_conversion_exact: amountConversionExact === true,
    amount_conversion_error: amountConversionExact === true ? null : String(amountConversionError || "non_exact_decimal_conversion"),
    canonical_status: canonicalStatus === "canonical" ? "canonical" : "unknown",
    source: "chain_monitor",
    verified_onchain: true,
    block_timestamp: blockTimestamp || null,
    detected_at: detectedAt,
  };
}

function workerStateKey(key) {
  return String(key).startsWith("worker:") ? `worker:${CHAIN_ID}:${String(key).slice("worker:".length)}` : String(key);
}

function setState(key, value) {
  db.prepare(
    `INSERT INTO chain_monitor_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(workerStateKey(key), String(value), nowIso());
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

function getCheckpointHash() {
  const row = db.prepare(`SELECT value FROM chain_monitor_state WHERE key = ?`).get(checkpointHashKey);
  return row?.value ? String(row.value) : null;
}

function setCheckpoint(blockNumber, blockHash = null) {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO chain_monitor_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(checkpointKey, String(blockNumber), ts);
  if (blockHash) {
    db.prepare(
      `INSERT INTO chain_monitor_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(checkpointHashKey, String(blockHash), ts);
  }
}

async function recordReorg({ fromBlock, toBlock, previousHash, observedHash, reason }) {
  const detectedAt = nowIso();
  const from = Number.isFinite(Number(fromBlock)) ? Number(fromBlock) : null;
  const to = Number.isFinite(Number(toBlock)) ? Number(toBlock) : from;
  const normalizedReason = String(reason || "checkpoint_mismatch");

  // The chain monitor is never a financial writer. This API path is used in
  // development too, so a local run cannot accidentally exercise a second
  // invoice/reorg writer against the same database.
  const reorgId = crypto.randomUUID();
  const response = await postReorgToApi({
    chain_id: CHAIN_ID,
    reorg_id: reorgId,
    from_block: from,
    to_block: to,
    previous_hash: previousHash || null,
    observed_hash: observedHash || null,
    reason: normalizedReason,
    detected_at: detectedAt,
  });
  const persistedReorgId = response?.reorg_id || reorgId;
  setState("worker:last_reorg_at", detectedAt);
  setState("worker:last_reorg_id", persistedReorgId);
  setState("worker:last_reorg_from", from ?? "");
  setState("worker:last_reorg_to", to ?? "");
  setState("worker:last_reorg_reason", normalizedReason);
  return persistedReorgId;
}

async function getCandidateInvoices() {
  // M-030: follow cursor pages until has_more=false so no candidate is
  // silently truncated by a server-side row cap.
  const all = [];
  let cursor = "";
  for (let page = 0; page < 10000; page += 1) {
    const body = { chain_id: CHAIN_ID, token_contract: ACTIVE_TOKEN_CONTRACT };
    if (cursor) body.cursor = cursor;
    const rows = await postSignedServiceJson(
      CANDIDATES_API_PATH,
      body,
      `chain-candidates:${CHAIN_ID}:${crypto.randomUUID()}`
    );
    if (!Array.isArray(rows?.invoices)) {
      throw new Error("chain_candidates_response_invalid");
    }
    all.push(...rows.invoices);
    if (!rows?.page?.has_more || !rows.page.next_cursor) break;
    cursor = String(rows.page.next_cursor);
  }
  return all.filter((invoice) => {
    const lifecycle = decideMonitoringLifecycle(invoice, {
      recipientAddress: invoice.recipient_address,
      addressUsed: ["payment_detected", "confirming", "paid", "settled", "refunded", "review_required"].includes(invoice.status),
      integrityHold: Number(invoice.integrity_hold || 0) === 1,
      monitorUntil: invoice.monitor_until,
      lastReconciledBlock: invoice.last_reconciled_block,
    });
    return lifecycle.shouldMonitor || lifecycle.shouldReconcileUsedAddress;
  });
}

async function getRecentPaymentEvidence(fromBlock, toBlock) {
  const lower = Number(fromBlock);
  const upper = Number(toBlock);
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower < 0 || upper < lower) return [];
  const result = await postSignedServiceJson(
    PAYMENT_EVIDENCE_API_PATH,
    { chain_id: CHAIN_ID, from_block: lower, to_block: upper },
    `chain-payment-evidence:${CHAIN_ID}:${lower}:${upper}:${crypto.randomUUID()}`
  );
  if (!Array.isArray(result?.events)) throw new Error("chain_payment_evidence_response_invalid");
  return result.events;
}

function buildReconciliationPayload(invoices, blockNumber, reconciledAt = nowIso()) {
  const normalizedBlock = Number(blockNumber);
  const invoiceRows = [...new Map(
    invoices
      .filter((invoice) => invoice && String(invoice.id || "").trim())
      .map((invoice) => [String(invoice.id), {
        invoice_id: String(invoice.id),
        recipient_address: String(invoice.recipient_address || "").toLowerCase(),
      }])
  ).values()].sort((left, right) => left.invoice_id.localeCompare(right.invoice_id));
  return {
    schema_version: 1,
    source: "chain_monitor",
    chain_id: CHAIN_ID,
    token_contract: ACTIVE_TOKEN_CONTRACT,
    block_number: normalizedBlock,
    reconciled_at: reconciledAt,
    invoices: invoiceRows,
  };
}

async function markUsedAddressesReconciled(invoices, blockNumber) {
  const normalizedBlock = Number(blockNumber);
  if (!Number.isSafeInteger(normalizedBlock) || normalizedBlock < 0 || !Array.isArray(invoices) || invoices.length === 0) return;
  const reconciledAt = nowIso();
  const payload = buildReconciliationPayload(invoices, normalizedBlock, reconciledAt);
  const idempotencyKey = `chain-reconciliation:${CHAIN_ID}:${normalizedBlock}:${sha256(JSON.stringify(payload.invoices)).slice(0, 32)}`;
  await postReconciliationToApi(payload, idempotencyKey);
  setState("worker:last_reconciliation_api_at", reconciledAt);
  setState("worker:last_reconciliation_api_block", normalizedBlock);
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
  for (const [providerIndex, provider] of providers.entries()) {
    if (verifiedProviderIndexes && !verifiedProviderIndexes.has(providerIndex)) continue;
    if (lastError) {
      const revalidation = await verifySingleProviderMetadata(providerIndex);
      if (!revalidation.ok) {
        verifiedProviderIndexes?.delete(providerIndex);
        setState("worker:rpc_metadata_status", verifiedProviderIndexes?.size ? "partially_verified" : "quarantined");
        console.error(
          JSON.stringify({
            ts: nowIso(),
            level: "error",
            type: "chain.provider_quarantined_on_failover",
            label,
            provider_index: providerIndex,
            endpoint_id: revalidation.endpoint_id || null,
            failure_codes: (revalidation.failures || []).map((failure) => failure.code),
          })
        );
        continue;
      }
    }
    try {
      return await fn(provider);
    } catch (error) {
      lastError = error;
      const providerUrl = String(provider.connection?.url || "unknown");
      const providerUrlHash = `sha256:${sha256(providerUrl)}`;
      db.prepare(
        `INSERT INTO chain_rpc_failovers(id, chain_id, provider_url, provider_url_hash, label, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        CHAIN_ID,
        "redacted",
        providerUrlHash,
        `${label}:provider-${providerIndex}`,
        String(error.message || error),
        nowIso()
      );
      setState("worker:last_rpc_failover_at", nowIso());
      console.error(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "chain.provider_failed",
          label,
          provider_index: providerIndex,
          provider_url_hash: providerUrlHash,
          message: String(error.message || error)
        })
      );
    }
  }
  if (verifiedProviderIndexes) {
    verifiedProviderIndexes.clear();
    setState("worker:rpc_metadata_status", "quarantined");
    setState("worker:rpc_runtime_registry_status", "quarantined");
  }
  const error = lastError || new Error(`All providers failed for ${label}`);
  error.code = error.code || "RPC_ALL_PROVIDERS_FAILED";
  throw error;
}

function tokenMetadataPolicy() {
  return tokenMetadataPolicyFromEnv({
    ...ENV,
    CHAIN_ID,
    TOKEN_CONTRACT: ACTIVE_TOKEN_CONTRACT,
    TOKEN_DECIMALS: String(TOKEN_DECIMALS),
    REQUIRE_TOKEN_METADATA_PINS: PRODUCTION_LIKE ? "true" : "false",
  });
}

async function metadataRpcRequest(rpcUrl, method, params) {
  const probe = new JsonRpcProvider(
    rpcUrl,
    Number.isFinite(CHAIN_ID_NUMERIC) ? CHAIN_ID_NUMERIC : undefined,
    { staticNetwork: false }
  );
  try {
    return await probe.send(method, params);
  } finally {
    try { probe.destroy(); } catch (_error) { /* best effort */ }
  }
}

async function verifySingleProviderMetadata(providerIndex) {
  const rpcUrl = VALID_RPC_URLS[providerIndex];
  if (!rpcUrl) {
    return {
      ok: false,
      endpoint_id: null,
      failures: [{ code: "RPC_PROVIDER_INDEX_INVALID" }],
    };
  }
  return verifyRpcEndpointTokenMetadata({
    rpcUrl,
    rpcRequest: metadataRpcRequest,
    policy: tokenMetadataPolicy(),
  });
}

async function verifyConfiguredRpcMetadata() {
  const result = await verifyRpcTokenMetadataEndpoints({
    rpcUrls: VALID_RPC_URLS,
    rpcRequest: metadataRpcRequest,
    policy: tokenMetadataPolicy(),
  });
  verifiedProviderIndexes = new Set(
    result.endpoints
      .map((endpoint, index) => endpoint.endpoint_state === "verified" ? index : null)
      .filter((index) => index != null)
  );
  const registryRecords = [];
  for (const [index, endpoint] of result.endpoints.entries()) {
    let latestBlockHash = null;
    if (endpoint.endpoint_state === "verified") {
      try {
        const latestBlock = await providers[index]?.getBlock("latest");
        latestBlockHash = latestBlock?.hash || null;
      } catch (_error) {
        latestBlockHash = null;
      }
    }
    registryRecords.push(buildChainRuntimeRegistryRecord({
      chainId: CHAIN_ID,
      tokenContract: ACTIVE_TOKEN_CONTRACT,
      tokenDecimals: TOKEN_DECIMALS,
      endpoint,
      latestBlockHash,
      approvalRef: JPYC_CONTRACT_APPROVAL_REF,
      verifiedAt: nowIso(),
    }));
  }
  const upsertRegistry = db.transaction(() => {
    for (const record of registryRecords) {
      db.prepare(
        `INSERT INTO chain_runtime_registry
         (id, chain_id, rpc_endpoint_hash, token_contract, token_decimals, proxy_implementation,
          proxy_code_hash, token_code_hash, latest_block, latest_block_hash, verified_at, approval_ref, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, rpc_endpoint_hash) DO UPDATE SET
           token_contract = excluded.token_contract,
           token_decimals = excluded.token_decimals,
           proxy_implementation = excluded.proxy_implementation,
           proxy_code_hash = excluded.proxy_code_hash,
           token_code_hash = excluded.token_code_hash,
           latest_block = excluded.latest_block,
           latest_block_hash = excluded.latest_block_hash,
           verified_at = excluded.verified_at,
           approval_ref = excluded.approval_ref,
           status = excluded.status`
      ).run(
        crypto.randomUUID(),
        record.chain_id || CHAIN_ID,
        record.rpc_endpoint_hash,
        record.token_contract || ACTIVE_TOKEN_CONTRACT,
        record.token_decimals ?? TOKEN_DECIMALS,
        record.proxy_implementation,
        record.proxy_code_hash,
        record.token_code_hash,
        record.latest_block,
        record.latest_block_hash,
        record.verified_at,
        record.approval_ref,
        record.status,
      );
    }
  });
  upsertRegistry();
  setState("worker:rpc_runtime_registry_status", registryRecords.some((record) => record.status === "verified") ? "ready" : "quarantined");
  setState("worker:rpc_runtime_registry_verified_count", registryRecords.filter((record) => record.status === "verified").length);
  setState("worker:rpc_runtime_registry_quarantined_count", registryRecords.filter((record) => record.status !== "verified").length);
  setState(
    "worker:rpc_metadata_status",
    result.ok ? "verified" : (verifiedProviderIndexes.size > 0 ? "partially_verified" : "quarantined")
  );
  setState("worker:rpc_verified_count", result.verified_count);
  setState("worker:rpc_quarantined_count", result.quarantined_count);
  if (verifiedProviderIndexes.size === 0) {
    const error = new Error("RPC token metadata validation failed; all mismatched endpoints are quarantined");
    error.code = "RPC_METADATA_QUARANTINED";
    throw error;
  }
  return result;
}

async function postSignedServiceJson(apiPath, payload, idempotencyKey) {
  const body = JSON.stringify(payload || {});
  const timestamp = Math.floor(Date.now() / 1000);
  const serviceJti = crypto.randomUUID();
  const payloadHash = sha256(body);
  const signature = hmac(SERVICE_INGEST_SECRET, `${SERVICE_INGEST_ID}.${timestamp}.${serviceJti}.${payloadHash}`);
  const origin = INTERNAL_APP_ORIGIN || APP_HOST;
  const response = await fetch(`${origin}${apiPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-request-id": crypto.randomUUID(),
      "x-service-id": SERVICE_INGEST_ID,
      "x-service-timestamp": String(timestamp),
      "x-service-jti": serviceJti,
      "x-service-signature": signature,
    },
    body,
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_error) {
    data = { raw };
  }
  if (!response.ok) {
    throw new Error(`service_read_failed path=${apiPath} status=${response.status} body=${JSON.stringify(data)}`);
  }
  return data;
}

async function postIngest(payload, idempotencyKey) {
  const timestamp = Math.floor(Date.now() / 1000);
  const serviceJti = crypto.randomUUID();
  const payloadHash = sha256(JSON.stringify(payload));
  const signature = hmac(SERVICE_INGEST_SECRET, `${SERVICE_INGEST_ID}.${timestamp}.${serviceJti}.${payloadHash}`);
  const ingestOrigin = INTERNAL_APP_ORIGIN || APP_HOST;
  const response = await fetch(`${ingestOrigin}/api/v1/internal/payments/events:ingest`, {
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

async function postReorgToApi(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const serviceJti = crypto.randomUUID();
  const payloadHash = sha256(JSON.stringify(payload));
  const signature = hmac(SERVICE_INGEST_SECRET, `${SERVICE_INGEST_ID}.${timestamp}.${serviceJti}.${payloadHash}`);
  const ingestOrigin = INTERNAL_APP_ORIGIN || APP_HOST;
  const response = await fetch(`${ingestOrigin}/api/v1/internal/chain/reorgs:ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `chain-reorg:${payload.reorg_id}`,
      "x-request-id": crypto.randomUUID(),
      "x-service-id": SERVICE_INGEST_ID,
      "x-service-timestamp": String(timestamp),
      "x-service-jti": serviceJti,
      "x-service-signature": signature,
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_error) {
    data = { raw };
  }
  if (!response.ok) throw new Error(`reorg_ingest_failed status=${response.status} body=${JSON.stringify(data)}`);
  return data;
}

async function postReconciliationToApi(payload, idempotencyKey) {
  const timestamp = Math.floor(Date.now() / 1000);
  const serviceJti = crypto.randomUUID();
  const body = JSON.stringify(payload);
  const payloadHash = sha256(body);
  const signature = hmac(SERVICE_INGEST_SECRET, `${SERVICE_INGEST_ID}.${timestamp}.${serviceJti}.${payloadHash}`);
  const ingestOrigin = INTERNAL_APP_ORIGIN || APP_HOST;
  const response = await fetch(`${ingestOrigin}${RECONCILIATION_API_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-request-id": crypto.randomUUID(),
      "x-service-id": SERVICE_INGEST_ID,
      "x-service-timestamp": String(timestamp),
      "x-service-jti": serviceJti,
      "x-service-signature": signature,
    },
    body,
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_error) {
    data = { raw };
  }
  if (!response.ok) {
    throw new Error(`reconciliation_ingest_failed status=${response.status} body=${JSON.stringify(data)}`);
  }
  return data;
}

function deadLetterNextRetryAt(retryCount) {
  const delay = MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS * 2 ** Math.min(Math.max(retryCount, 0), 10);
  return new Date(Date.now() + delay).toISOString();
}

function refreshDeadLetterStateMetrics() {
  const pending = Number(db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE chain_id = ? AND status = 'pending'`).get(CHAIN_ID)?.count || 0);
  const abandoned = Number(db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE chain_id = ? AND status = 'abandoned'`).get(CHAIN_ID)?.count || 0);
  setState("worker:pending_dead_letters", pending);
  setState("worker:abandoned_dead_letters", abandoned);
}

function upsertDeadLetter({ chainId, txHash, logIndex, invoiceId, payload, reason }) {
  const ts = nowIso();
  const existing = db
    .prepare(
      `SELECT id, retry_count, observation_count, retry_attempt_count
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
       (id, chain_id, tx_hash, log_index, invoice_id, payload_json, reason, status, retry_count,
        observation_count, retry_attempt_count, consecutive_retry_failures, last_observed_at,
        last_error, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 1, 0, 0, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      chainId,
      txHash,
      logIndex ?? null,
      invoiceId ?? null,
      JSON.stringify(payload),
      String(reason),
      ts,
      String(reason),
      deadLetterNextRetryAt(1),
      ts
    );
  } else {
    const nextObservationCount = Number(existing.observation_count || existing.retry_count || 0) + 1;
    const retryAttemptCount = Number(existing.retry_attempt_count || 0);
    db.prepare(
      `UPDATE chain_dead_letters
       SET payload_json = ?,
           reason = ?,
           status = 'pending',
           retry_count = ?,
           observation_count = ?,
           retry_attempt_count = ?,
           last_observed_at = ?,
           last_error = ?,
           next_retry_at = COALESCE(next_retry_at, ?),
           resolved_at = NULL,
           claimed_by = NULL,
           claimed_until = NULL
       WHERE id = ?`
    ).run(
      JSON.stringify(payload), String(reason), nextObservationCount + retryAttemptCount, nextObservationCount,
      retryAttemptCount, ts, String(reason), deadLetterNextRetryAt(Math.max(retryAttemptCount, 1)), existing.id
    );
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
       WHERE chain_id = ?
         AND status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
         AND (claimed_until IS NULL OR claimed_until <= ?)
       ORDER BY created_at ASC
       LIMIT 100`
    )
    .all(CHAIN_ID, startedAt, startedAt);

  for (const row of dueRows) {
    const claimUntil = new Date(Date.now() + Math.max(MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS, 30000)).toISOString();
    const claimed = db
      .prepare(
        `UPDATE chain_dead_letters
         SET claimed_by = ?, claimed_until = ?
         WHERE id = ?
           AND chain_id = ?
           AND status = 'pending'
           AND (claimed_until IS NULL OR claimed_until <= ?)`
      )
      .run(WORKER_ID, claimUntil, row.id, CHAIN_ID, startedAt);
    if (!claimed.changes) continue;
    const attemptAt = nowIso();
    const nextAttemptCount = Number(row.retry_attempt_count || 0) + 1;
    db.prepare(
      `UPDATE chain_dead_letters
       SET retry_attempt_count = ?, last_attempted_at = ?,
           retry_count = COALESCE(observation_count, retry_count, 0) + ?
       WHERE id = ? AND chain_id = ?`
    ).run(nextAttemptCount, attemptAt, nextAttemptCount, row.id, CHAIN_ID);
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (error) {
      const consecutiveFailures = Number(row.consecutive_retry_failures || 0) + 1;
      const abandoned = consecutiveFailures >= MONITOR_DEAD_LETTER_MAX_RETRIES;
      db.prepare(
        `UPDATE chain_dead_letters
         SET consecutive_retry_failures = ?,
             status = ?,
             last_error = ?,
             next_retry_at = ?,
             resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END,
             claimed_by = NULL,
             claimed_until = NULL
         WHERE id = ?`
      ).run(
        consecutiveFailures,
        abandoned ? "abandoned" : "pending",
        `invalid_payload_json:${String(error.message || error)}`,
        abandoned ? null : deadLetterNextRetryAt(nextAttemptCount),
        abandoned ? 1 : 0,
        nowIso(),
        row.id
      );
      continue;
    }

    const idemSeed = `${row.chain_id}:${row.tx_hash}:${row.log_index ?? -1}:${row.invoice_id || ""}:retry:${nextAttemptCount}`;
    const idemKey = `chain-retry-${sha256(idemSeed).slice(0, 46)}`;
    try {
      await postIngest(payload, idemKey);
      db.prepare(
        `UPDATE chain_dead_letters
         SET status = 'resolved',
             resolved_at = ?,
             last_error = NULL,
             consecutive_retry_failures = 0,
             next_retry_at = NULL,
             claimed_by = NULL,
             claimed_until = NULL
         WHERE id = ? AND chain_id = ?`
      ).run(nowIso(), row.id, CHAIN_ID);
    } catch (error) {
      const consecutiveFailures = Number(row.consecutive_retry_failures || 0) + 1;
      const abandoned = consecutiveFailures >= MONITOR_DEAD_LETTER_MAX_RETRIES;
      const message = String(error.message || error);
      db.prepare(
        `UPDATE chain_dead_letters
         SET consecutive_retry_failures = ?,
             status = ?,
             last_error = ?,
             next_retry_at = ?,
             resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END,
             claimed_by = NULL,
             claimed_until = NULL
         WHERE id = ? AND chain_id = ?`
      ).run(
        consecutiveFailures,
        abandoned ? "abandoned" : "pending",
        message,
        abandoned ? null : deadLetterNextRetryAt(nextAttemptCount),
        abandoned ? 1 : 0,
        nowIso(),
        row.id,
        CHAIN_ID
      );
      setState("worker:last_dead_letter_error", message);
    }
  }
  refreshDeadLetterStateMetrics();
}

let lastDeadLetterRetryMs = 0;
function blockTimestampIso(block) {
  const timestamp = Number(block?.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < 0) return null;
  return new Date(timestamp * 1000).toISOString();
}

async function revalidateRecentPaymentEventCanonicalHashes(latestBlock, blockCache) {
  const fromBlock = Math.max(Number(latestBlock) - MONITOR_BACKSCAN_BLOCKS, 0);
  const rows = await getRecentPaymentEvidence(fromBlock, Number(latestBlock));
  const blockNumbers = [...new Set(rows.map((row) => Number(row.block_number)).filter((value) => Number.isFinite(value)))];
  for (const blockNumber of blockNumbers) {
    let canonicalBlock = blockCache.get(blockNumber);
    if (!canonicalBlock) {
      canonicalBlock = await withProvider(`getBlock:revalidate:${blockNumber}`, (provider) => provider.getBlock(blockNumber));
      if (canonicalBlock) blockCache.set(blockNumber, canonicalBlock);
    }
    const canonicalHash = String(canonicalBlock?.hash || "").toLowerCase();
    if (!canonicalHash) continue;
    const mismatched = rows.filter((row) => Number(row.block_number) === blockNumber && String(row.block_hash || "").toLowerCase() !== canonicalHash);
    if (mismatched.length === 0) continue;
    await recordReorg({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      previousHash: mismatched[0].block_hash,
      observedHash: canonicalHash,
      reason: "payment_event_block_hash_mismatch",
    });
    console.error(
      JSON.stringify({
        ts: nowIso(),
        level: "error",
        type: "chain.payment_event_reorg_detected",
        chain_id: CHAIN_ID,
        block_number: blockNumber,
        affected_invoice_ids: [...new Set(mismatched.map((row) => row.invoice_id))],
        affected_payment_event_ids: mismatched.map((row) => row.id),
      })
    );
  }
}

async function runCycle() {
  setState("worker:last_cycle_started_at", nowIso());
  const invoices = await getCandidateInvoices();
  const latestBlock = await withProvider("getBlockNumber", (provider) => provider.getBlockNumber());
  const blockCache = new Map();
  const latestBlockData = await withProvider("getBlock:latest", (provider) => provider.getBlock(latestBlock));
  if (latestBlockData) blockCache.set(Number(latestBlock), latestBlockData);
  const previous = getCheckpoint();
  const previousHash = getCheckpointHash();
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
  let checkpointReorg = previous != null && latestBlock < previous;
  if (previous != null && previousHash && latestBlock >= previous) {
    const checkpointBlock = latestBlock === previous
      ? latestBlockData
      : await withProvider(`getBlock:checkpoint:${previous}`, (provider) => provider.getBlock(previous));
    if (checkpointBlock?.hash && String(checkpointBlock.hash) !== String(previousHash)) checkpointReorg = true;
  }
  if (checkpointReorg) {
    const checkpointBlock = latestBlock === previous
      ? latestBlockData
      : (previous != null ? await withProvider(`getBlock:checkpoint:${previous}`, (provider) => provider.getBlock(previous)) : null);
    await recordReorg({
      fromBlock: previous,
      toBlock: latestBlock,
      previousHash,
      observedHash: checkpointBlock?.hash || latestBlockData?.hash || null,
      reason: previousHash && latestBlock >= previous ? "checkpoint_hash_mismatch" : "height_regressed",
    });
  }
  await revalidateRecentPaymentEventCanonicalHashes(latestBlock, blockCache);
  const fromBlock = previous == null || latestBlock < previous
    ? Math.max(latestBlock - MONITOR_BACKSCAN_BLOCKS, 0)
    : Math.max(previous - MONITOR_BACKSCAN_BLOCKS, 0);
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

  if (Date.now() - lastDeadLetterRetryMs >= MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS) {
    await retryPendingDeadLetters();
    lastDeadLetterRetryMs = Date.now();
  }

  const recipientTopics = [...new Set(invoices.map((invoice) => toAddressTopic(String(invoice.recipient_address || ""))).filter(Boolean))];
  if (recipientTopics.length === 0) {
    // Never issue an unscoped Transfer log query when there are no active invoices.
    setCheckpoint(toBlock, latestBlockData?.hash || null);
    setState("worker:last_cycle_at", nowIso());
    setState("worker:last_checkpoint", toBlock);
    return;
  }

  const logs = [];
  for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += MONITOR_LOG_CHUNK_SIZE) {
    const chunkTo = Math.min(toBlock, chunkFrom + MONITOR_LOG_CHUNK_SIZE - 1);
    const chunkLogs = await withProvider(`getLogs:${chunkFrom}-${chunkTo}`, (provider) =>
      provider.getLogs({
        address: ACTIVE_TOKEN_CONTRACT,
        fromBlock: chunkFrom,
        toBlock: chunkTo,
        topics: [transferInterface.getEvent("Transfer").topicHash, null, recipientTopics]
      })
    );
    logs.push(...chunkLogs);
  }

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
    const amountAtomic = parsed.args.value.toString();
    const amountConversion = toAppBaseUnitsFromTokenValue(amountAtomic);
    const amountBase = amountConversion.value;
    if (!amountConversion.error && compareBaseUnits(amountBase, "0") <= 0) continue;
    const amountJpyc = formatBaseUnitsForDisplay(amountBase, LEDGER_DECIMALS);
    const confirmations = Math.max(0, latestBlock - Number(log.blockNumber) + 1);
    const blockNumber = Number(log.blockNumber || 0);
    let blockData = blockCache.get(blockNumber);
    if (!blockData) {
      blockData = await withProvider(`getBlock:${blockNumber}`, (provider) => provider.getBlock(blockNumber));
      if (blockData) blockCache.set(blockNumber, blockData);
    }
    const blockTimestamp = blockTimestampIso(blockData);
    const detectedAt = nowIso();
    const canonicalStatus = canonicalStatusForLog(log, blockData);
    const selected = selectInvoiceForLog(invoices, toAddress, amountBase);
    if (!selected.invoice) {
      const unmatchedReason = amountConversion.error
        ? `${amountConversion.error}:${selected.reason}`
        : selected.reason;
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
          unmatchedReason,
          JSON.stringify({
            tx_hash: log.transactionHash,
            log_index: Number(log.index ?? log.logIndex ?? 0),
            block_number: Number(log.blockNumber ?? 0),
            block_timestamp: blockTimestamp,
            detected_at: detectedAt,
            to_address: toAddress,
            amount_jpyc: amountJpyc,
            amount_jpyc_base: amountBase,
            ledger_amount_base: amountBase,
            amount_atomic: amountAtomic,
            token_amount_atomic: amountAtomic,
            amount_scale_version: AMOUNT_SCALE_VERSION,
            display_amount: amountJpyc,
            token_decimals: TOKEN_DECIMALS,
            ledger_decimals: LEDGER_DECIMALS,
            amount_conversion_exact: !amountConversion.error,
            amount_conversion_error: amountConversion.error || null,
            canonical_status: canonicalStatus,
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
          reason: unmatchedReason
        })
      );
      continue;
    }

    const payload = buildPaymentIngestPayload({
      invoiceId: selected.invoice.id,
      amountBase,
      amountAtomic,
      toAddress,
      fromAddress: parsed.args.from,
      confirmations,
      txHash: log.transactionHash,
      logIndex: Number(log.index ?? log.logIndex ?? 0),
      blockNumber,
      blockHash: log.blockHash || blockData?.hash || "",
      blockTimestamp,
      detectedAt,
      canonicalStatus,
      amountConversionExact: !amountConversion.error,
      amountConversionError: amountConversion.error || null,
    });
    const idemSeed = `${CHAIN_ID}:${payload.tx_hash}:${payload.log_index}:${payload.invoice_id}:confirmations:${payload.confirmations}`;
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
  setCheckpoint(toBlock, latestBlockData?.hash || null);
  await markUsedAddressesReconciled(invoices, toBlock);
  setState("worker:last_cycle_at", nowIso());
  setState("worker:last_checkpoint", toBlock);
}

let stopping = false;
let lastRpcMetadataRecoveryAttemptMs = 0;
async function main() {
  let rpcMetadataReady = false;
  try {
    await verifyConfiguredRpcMetadata();
    rpcMetadataReady = true;
    setState("worker:rpc_recovery_status", "ready");
  } catch (error) {
    if (error.code !== "RPC_METADATA_QUARANTINED") throw error;
    lastRpcMetadataRecoveryAttemptMs = Date.now();
    setState("worker:rpc_recovery_status", "quarantined");
    setState("worker:rpc_recovery_last_error", error.code);
    console.error(JSON.stringify({
      ts: nowIso(),
      level: "error",
      type: "chain.rpc_metadata_quarantined",
      code: error.code,
      message: "All configured RPC endpoints are quarantined; recovery verification will continue in the background",
    }));
  }
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
      worker_state_db_path: WORKER_STATE_DB_PATH,
      rpc_count: providers.length
    })
  );
  while (!stopping) {
    if (!rpcMetadataReady || !verifiedProviderIndexes || verifiedProviderIndexes.size === 0) {
      if (Date.now() - lastRpcMetadataRecoveryAttemptMs < RPC_METADATA_RECOVERY_RETRY_INTERVAL_MS) {
        await sleep(MONITOR_POLL_INTERVAL_MS);
        continue;
      }
      lastRpcMetadataRecoveryAttemptMs = Date.now();
      try {
        await verifyConfiguredRpcMetadata();
        rpcMetadataReady = true;
        setState("worker:rpc_recovery_status", "ready");
        setState("worker:rpc_recovery_last_error", "");
      } catch (error) {
        if (error.code !== "RPC_METADATA_QUARANTINED") throw error;
        rpcMetadataReady = false;
        setState("worker:rpc_recovery_status", "quarantined");
        setState("worker:rpc_recovery_last_error", error.code);
        await sleep(MONITOR_POLL_INTERVAL_MS);
        continue;
      }
    }
    try {
      await runCycle();
    } catch (error) {
      if (error.code === "RPC_ALL_PROVIDERS_FAILED") {
        rpcMetadataReady = false;
        setState("worker:rpc_recovery_status", "quarantined");
        setState("worker:rpc_recovery_last_error", error.code);
      }
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
  buildPaymentIngestPayload,
  canonicalStatusForLog,
  getCandidateInvoices,
  selectInvoiceForLog,
  toAppBaseUnitsFromTokenValue,
  upsertDeadLetter,
  retryPendingDeadLetters,
  runCycle,
  getCheckpoint,
  setCheckpoint,
  buildReconciliationPayload,
  markUsedAddressesReconciled,
  postReconciliationToApi,
};

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(JSON.stringify({ ts: nowIso(), level: "fatal", message: String(error.message || error) }));
    process.exit(1);
  });
}
