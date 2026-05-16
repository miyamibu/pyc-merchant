import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import cors from "cors";
import { Interface, JsonRpcProvider, verifyMessage } from "ethers";
import helmet from "helmet";
import { DateTime } from "luxon";
import { buildWalletLaunchPayload, createWalletAdapter, getSupportedWallets } from "./wallet-adapter.mjs";
import { makePaymentLogic } from "./payment-logic.mjs";
import {
  REVIEW_REASON_CODES,
  isRefundCandidateReasonCode,
  normalizeReviewReasonCode,
  reasonCodeLabelJa,
  suggestedReviewAction,
} from "./reason-codes.mjs";
import {
  compareBaseUnits,
  convertBaseUnitsBetweenDecimals,
  formatBaseUnitsForDisplay,
  parseDecimalToBaseUnits,
  scaleToDecimals,
} from "./amounts.mjs";
import {
  FULFILLMENT_DECISIONS,
  isKnownProviderCode,
  PAYMENT_RAIL_TYPES,
  PAYMENT_SESSION_STATUSES,
  PROVIDER_CODES,
} from "./payment-rails.mjs";
import {
  PROVIDER_ALLOCATION_STATUSES,
  PROVIDER_EVENT_ALLOWED_FIELDS,
  PROVIDER_EVENT_TYPES,
  PROVIDER_PAYMENT_SESSION_STATUSES,
  PROVIDER_PRIVATE_FIELDS,
  PROVIDER_SETTLEMENT_ALLOWED_FIELDS,
  PROVIDER_SETTLEMENT_ALLOCATION_ALLOWED_FIELDS,
  PROVIDER_SETTLEMENT_STATUSES,
  canonicalReceivableStatus,
  findPrivateProviderField,
  pickAllowedFields,
  providerEventAllowsFulfillment,
} from "./provider-rail.mjs";
import {
  ACCOUNTING_STATUS_VALUES,
  CASH_RECOGNITION_STATUS_VALUES,
  RECEIVABLE_STATUS_VALUES,
  buildDailyAccountingSummary,
} from "./settlement-export.mjs";

const CWD = process.cwd();
const DEFAULTS = {
  APP_ENV: "development",
  NODE_ENV: "",
  APP_PORT: "4173",
  PORT: "",
  APP_HOST: "http://localhost:4173",
  PAY_BASE_URL: "",
  PUBLIC_BASE_URL: "",
  APP_SECRET: "__REPLACE_WITH_LONG_RANDOM_SECRET__",
  DB_PATH: "./data/app.db",
  CHAIN_ID: "137",
  TOKEN_DECIMALS: "18",
  TOKEN_SYMBOL: "JPYC",
  TERMINAL_CODE: "TERM-001",
  STAFF_PIN: "1234",
  SECOND_ADMIN_PIN: "",
  BOOTSTRAP_ADMIN_PIN: "",
  BOOTSTRAP_TERMINAL_CODE: "",
  TOKEN_CONTRACT: "",
  APPROVED_JPYC_TOKEN_CONTRACT: "",
  JPYC_CONTRACT_APPROVAL_REF: "",
  LEGAL_GATE_APPROVAL_REF: "",
  AML_POLICY_APPROVAL_REF: "",
  PRIVACY_POLICY_APPROVAL_REF: "",
  APPI_POLICY_APPROVED: "false",
  APPI_POLICY_APPROVAL_REF: "",
  APPI_RETENTION_POLICY_REF: "",
  APPI_DELETION_PROCEDURE_REF: "",
  APPI_DISCLOSURE_PROCEDURE_REF: "",
  CONFIRMATIONS_POLICY_APPROVAL_REF: "",
  BACKSCAN_POLICY_APPROVAL_REF: "",
  CHECKOUT_SESSION_IMPLEMENTED: "true",
  RECIPIENT_ADDRESS: "",
  PUBLIC_LINK_GRACE_SEC: "900",
  TERMS_URL: "",
  PRIVACY_URL: "",
  REFUND_POLICY_URL: "",
  TERMS_VERSION: "",
  PRIVACY_VERSION: "",
  REFUND_POLICY_VERSION: "",
  PUBLIC_RATE_LIMIT_WINDOW_MS: "60000",
  PUBLIC_RATE_LIMIT_MAX: "120",
  LOGIN_RATE_LIMIT_WINDOW_MS: "600000",
  LOGIN_RATE_LIMIT_MAX: "10",
  TRUST_PROXY: "true",
  WALLET_ADAPTER_TYPE: "mock",
  ENABLE_REOWN: "false",
  REOWN_PROJECT_ID: "",
  WALLET_HELP_URL: "",
  WALLET_DEEPLINK_TEMPLATE: "",
  HASHPORT_WALLET_DEEPLINK_TEMPLATE: "",
  SUPPORTED_WALLETS: "HashPort Wallet,WalletConnect,Injected Wallet",
  DIAGNOSTIC_MODE_ENABLED: "false",
  DIAGNOSTIC_MODE_APPROVAL_REF: "",
  ENABLE_PUBLIC_PAYMENT_SIMULATION: "false",
  DEMO_CONTROLS_ENABLED: "false",
  ALLOW_MANUAL_PAYMENT_INGEST: "false",
  ENABLE_PROVIDER_RAIL_MOCK: "false",
  MANUAL_INGEST_APPROVAL_REF: "",
  COMMERCIAL_GO_MODE: "false",
  COMMERCIAL_EVIDENCE_ROOT: "./docs/production/evidence",
  SESSION_TTL_SEC: "43200",
  CORS_ALLOW_ORIGINS: "http://localhost:4173,http://127.0.0.1:4173",
  SERVICE_INGEST_ID: "chain-monitor",
  SERVICE_INGEST_SECRET: "__REPLACE_WITH_LONG_RANDOM_INGEST_SECRET__",
  SERVICE_AUTH_MAX_SKEW_SEC: "300",
  SERVICE_AUTH_MAX_FUTURE_SEC: "30",
  SERVICE_REPLAY_GUARD_TTL_SEC: "86400",
  IDEMPOTENCY_TTL_SEC: "604800",
  PIN_LOCKOUT_MAX_ATTEMPTS: "5",
  PIN_LOCKOUT_SEC: "900",
  SSE_TOKEN_MAX_TTL_SEC: "900",
  JPYC_BASE_UNIT_SCALE: "",
  MIN_REQUIRED_CONFIRMATIONS: "2",
  METRICS_SECRET: "__REPLACE_WITH_METRICS_SECRET__",
  WORKER_STALE_SEC: "180",
  REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR: "true",
  REQUIRED_CONFIRMATIONS: "2",
  SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS: "false",
  SETTLEMENT_UNRESOLVED_REVIEW_POLICY: "",
  PAYMENTS_DISABLED: "false",
  MAX_ACTIVE_INVOICES_PER_RECIPIENT: "1",
  MAX_INVOICE_AMOUNT_JPY: "100000000",
  DAILY_STORE_AMOUNT_CAP_JPY: "1000000000",
  DAILY_STORE_INVOICE_CAP: "10000",
  LEGAL_GATE_APPROVED: "false",
  AML_POLICY_APPROVED: "false",
  PRIVACY_POLICY_APPROVED: "false",
  AML_HIGH_VALUE_THRESHOLD_JPY: "300000",
  RPC_URLS: "",
  MONITOR_BACKSCAN_BLOCKS: "12",
  MIN_MONITOR_BACKSCAN_BLOCKS: "12",
};

function parseFlag(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const APPROVAL_GUARD_WORDS = [
  ["def", "ault"].join(""),
  ["place", "holder"].join(""),
  ["to", "do"].join(""),
  ["change", "me"].join(""),
  ["exam", "ple"].join(""),
  ["sam", "ple"].join(""),
  ["tb", "d"].join(""),
];
const WEAK_SECRET_WORDS = [
  ["pass", "word"].join(""),
  ["sec", "ret"].join(""),
  ["te", "st"].join(""),
  ["de", "v"].join(""),
  ["lo", "cal"].join(""),
  ["sam", "ple"].join(""),
  ["def", "ault"].join(""),
  ["change", "me"].join(""),
  ["exam", "ple"].join(""),
];

function normalizeEnvString(value) {
  return String(value ?? "").trim();
}

function isPlaceholderLike(value) {
  const normalized = normalizeEnvString(value).toLowerCase();
  if (!normalized) return true;
  return APPROVAL_GUARD_WORDS.some((word) => normalized === word || normalized.includes(word));
}

function isWeakSecretValue(value) {
  const normalized = normalizeEnvString(value).toLowerCase();
  if (!normalized) return true;
  return WEAK_SECRET_WORDS.some((word) => normalized.includes(word));
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
const WALLET_ADAPTER = createWalletAdapter(ENV);
const APP_ENV = String(ENV.APP_ENV || ENV.NODE_ENV || DEFAULTS.APP_ENV).trim().toLowerCase();
const IS_PRODUCTION = APP_ENV === "production";
const PORT = Number(ENV.APP_PORT || ENV.PORT || DEFAULTS.APP_PORT);
const APP_HOST = ENV.APP_HOST || ENV.PAY_BASE_URL || ENV.PUBLIC_BASE_URL || DEFAULTS.APP_HOST;
const APP_SECRET = ENV.APP_SECRET || DEFAULTS.APP_SECRET;
const DB_PATH = path.resolve(CWD, ENV.DB_PATH || DEFAULTS.DB_PATH);
const CHAIN_ID = String(ENV.CHAIN_ID || DEFAULTS.CHAIN_ID).trim();
const TOKEN_DECIMALS = Number(ENV.TOKEN_DECIMALS || DEFAULTS.TOKEN_DECIMALS);
const TOKEN_SYMBOL = String(ENV.TOKEN_SYMBOL || DEFAULTS.TOKEN_SYMBOL || "JPYC").trim() || "JPYC";
const TERMINAL_CODE = ENV.TERMINAL_CODE || DEFAULTS.TERMINAL_CODE;
const STAFF_PIN = ENV.STAFF_PIN || DEFAULTS.STAFF_PIN;
const SECOND_ADMIN_PIN = String(ENV.SECOND_ADMIN_PIN || DEFAULTS.SECOND_ADMIN_PIN || "");
const BOOTSTRAP_ADMIN_PIN = String(ENV.BOOTSTRAP_ADMIN_PIN || DEFAULTS.BOOTSTRAP_ADMIN_PIN || "");
const BOOTSTRAP_TERMINAL_CODE = String(ENV.BOOTSTRAP_TERMINAL_CODE || DEFAULTS.BOOTSTRAP_TERMINAL_CODE || "");
const TOKEN_CONTRACT = ENV.TOKEN_CONTRACT || DEFAULTS.TOKEN_CONTRACT;
const APPROVED_JPYC_TOKEN_CONTRACT = String(ENV.APPROVED_JPYC_TOKEN_CONTRACT || DEFAULTS.APPROVED_JPYC_TOKEN_CONTRACT || "").toLowerCase();
const JPYC_CONTRACT_APPROVAL_REF = String(ENV.JPYC_CONTRACT_APPROVAL_REF || DEFAULTS.JPYC_CONTRACT_APPROVAL_REF || "");
const LEGAL_GATE_APPROVAL_REF = String(ENV.LEGAL_GATE_APPROVAL_REF || DEFAULTS.LEGAL_GATE_APPROVAL_REF || "");
const AML_POLICY_APPROVAL_REF = String(ENV.AML_POLICY_APPROVAL_REF || DEFAULTS.AML_POLICY_APPROVAL_REF || "");
const PRIVACY_POLICY_APPROVAL_REF = String(ENV.PRIVACY_POLICY_APPROVAL_REF || DEFAULTS.PRIVACY_POLICY_APPROVAL_REF || "");
const APPI_POLICY_APPROVED = parseFlag(ENV.APPI_POLICY_APPROVED ?? DEFAULTS.APPI_POLICY_APPROVED, false);
const APPI_POLICY_APPROVAL_REF = String(ENV.APPI_POLICY_APPROVAL_REF || DEFAULTS.APPI_POLICY_APPROVAL_REF || "");
const APPI_RETENTION_POLICY_REF = String(ENV.APPI_RETENTION_POLICY_REF || DEFAULTS.APPI_RETENTION_POLICY_REF || "");
const APPI_DELETION_PROCEDURE_REF = String(ENV.APPI_DELETION_PROCEDURE_REF || DEFAULTS.APPI_DELETION_PROCEDURE_REF || "");
const APPI_DISCLOSURE_PROCEDURE_REF = String(ENV.APPI_DISCLOSURE_PROCEDURE_REF || DEFAULTS.APPI_DISCLOSURE_PROCEDURE_REF || "");
const CONFIRMATIONS_POLICY_APPROVAL_REF = String(
  ENV.CONFIRMATIONS_POLICY_APPROVAL_REF || DEFAULTS.CONFIRMATIONS_POLICY_APPROVAL_REF || ""
);
const BACKSCAN_POLICY_APPROVAL_REF = String(ENV.BACKSCAN_POLICY_APPROVAL_REF || DEFAULTS.BACKSCAN_POLICY_APPROVAL_REF || "");
const CHECKOUT_SESSION_IMPLEMENTED = parseFlag(ENV.CHECKOUT_SESSION_IMPLEMENTED ?? DEFAULTS.CHECKOUT_SESSION_IMPLEMENTED, false);
const RECIPIENT_ADDRESS = ENV.RECIPIENT_ADDRESS || DEFAULTS.RECIPIENT_ADDRESS;
const PUBLIC_LINK_GRACE_SEC = Number(ENV.PUBLIC_LINK_GRACE_SEC || DEFAULTS.PUBLIC_LINK_GRACE_SEC);
const TERMS_URL = String(ENV.TERMS_URL || DEFAULTS.TERMS_URL || "").trim();
const PRIVACY_URL = String(ENV.PRIVACY_URL || DEFAULTS.PRIVACY_URL || "").trim();
const REFUND_POLICY_URL = String(ENV.REFUND_POLICY_URL || DEFAULTS.REFUND_POLICY_URL || "").trim();
const TERMS_VERSION = String(ENV.TERMS_VERSION || DEFAULTS.TERMS_VERSION || "").trim();
const PRIVACY_VERSION = String(ENV.PRIVACY_VERSION || DEFAULTS.PRIVACY_VERSION || "").trim();
const REFUND_POLICY_VERSION = String(ENV.REFUND_POLICY_VERSION || DEFAULTS.REFUND_POLICY_VERSION || "").trim();
const PUBLIC_RATE_LIMIT_WINDOW_MS = Number(ENV.PUBLIC_RATE_LIMIT_WINDOW_MS || DEFAULTS.PUBLIC_RATE_LIMIT_WINDOW_MS);
const PUBLIC_RATE_LIMIT_MAX = Number(ENV.PUBLIC_RATE_LIMIT_MAX || DEFAULTS.PUBLIC_RATE_LIMIT_MAX);
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(ENV.LOGIN_RATE_LIMIT_WINDOW_MS || DEFAULTS.LOGIN_RATE_LIMIT_WINDOW_MS);
const LOGIN_RATE_LIMIT_MAX = Number(ENV.LOGIN_RATE_LIMIT_MAX || DEFAULTS.LOGIN_RATE_LIMIT_MAX);
const TRUST_PROXY = parseFlag(ENV.TRUST_PROXY ?? DEFAULTS.TRUST_PROXY, true);
const ENABLE_PUBLIC_PAYMENT_SIMULATION = parseFlag(
  ENV.ENABLE_PUBLIC_PAYMENT_SIMULATION ?? DEFAULTS.ENABLE_PUBLIC_PAYMENT_SIMULATION,
  false
);
const DIAGNOSTIC_MODE_ENABLED = parseFlag(ENV.DIAGNOSTIC_MODE_ENABLED ?? DEFAULTS.DIAGNOSTIC_MODE_ENABLED, false);
const DIAGNOSTIC_MODE_APPROVAL_REF = String(ENV.DIAGNOSTIC_MODE_APPROVAL_REF || DEFAULTS.DIAGNOSTIC_MODE_APPROVAL_REF || "");
const DEMO_CONTROLS_ENABLED = parseFlag(ENV.DEMO_CONTROLS_ENABLED ?? DEFAULTS.DEMO_CONTROLS_ENABLED, false);
const ENABLE_REOWN = parseFlag(ENV.ENABLE_REOWN ?? DEFAULTS.ENABLE_REOWN, false);
const REOWN_PROJECT_ID = String(ENV.REOWN_PROJECT_ID || DEFAULTS.REOWN_PROJECT_ID || "");
const ALLOW_MANUAL_PAYMENT_INGEST = parseFlag(ENV.ALLOW_MANUAL_PAYMENT_INGEST ?? DEFAULTS.ALLOW_MANUAL_PAYMENT_INGEST, false);
const ENABLE_PROVIDER_RAIL_MOCK = parseFlag(ENV.ENABLE_PROVIDER_RAIL_MOCK ?? DEFAULTS.ENABLE_PROVIDER_RAIL_MOCK, false);
const MANUAL_INGEST_APPROVAL_REF = String(ENV.MANUAL_INGEST_APPROVAL_REF || DEFAULTS.MANUAL_INGEST_APPROVAL_REF || "");
const COMMERCIAL_GO_MODE = parseFlag(ENV.COMMERCIAL_GO_MODE ?? DEFAULTS.COMMERCIAL_GO_MODE, IS_PRODUCTION);
const COMMERCIAL_EVIDENCE_ROOT = path.resolve(CWD, ENV.COMMERCIAL_EVIDENCE_ROOT || DEFAULTS.COMMERCIAL_EVIDENCE_ROOT);
const SESSION_TTL_SEC = Number(ENV.SESSION_TTL_SEC || DEFAULTS.SESSION_TTL_SEC);
const CORS_ALLOW_ORIGINS = String(ENV.CORS_ALLOW_ORIGINS || DEFAULTS.CORS_ALLOW_ORIGINS)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const SERVICE_INGEST_ID = String(ENV.SERVICE_INGEST_ID || DEFAULTS.SERVICE_INGEST_ID);
const SERVICE_INGEST_SECRET = String(ENV.SERVICE_INGEST_SECRET || DEFAULTS.SERVICE_INGEST_SECRET);
const SERVICE_AUTH_MAX_SKEW_SEC = Number(ENV.SERVICE_AUTH_MAX_SKEW_SEC || DEFAULTS.SERVICE_AUTH_MAX_SKEW_SEC);
const SERVICE_AUTH_MAX_FUTURE_SEC = Number(ENV.SERVICE_AUTH_MAX_FUTURE_SEC || DEFAULTS.SERVICE_AUTH_MAX_FUTURE_SEC);
const SERVICE_REPLAY_GUARD_TTL_SEC = Number(ENV.SERVICE_REPLAY_GUARD_TTL_SEC || DEFAULTS.SERVICE_REPLAY_GUARD_TTL_SEC);
const IDEMPOTENCY_TTL_SEC = Number(ENV.IDEMPOTENCY_TTL_SEC || DEFAULTS.IDEMPOTENCY_TTL_SEC);
const PIN_LOCKOUT_MAX_ATTEMPTS = Number(ENV.PIN_LOCKOUT_MAX_ATTEMPTS || DEFAULTS.PIN_LOCKOUT_MAX_ATTEMPTS);
const PIN_LOCKOUT_SEC = Number(ENV.PIN_LOCKOUT_SEC || DEFAULTS.PIN_LOCKOUT_SEC);
const SSE_TOKEN_MAX_TTL_SEC = Number(ENV.SSE_TOKEN_MAX_TTL_SEC || DEFAULTS.SSE_TOKEN_MAX_TTL_SEC);
const JPYC_BASE_UNIT_SCALE = String(ENV.JPYC_BASE_UNIT_SCALE || DEFAULTS.JPYC_BASE_UNIT_SCALE || "");
let JPYC_SCALE_DECIMALS = null;
try {
  JPYC_SCALE_DECIMALS = scaleToDecimals(JPYC_BASE_UNIT_SCALE);
} catch (_error) {
  console.error("FATAL: JPYC_BASE_UNIT_SCALE must be a power-of-10 positive integer.");
  process.exit(1);
}
const METRICS_SECRET = String(ENV.METRICS_SECRET || DEFAULTS.METRICS_SECRET);
const WORKER_STALE_SEC = Number(ENV.WORKER_STALE_SEC || DEFAULTS.WORKER_STALE_SEC);
const REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR =
  parseFlag(ENV.REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR ?? DEFAULTS.REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR, true);
const REQUIRED_CONFIRMATIONS = Number(ENV.REQUIRED_CONFIRMATIONS || DEFAULTS.REQUIRED_CONFIRMATIONS);
const MIN_REQUIRED_CONFIRMATIONS = Number(ENV.MIN_REQUIRED_CONFIRMATIONS || DEFAULTS.MIN_REQUIRED_CONFIRMATIONS);
const SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS = parseFlag(
  ENV.SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS ?? DEFAULTS.SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS,
  false
);
const SETTLEMENT_UNRESOLVED_REVIEW_POLICY = String(
  ENV.SETTLEMENT_UNRESOLVED_REVIEW_POLICY || DEFAULTS.SETTLEMENT_UNRESOLVED_REVIEW_POLICY || ""
).trim().toLowerCase();
const PAYMENTS_DISABLED_ENV = parseFlag(ENV.PAYMENTS_DISABLED ?? DEFAULTS.PAYMENTS_DISABLED, false);
const MAX_ACTIVE_INVOICES_PER_RECIPIENT = Number(ENV.MAX_ACTIVE_INVOICES_PER_RECIPIENT || DEFAULTS.MAX_ACTIVE_INVOICES_PER_RECIPIENT);
const MAX_INVOICE_AMOUNT_JPY = Number(ENV.MAX_INVOICE_AMOUNT_JPY || DEFAULTS.MAX_INVOICE_AMOUNT_JPY);
const DAILY_STORE_AMOUNT_CAP_JPY = Number(ENV.DAILY_STORE_AMOUNT_CAP_JPY || DEFAULTS.DAILY_STORE_AMOUNT_CAP_JPY);
const DAILY_STORE_INVOICE_CAP = Number(ENV.DAILY_STORE_INVOICE_CAP || DEFAULTS.DAILY_STORE_INVOICE_CAP);
const LEGAL_GATE_APPROVED = parseFlag(ENV.LEGAL_GATE_APPROVED ?? DEFAULTS.LEGAL_GATE_APPROVED, false);
const AML_POLICY_APPROVED = parseFlag(ENV.AML_POLICY_APPROVED ?? DEFAULTS.AML_POLICY_APPROVED, false);
const PRIVACY_POLICY_APPROVED = parseFlag(ENV.PRIVACY_POLICY_APPROVED ?? DEFAULTS.PRIVACY_POLICY_APPROVED, false);
const AML_HIGH_VALUE_THRESHOLD_JPY = Number(ENV.AML_HIGH_VALUE_THRESHOLD_JPY || DEFAULTS.AML_HIGH_VALUE_THRESHOLD_JPY);
const RPC_URLS = String(ENV.RPC_URLS || DEFAULTS.RPC_URLS)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MONITOR_BACKSCAN_BLOCKS = Number(ENV.MONITOR_BACKSCAN_BLOCKS || DEFAULTS.MONITOR_BACKSCAN_BLOCKS);
const MIN_MONITOR_BACKSCAN_BLOCKS = Number(ENV.MIN_MONITOR_BACKSCAN_BLOCKS || DEFAULTS.MIN_MONITOR_BACKSCAN_BLOCKS);
const APPROVED_TOKEN_CONTRACT = APPROVED_JPYC_TOKEN_CONTRACT || String(TOKEN_CONTRACT || "").toLowerCase();
const { toBaseUnits, decidePaymentStatus } = makePaymentLogic({
  jpycBaseUnitScale: JPYC_BASE_UNIT_SCALE,
  requiredConfirmations: REQUIRED_CONFIRMATIONS,
});

const INSECURE_SECRETS = new Set([
  "",
  DEFAULTS.APP_SECRET,
  DEFAULTS.SERVICE_INGEST_SECRET,
  DEFAULTS.METRICS_SECRET,
  "change-this-secret",
  "replace-with-very-long-random-secret"
]);
if (INSECURE_SECRETS.has(APP_SECRET) || APP_SECRET.length < 32 || (IS_PRODUCTION && isWeakSecretValue(APP_SECRET))) {
  console.error("FATAL: APP_SECRET is not set securely. Use a unique random secret with length >= 32.");
  process.exit(1);
}
if (
  INSECURE_SECRETS.has(SERVICE_INGEST_SECRET)
  || SERVICE_INGEST_SECRET.length < 32
  || (IS_PRODUCTION && isWeakSecretValue(SERVICE_INGEST_SECRET))
) {
  console.error("FATAL: SERVICE_INGEST_SECRET is not set securely. Use a unique random secret with length >= 32.");
  process.exit(1);
}
if (!Number.isFinite(SESSION_TTL_SEC) || SESSION_TTL_SEC <= 0) {
  console.error("FATAL: SESSION_TTL_SEC must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(PUBLIC_LINK_GRACE_SEC) || PUBLIC_LINK_GRACE_SEC < 0 || PUBLIC_LINK_GRACE_SEC > 1800 || !Number.isInteger(PUBLIC_LINK_GRACE_SEC)) {
  console.error("FATAL: PUBLIC_LINK_GRACE_SEC must be an integer between 0 and 1800.");
  process.exit(1);
}
if (!Number.isFinite(SERVICE_AUTH_MAX_SKEW_SEC) || SERVICE_AUTH_MAX_SKEW_SEC <= 0) {
  console.error("FATAL: SERVICE_AUTH_MAX_SKEW_SEC must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(SERVICE_AUTH_MAX_FUTURE_SEC) || SERVICE_AUTH_MAX_FUTURE_SEC < 0) {
  console.error("FATAL: SERVICE_AUTH_MAX_FUTURE_SEC must be >= 0.");
  process.exit(1);
}
if (!Number.isFinite(SERVICE_REPLAY_GUARD_TTL_SEC) || SERVICE_REPLAY_GUARD_TTL_SEC <= 0) {
  console.error("FATAL: SERVICE_REPLAY_GUARD_TTL_SEC must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(IDEMPOTENCY_TTL_SEC) || IDEMPOTENCY_TTL_SEC <= 0) {
  console.error("FATAL: IDEMPOTENCY_TTL_SEC must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(PIN_LOCKOUT_MAX_ATTEMPTS) || PIN_LOCKOUT_MAX_ATTEMPTS <= 0) {
  console.error("FATAL: PIN_LOCKOUT_MAX_ATTEMPTS must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(PIN_LOCKOUT_SEC) || PIN_LOCKOUT_SEC <= 0) {
  console.error("FATAL: PIN_LOCKOUT_SEC must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(SSE_TOKEN_MAX_TTL_SEC) || SSE_TOKEN_MAX_TTL_SEC < 60 || SSE_TOKEN_MAX_TTL_SEC > 900 || !Number.isInteger(SSE_TOKEN_MAX_TTL_SEC)) {
  console.error("FATAL: SSE_TOKEN_MAX_TTL_SEC must be an integer between 60 and 900.");
  process.exit(1);
}
if (!Number.isFinite(WORKER_STALE_SEC) || WORKER_STALE_SEC <= 0) {
  console.error("FATAL: WORKER_STALE_SEC must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(REQUIRED_CONFIRMATIONS) || REQUIRED_CONFIRMATIONS < 0 || !Number.isInteger(REQUIRED_CONFIRMATIONS)) {
  console.error("FATAL: REQUIRED_CONFIRMATIONS must be a non-negative integer.");
  process.exit(1);
}

function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || "").trim());
}

function assertApprovedRef(name, value) {
  if (isPlaceholderLike(value)) {
    console.error(`FATAL: ${name} must be set to an approved reference.`);
    process.exit(1);
  }
}

if (!isEvmAddress(TOKEN_CONTRACT)) {
  console.error("FATAL: TOKEN_CONTRACT must be an explicit 0x-prefixed 40-hex EVM address.");
  process.exit(1);
}
if (RECIPIENT_ADDRESS && !isEvmAddress(RECIPIENT_ADDRESS)) {
  console.error("FATAL: RECIPIENT_ADDRESS must be an explicit 0x-prefixed 40-hex EVM address.");
  process.exit(1);
}
if (!/^\d{4,8}$/.test(String(STAFF_PIN))) {
  console.error("FATAL: STAFF_PIN must be 4-8 digits.");
  process.exit(1);
}
if (SECOND_ADMIN_PIN && !/^\d{4,8}$/.test(String(SECOND_ADMIN_PIN))) {
  console.error("FATAL: SECOND_ADMIN_PIN must be 4-8 digits when set.");
  process.exit(1);
}
if (!Number.isFinite(TOKEN_DECIMALS) || TOKEN_DECIMALS < 0 || TOKEN_DECIMALS > 30 || !Number.isInteger(TOKEN_DECIMALS)) {
  console.error("FATAL: TOKEN_DECIMALS must be an integer between 0 and 30.");
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
if (!Number.isFinite(MAX_ACTIVE_INVOICES_PER_RECIPIENT) || MAX_ACTIVE_INVOICES_PER_RECIPIENT < 1 || !Number.isInteger(MAX_ACTIVE_INVOICES_PER_RECIPIENT)) {
  console.error("FATAL: MAX_ACTIVE_INVOICES_PER_RECIPIENT must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(MAX_INVOICE_AMOUNT_JPY) || MAX_INVOICE_AMOUNT_JPY < 1 || !Number.isInteger(MAX_INVOICE_AMOUNT_JPY)) {
  console.error("FATAL: MAX_INVOICE_AMOUNT_JPY must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(DAILY_STORE_AMOUNT_CAP_JPY) || DAILY_STORE_AMOUNT_CAP_JPY < 1 || !Number.isInteger(DAILY_STORE_AMOUNT_CAP_JPY)) {
  console.error("FATAL: DAILY_STORE_AMOUNT_CAP_JPY must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(DAILY_STORE_INVOICE_CAP) || DAILY_STORE_INVOICE_CAP < 1 || !Number.isInteger(DAILY_STORE_INVOICE_CAP)) {
  console.error("FATAL: DAILY_STORE_INVOICE_CAP must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(AML_HIGH_VALUE_THRESHOLD_JPY) || AML_HIGH_VALUE_THRESHOLD_JPY < 1 || !Number.isInteger(AML_HIGH_VALUE_THRESHOLD_JPY)) {
  console.error("FATAL: AML_HIGH_VALUE_THRESHOLD_JPY must be a positive integer.");
  process.exit(1);
}
try {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const scaleBigInt = BigInt(JPYC_BASE_UNIT_SCALE);
  const maxInvoiceBase = BigInt(MAX_INVOICE_AMOUNT_JPY) * scaleBigInt;
  const dailyStoreCapBase = BigInt(DAILY_STORE_AMOUNT_CAP_JPY) * scaleBigInt;
  if (maxInvoiceBase > maxSafe) {
    console.error("FATAL: MAX_INVOICE_AMOUNT_JPY * JPYC_BASE_UNIT_SCALE exceeds Number.MAX_SAFE_INTEGER.");
    process.exit(1);
  }
  if (dailyStoreCapBase > maxSafe) {
    console.error("FATAL: DAILY_STORE_AMOUNT_CAP_JPY * JPYC_BASE_UNIT_SCALE exceeds Number.MAX_SAFE_INTEGER.");
    process.exit(1);
  }
} catch (_error) {
  console.error("FATAL: failed to validate amount scale bounds.");
  process.exit(1);
}

const DUMMY_ADDRESS_SET = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
]);

function isDummyAddress(value) {
  const normalized = String(value || "").toLowerCase();
  return DUMMY_ADDRESS_SET.has(normalized);
}

if (IS_PRODUCTION) {
  if (ENABLE_PUBLIC_PAYMENT_SIMULATION) {
    console.error("FATAL: ENABLE_PUBLIC_PAYMENT_SIMULATION must be false in production.");
    process.exit(1);
  }
  if (DEMO_CONTROLS_ENABLED) {
    console.error("FATAL: DEMO_CONTROLS_ENABLED must be false in production.");
    process.exit(1);
  }
  if (DIAGNOSTIC_MODE_ENABLED && isPlaceholderLike(DIAGNOSTIC_MODE_APPROVAL_REF)) {
    console.error("FATAL: DIAGNOSTIC_MODE_ENABLED requires DIAGNOSTIC_MODE_APPROVAL_REF in production.");
    process.exit(1);
  }
  if (ALLOW_MANUAL_PAYMENT_INGEST && isPlaceholderLike(MANUAL_INGEST_APPROVAL_REF)) {
    console.error("FATAL: ALLOW_MANUAL_PAYMENT_INGEST requires MANUAL_INGEST_APPROVAL_REF in production.");
    process.exit(1);
  }
  if (String(ENV.WALLET_ADAPTER_TYPE || "mock").toLowerCase() === "mock") {
    console.error("FATAL: WALLET_ADAPTER_TYPE=mock is not allowed in production.");
    process.exit(1);
  }
  if (!parseFlag(ENV.ENABLE_REOWN, false)) {
    console.error("FATAL: ENABLE_REOWN must be true in production.");
    process.exit(1);
  }
  if (/localhost|127\.0\.0\.1/i.test(APP_HOST)) {
    console.error("FATAL: APP_HOST must not be localhost in production.");
    process.exit(1);
  }
  if (isDummyAddress(TOKEN_CONTRACT) || (RECIPIENT_ADDRESS && isDummyAddress(RECIPIENT_ADDRESS))) {
    console.error("FATAL: TOKEN_CONTRACT/RECIPIENT_ADDRESS must not be dummy addresses in production.");
    process.exit(1);
  }
  if (INSECURE_SECRETS.has(METRICS_SECRET) || METRICS_SECRET.length < 32 || isWeakSecretValue(METRICS_SECRET)) {
    console.error("FATAL: METRICS_SECRET must be configured securely in production.");
    process.exit(1);
  }
  if (!REOWN_PROJECT_ID || isPlaceholderLike(REOWN_PROJECT_ID)) {
    console.error("FATAL: REOWN_PROJECT_ID must be configured in production.");
    process.exit(1);
  }
  if (CORS_ALLOW_ORIGINS.some((origin) => origin === "*" || origin.includes("*"))) {
    console.error("FATAL: CORS_ALLOW_ORIGINS wildcard is not allowed in production.");
    process.exit(1);
  }
  if (REQUIRED_CONFIRMATIONS < 1 || REQUIRED_CONFIRMATIONS < MIN_REQUIRED_CONFIRMATIONS) {
    console.error("FATAL: REQUIRED_CONFIRMATIONS is below policy minimum in production.");
    process.exit(1);
  }
  if (MONITOR_BACKSCAN_BLOCKS < MIN_MONITOR_BACKSCAN_BLOCKS) {
    console.error("FATAL: MONITOR_BACKSCAN_BLOCKS is below the approved production minimum.");
    process.exit(1);
  }
  if (CHAIN_ID !== "137") {
    console.error("FATAL: CHAIN_ID must be 137 in production.");
    process.exit(1);
  }
  if (!APPROVED_JPYC_TOKEN_CONTRACT || !isEvmAddress(APPROVED_JPYC_TOKEN_CONTRACT)) {
    console.error("FATAL: APPROVED_JPYC_TOKEN_CONTRACT must be configured in production.");
    process.exit(1);
  }
  if (String(TOKEN_CONTRACT).toLowerCase() !== APPROVED_JPYC_TOKEN_CONTRACT) {
    console.error("FATAL: TOKEN_CONTRACT must match APPROVED_JPYC_TOKEN_CONTRACT in production.");
    process.exit(1);
  }
  assertApprovedRef("JPYC_CONTRACT_APPROVAL_REF", JPYC_CONTRACT_APPROVAL_REF);
  assertApprovedRef("LEGAL_GATE_APPROVAL_REF", LEGAL_GATE_APPROVAL_REF);
  assertApprovedRef("AML_POLICY_APPROVAL_REF", AML_POLICY_APPROVAL_REF);
  assertApprovedRef("PRIVACY_POLICY_APPROVAL_REF", PRIVACY_POLICY_APPROVAL_REF);
  assertApprovedRef("APPI_POLICY_APPROVAL_REF", APPI_POLICY_APPROVAL_REF);
  assertApprovedRef("APPI_RETENTION_POLICY_REF", APPI_RETENTION_POLICY_REF);
  assertApprovedRef("APPI_DELETION_PROCEDURE_REF", APPI_DELETION_PROCEDURE_REF);
  assertApprovedRef("APPI_DISCLOSURE_PROCEDURE_REF", APPI_DISCLOSURE_PROCEDURE_REF);
  assertApprovedRef("CONFIRMATIONS_POLICY_APPROVAL_REF", CONFIRMATIONS_POLICY_APPROVAL_REF);
  assertApprovedRef("BACKSCAN_POLICY_APPROVAL_REF", BACKSCAN_POLICY_APPROVAL_REF);
  for (const [name, value] of Object.entries({ TERMS_URL, PRIVACY_URL, REFUND_POLICY_URL })) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname)) throw new Error("not public https");
    } catch {
      console.error(`FATAL: ${name} must be a public HTTPS URL in production.`);
      process.exit(1);
    }
  }
  for (const [name, value] of Object.entries({ TERMS_VERSION, PRIVACY_VERSION, REFUND_POLICY_VERSION })) {
    if (isPlaceholderLike(value) || /draft/i.test(value)) {
      console.error(`FATAL: ${name} must be a non-draft approved version in production.`);
      process.exit(1);
    }
  }
  if (!CHECKOUT_SESSION_IMPLEMENTED) {
    console.error("FATAL: CHECKOUT_SESSION_IMPLEMENTED must be true in production.");
    process.exit(1);
  }
  if (STAFF_PIN === "1234" || SECOND_ADMIN_PIN === "1234" || TERMINAL_CODE === "TERM-001") {
    console.error("FATAL: default credentials/codes are not allowed in production.");
    process.exit(1);
  }
  if (STAFF_PIN === "0000" || isWeakSecretValue(TERMINAL_CODE) || TERMINAL_CODE.length < 8) {
    console.error("FATAL: production terminal code and PIN values must be non-default and strong enough.");
    process.exit(1);
  }
  if (!LEGAL_GATE_APPROVED || !AML_POLICY_APPROVED || !PRIVACY_POLICY_APPROVED || !APPI_POLICY_APPROVED) {
    console.error("FATAL: legal/AML/privacy/APPI approvals must be explicitly enabled in production.");
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(path.join(CWD, "public"), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  admin_contact TEXT NOT NULL,
  invoice_ttl_sec INTEGER NOT NULL DEFAULT 300,
  chain_id TEXT NOT NULL DEFAULT '137',
  token_contract TEXT NOT NULL DEFAULT '',
  settlement_unresolved_review_policy TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  terminal_code TEXT NOT NULL UNIQUE,
  public_entry_token TEXT UNIQUE,
  current_invoice_id TEXT REFERENCES invoices(id),
  current_invoice_assigned_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_users (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  staff_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  pin_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES terminals(id),
  staff_user_id TEXT NOT NULL REFERENCES staff_users(id),
  token_hash TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  revoked_at TEXT,
  ended_reason TEXT
);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  terminal_id TEXT NOT NULL REFERENCES terminals(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  store_id TEXT REFERENCES stores(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booths (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  store_id TEXT REFERENCES stores(id),
  booth_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_booths_event_booth_code ON booths(event_id, booth_code);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  merchant_id TEXT REFERENCES merchants(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  terminal_id TEXT NOT NULL REFERENCES terminals(id),
  staff_user_id TEXT NOT NULL REFERENCES staff_users(id),
  operator_id TEXT REFERENCES staff_users(id),
  event_id TEXT REFERENCES events(id),
  booth_id TEXT REFERENCES booths(id),
  amount_jpy INTEGER NOT NULL,
  amount_jpyc REAL NOT NULL,
  amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  chain_id TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  payment_url TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  paid_amount_jpyc REAL NOT NULL DEFAULT 0,
  paid_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  paid_tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  event_type TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER,
  block_number INTEGER,
  confirmations INTEGER NOT NULL DEFAULT 0,
  from_address TEXT,
  to_address TEXT,
  token_contract TEXT NOT NULL,
  amount_jpyc REAL NOT NULL,
  amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_events_dedupe
ON payment_events(chain_id, tx_hash, COALESCE(log_index, -1), event_type);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  chain_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  verified_onchain INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_attempts_chain_tx_log
ON payment_attempts(chain_id, tx_hash, COALESCE(log_index, -1));

CREATE TABLE IF NOT EXISTS receive_addresses (
  id TEXT PRIMARY KEY,
  merchant_id TEXT,
  store_id TEXT REFERENCES stores(id),
  network TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL,
  allocated_invoice_id TEXT UNIQUE,
  allocated_at TEXT,
  retired_at TEXT,
	  disabled_reason TEXT,
	  source_label TEXT,
	  control_proof_type TEXT,
		  control_proof_payload_hash TEXT,
		  verified_by TEXT,
		  verified_at TEXT,
		  approval_ref TEXT,
		  proof_batch_id TEXT,
		  proof_nonce_hash TEXT,
		  proof_valid_from TEXT,
		  proof_valid_until TEXT,
		  proof_scope_hash TEXT,
		  created_at TEXT NOT NULL,
		  updated_at TEXT NOT NULL
		);
CREATE UNIQUE INDEX IF NOT EXISTS ux_receive_addresses_network_token_address
ON receive_addresses(network, token_contract, address);
CREATE INDEX IF NOT EXISTS idx_receive_addresses_store_status
ON receive_addresses(store_id, status, created_at);

CREATE TABLE IF NOT EXISTS review_cases (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
  reason_type TEXT NOT NULL,
  tx_hash TEXT,
  billed_amount_jpyc_base TEXT,
  paid_amount_jpyc_base TEXT,
  diff_jpyc_base TEXT,
  suggested_action TEXT,
  refundable_candidate_jpyc_base TEXT,
  admin_note TEXT,
  action_history_json TEXT,
  resolution_status TEXT,
  audit_ref TEXT,
  block_timestamp TEXT,
  detected_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS refund_requests (
  id TEXT PRIMARY KEY,
  review_case_id TEXT NOT NULL REFERENCES review_cases(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  original_invoice_id TEXT,
  checkout_session_id TEXT,
  original_tx_hash TEXT,
  reason TEXT,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL,
  refund_amount_jpyc REAL NOT NULL,
  refund_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  refund_to_address TEXT NOT NULL,
  refund_chain_id TEXT NOT NULL,
  refund_tx_hash TEXT,
  refund_tx_log_index INTEGER,
  expected_from_address TEXT,
  executed_wallet TEXT,
  evidence_screenshot TEXT,
  evidence_note_path TEXT,
  customer_note TEXT,
  audit_log_refs TEXT,
  executed_by TEXT,
  executor_type TEXT,
  execution_ref TEXT,
  from_address TEXT,
  to_address TEXT,
  chain_id TEXT,
  token_contract TEXT,
  block_number INTEGER,
  block_timestamp TEXT,
  detected_at TEXT,
  audit_log TEXT,
  verified_at TEXT,
  last_attempted_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_id TEXT,
  idempotency_key TEXT,
  before_state TEXT,
  after_state TEXT,
  prev_hash TEXT,
  entry_hash TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(actor_id, endpoint, idempotency_key)
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  event_id TEXT REFERENCES events(id),
  booth_id TEXT REFERENCES booths(id),
  business_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  period_start_utc TEXT NOT NULL,
  period_end_utc TEXT NOT NULL,
  invoice_count INTEGER NOT NULL,
  total_billed_jpy INTEGER NOT NULL,
  total_paid_jpyc REAL NOT NULL,
  total_paid_jpyc_base INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL,
  unresolved_review_policy TEXT,
  unresolved_review_note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(store_id, business_date)
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(role, permission)
);

CREATE TABLE IF NOT EXISTS invoice_lineage (
  id TEXT PRIMARY KEY,
  checkout_session_id TEXT,
  from_invoice_id TEXT NOT NULL REFERENCES invoices(id),
  to_invoice_id TEXT NOT NULL REFERENCES invoices(id),
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(from_invoice_id, to_invoice_id)
);

CREATE TABLE IF NOT EXISTS settlement_exports (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  store_id TEXT REFERENCES stores(id),
  event_id TEXT REFERENCES events(id),
  booth_id TEXT REFERENCES booths(id),
  settlement_id TEXT REFERENCES settlements(id),
  business_date TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'csv',
  output_path TEXT NOT NULL,
  generated_by TEXT,
  generated_at TEXT NOT NULL,
  metadata_json TEXT
);
CREATE TABLE IF NOT EXISTS payment_sessions (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  rail_type TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  status TEXT NOT NULL,
  fulfillment_decision TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_invoice_id ON payment_sessions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_rail_provider_status ON payment_sessions(rail_type, provider_code, status);

CREATE TABLE IF NOT EXISTS provider_payment_sessions (
  id TEXT PRIMARY KEY,
  payment_session_id TEXT NOT NULL REFERENCES payment_sessions(id),
  provider_code TEXT NOT NULL,
  provider_terminal_id TEXT,
  provider_session_id TEXT,
  provider_payment_id TEXT,
  provider_status TEXT NOT NULL,
  provider_amount_jpyc_base INTEGER,
  provider_currency TEXT DEFAULT 'JPYC',
  provider_created_at TEXT,
  provider_authorized_at TEXT,
  provider_captured_at TEXT,
  provider_cancelled_at TEXT,
  provider_voided_at TEXT,
  provider_payload_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_payment_sessions_payment_session_id ON provider_payment_sessions(payment_session_id);
CREATE INDEX IF NOT EXISTS idx_provider_payment_sessions_provider_session ON provider_payment_sessions(provider_code, provider_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_payment_sessions_provider_payment
ON provider_payment_sessions(provider_code, provider_payment_id)
WHERE provider_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_payment_events (
  id TEXT PRIMARY KEY,
  provider_code TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_payment_id TEXT,
  provider_session_id TEXT,
  event_type TEXT NOT NULL,
  provider_status TEXT,
  amount_jpyc_base INTEGER,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  payload_hash TEXT NOT NULL,
  payload_schema_version TEXT NOT NULL DEFAULT 'provider_event_v1',
  tx_hash TEXT,
  batch_reference TEXT,
  provider_settlement_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider_code, provider_event_id)
);

CREATE TABLE IF NOT EXISTS provider_settlements (
  id TEXT PRIMARY KEY,
  provider_code TEXT NOT NULL,
  provider_settlement_id TEXT NOT NULL,
  batch_reference TEXT,
  settlement_status TEXT NOT NULL,
  settlement_amount_jpyc_base INTEGER NOT NULL,
  settlement_currency TEXT DEFAULT 'JPYC',
  reported_at TEXT,
  settled_at TEXT,
  payload_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_code, provider_settlement_id)
);

CREATE TABLE IF NOT EXISTS provider_settlement_allocations (
  id TEXT PRIMARY KEY,
  provider_settlement_id TEXT NOT NULL REFERENCES provider_settlements(id),
  provider_payment_id TEXT NOT NULL,
  invoice_id TEXT REFERENCES invoices(id),
  allocated_amount_jpyc_base INTEGER NOT NULL,
  allocation_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_settlement_allocations_settlement_id ON provider_settlement_allocations(provider_settlement_id);
CREATE INDEX IF NOT EXISTS idx_provider_settlement_allocations_payment_id ON provider_settlement_allocations(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_provider_settlement_allocations_invoice_id ON provider_settlement_allocations(invoice_id);

CREATE TABLE IF NOT EXISTS payment_reconciliation_links (
  id TEXT PRIMARY KEY,
  invoice_id TEXT REFERENCES invoices(id),
  provider_payment_id TEXT,
  provider_settlement_id TEXT,
  blockchain_transfer_id TEXT,
  link_type TEXT NOT NULL,
  amount_jpyc_base INTEGER,
  confidence_level TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settlement_export_runs (
  id TEXT PRIMARY KEY,
  export_version TEXT NOT NULL DEFAULT 'v1',
  business_date TEXT NOT NULL,
  store_id TEXT,
  terminal_id TEXT,
  status TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlement_export_runs_business_date_store_terminal
ON settlement_export_runs(business_date, store_id, terminal_id);

CREATE TABLE IF NOT EXISTS settlement_export_rows (
  id TEXT PRIMARY KEY,
  export_run_id TEXT NOT NULL REFERENCES settlement_export_runs(id),
  export_version TEXT NOT NULL DEFAULT 'v1',
  business_date TEXT NOT NULL,
  store_id TEXT,
  terminal_id TEXT,
  operator_id TEXT,
  invoice_id TEXT,
  checkout_session_id TEXT,
  payment_session_id TEXT,
  rail_type TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  invoice_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  invoice_status TEXT NOT NULL,
  accounting_status TEXT NOT NULL,
  cash_recognition_status TEXT NOT NULL,
  receivable_status TEXT NOT NULL,
  onchain_cash_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  provider_receivable_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  exception_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  refund_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  void_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  provider_payment_ref TEXT,
  provider_settlement_ref TEXT,
  onchain_transfer_ref TEXT,
  evidence_hash TEXT NOT NULL,
  payload_json TEXT,
  payload_schema_version TEXT NOT NULL DEFAULT 'settlement_export_v1',
  export_excluded_private_data INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlement_export_rows_run_id ON settlement_export_rows(export_run_id);
CREATE INDEX IF NOT EXISTS idx_settlement_export_rows_business_date_store ON settlement_export_rows(business_date, store_id);

CREATE TABLE IF NOT EXISTS service_replay_guards (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(service_id, jti)
);

CREATE TABLE IF NOT EXISTS terminal_login_lockouts (
  terminal_code TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
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

CREATE TABLE IF NOT EXISTS chain_monitor_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_rpc_failovers (
  id TEXT PRIMARY KEY,
  provider_url TEXT NOT NULL,
  label TEXT NOT NULL,
  error_message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_scope_key_time
ON rate_limit_events(scope, key_hash, created_at_unix_ms);

CREATE TABLE IF NOT EXISTS suspicious_activity_logs (
  id TEXT PRIMARY KEY,
  store_id TEXT,
  invoice_id TEXT,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

function addColumnIfMissing(tableName, columnName, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (exists) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
}

addColumnIfMissing("invoices", "settled_at", "settled_at TEXT");
addColumnIfMissing("invoices", "settlement_id", "settlement_id TEXT");
addColumnIfMissing("invoices", "amount_jpyc_base", "amount_jpyc_base INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("invoices", "paid_amount_jpyc_base", "paid_amount_jpyc_base INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("invoices", "checkout_session_id", "checkout_session_id TEXT");
addColumnIfMissing("invoices", "reissued_from_invoice_id", "reissued_from_invoice_id TEXT");
addColumnIfMissing("invoices", "reissue_root_invoice_id", "reissue_root_invoice_id TEXT");
addColumnIfMissing("invoices", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("invoices", "operator_id", "operator_id TEXT");
addColumnIfMissing("invoices", "event_id", "event_id TEXT");
addColumnIfMissing("invoices", "booth_id", "booth_id TEXT");
addColumnIfMissing("payment_events", "amount_jpyc_base", "amount_jpyc_base INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("payment_events", "block_timestamp", "block_timestamp TEXT");
addColumnIfMissing("payment_events", "detected_at", "detected_at TEXT");
addColumnIfMissing("payment_attempts", "source", "source TEXT NOT NULL DEFAULT 'unknown'");
addColumnIfMissing("payment_attempts", "verified_onchain", "verified_onchain INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("receive_addresses", "control_proof_type", "control_proof_type TEXT");
addColumnIfMissing("receive_addresses", "control_proof_payload_hash", "control_proof_payload_hash TEXT");
addColumnIfMissing("receive_addresses", "verified_by", "verified_by TEXT");
addColumnIfMissing("receive_addresses", "verified_at", "verified_at TEXT");
addColumnIfMissing("receive_addresses", "approval_ref", "approval_ref TEXT");
addColumnIfMissing("receive_addresses", "proof_batch_id", "proof_batch_id TEXT");
addColumnIfMissing("receive_addresses", "proof_nonce_hash", "proof_nonce_hash TEXT");
addColumnIfMissing("receive_addresses", "proof_valid_from", "proof_valid_from TEXT");
addColumnIfMissing("receive_addresses", "proof_valid_until", "proof_valid_until TEXT");
addColumnIfMissing("receive_addresses", "proof_scope_hash", "proof_scope_hash TEXT");
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_receive_addresses_proof_nonce_hash
   ON receive_addresses(proof_nonce_hash)
   WHERE proof_nonce_hash IS NOT NULL`
);
addColumnIfMissing("refund_requests", "refund_amount_jpyc_base", "refund_amount_jpyc_base INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("refund_requests", "refund_eligible_jpyc_base", "refund_eligible_jpyc_base INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("refund_requests", "refund_tx_log_index", "refund_tx_log_index INTEGER");
addColumnIfMissing("refund_requests", "original_invoice_id", "original_invoice_id TEXT");
addColumnIfMissing("refund_requests", "checkout_session_id", "checkout_session_id TEXT");
addColumnIfMissing("refund_requests", "expected_from_address", "expected_from_address TEXT");
addColumnIfMissing("refund_requests", "executed_wallet", "executed_wallet TEXT");
addColumnIfMissing("refund_requests", "evidence_screenshot", "evidence_screenshot TEXT");
addColumnIfMissing("refund_requests", "evidence_note_path", "evidence_note_path TEXT");
addColumnIfMissing("refund_requests", "customer_note", "customer_note TEXT");
addColumnIfMissing("refund_requests", "audit_log_refs", "audit_log_refs TEXT");
addColumnIfMissing("refund_requests", "executed_by", "executed_by TEXT");
addColumnIfMissing("refund_requests", "executor_type", "executor_type TEXT");
addColumnIfMissing("refund_requests", "execution_ref", "execution_ref TEXT");
addColumnIfMissing("refund_requests", "verified_at", "verified_at TEXT");
addColumnIfMissing("refund_requests", "last_attempted_at", "last_attempted_at TEXT");
addColumnIfMissing("refund_requests", "original_tx_hash", "original_tx_hash TEXT");
addColumnIfMissing("refund_requests", "reason", "reason TEXT");
addColumnIfMissing("refund_requests", "from_address", "from_address TEXT");
addColumnIfMissing("refund_requests", "to_address", "to_address TEXT");
addColumnIfMissing("refund_requests", "chain_id", "chain_id TEXT");
addColumnIfMissing("refund_requests", "token_contract", "token_contract TEXT");
addColumnIfMissing("refund_requests", "block_number", "block_number INTEGER");
addColumnIfMissing("refund_requests", "block_timestamp", "block_timestamp TEXT");
addColumnIfMissing("refund_requests", "detected_at", "detected_at TEXT");
addColumnIfMissing("refund_requests", "audit_log", "audit_log TEXT");
addColumnIfMissing("settlements", "total_paid_jpyc_base", "total_paid_jpyc_base INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("settlements", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("settlements", "event_id", "event_id TEXT");
addColumnIfMissing("settlements", "booth_id", "booth_id TEXT");
addColumnIfMissing("settlements", "unresolved_review_policy", "unresolved_review_policy TEXT");
addColumnIfMissing("settlements", "unresolved_review_note", "unresolved_review_note TEXT");
addColumnIfMissing("audit_logs", "prev_hash", "prev_hash TEXT");
addColumnIfMissing("audit_logs", "entry_hash", "entry_hash TEXT");
addColumnIfMissing("terminal_sessions", "ended_reason", "ended_reason TEXT");
addColumnIfMissing("staff_users", "permissions_override", "permissions_override TEXT");
addColumnIfMissing("staff_users", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("stores", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("stores", "settlement_unresolved_review_policy", "settlement_unresolved_review_policy TEXT");
addColumnIfMissing("terminals", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("terminals", "public_entry_token", "public_entry_token TEXT");
addColumnIfMissing("terminals", "current_invoice_id", "current_invoice_id TEXT");
addColumnIfMissing("terminals", "current_invoice_assigned_at", "current_invoice_assigned_at TEXT");
addColumnIfMissing("checkout_sessions", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("idempotency_records", "expires_at", "expires_at TEXT");
addColumnIfMissing("settlement_export_rows", "payload_json", "payload_json TEXT");
addColumnIfMissing("chain_dead_letters", "status", "status TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing("chain_dead_letters", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("chain_dead_letters", "last_error", "last_error TEXT");
addColumnIfMissing("chain_dead_letters", "next_retry_at", "next_retry_at TEXT");
addColumnIfMissing("chain_dead_letters", "resolved_at", "resolved_at TEXT");
addColumnIfMissing("review_cases", "tx_hash", "tx_hash TEXT");
addColumnIfMissing("review_cases", "billed_amount_jpyc_base", "billed_amount_jpyc_base TEXT");
addColumnIfMissing("review_cases", "paid_amount_jpyc_base", "paid_amount_jpyc_base TEXT");
addColumnIfMissing("review_cases", "diff_jpyc_base", "diff_jpyc_base TEXT");
addColumnIfMissing("review_cases", "suggested_action", "suggested_action TEXT");
addColumnIfMissing("review_cases", "refundable_candidate_jpyc_base", "refundable_candidate_jpyc_base TEXT");
addColumnIfMissing("review_cases", "admin_note", "admin_note TEXT");
addColumnIfMissing("review_cases", "action_history_json", "action_history_json TEXT");
addColumnIfMissing("review_cases", "resolution_status", "resolution_status TEXT");
addColumnIfMissing("review_cases", "audit_ref", "audit_ref TEXT");
addColumnIfMissing("review_cases", "block_timestamp", "block_timestamp TEXT");
addColumnIfMissing("review_cases", "detected_at", "detected_at TEXT");

db.exec(`CREATE INDEX IF NOT EXISTS idx_invoices_merchant_store_terminal ON invoices(merchant_id, store_id, terminal_id, created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_invoices_event_booth ON invoices(event_id, booth_id, created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_review_cases_reason_status ON review_cases(reason_type, status, created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_refund_requests_status_created_at ON refund_requests(status, created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_settlement_exports_business_date ON settlement_exports(business_date, generated_at DESC)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_terminals_public_entry_token ON terminals(public_entry_token) WHERE public_entry_token IS NOT NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_terminals_current_invoice_id ON terminals(current_invoice_id)`);

db.exec(`DROP INDEX IF EXISTS ux_refund_requests_tx_hash_non_null`);
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_refund_requests_tx_hash_log_non_null
   ON refund_requests(refund_tx_hash, COALESCE(refund_tx_log_index, -1))
   WHERE refund_tx_hash IS NOT NULL`
);

const nowIso = () => new Date().toISOString();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashJson = (value) => sha256(JSON.stringify(value ?? {}));

function isPublicHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && !/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function buildPolicySnapshot() {
  const configured = {
    terms_url: String(TERMS_URL || "").trim(),
    privacy_url: String(PRIVACY_URL || "").trim(),
    refund_policy_url: String(REFUND_POLICY_URL || "").trim(),
    terms_version: String(TERMS_VERSION || "").trim(),
    privacy_version: String(PRIVACY_VERSION || "").trim(),
    refund_policy_version: String(REFUND_POLICY_VERSION || "").trim(),
  };
  const strict = IS_PRODUCTION || COMMERCIAL_GO_MODE || APP_ENV === "limited";
  if (strict) {
    return {
      ok: [configured.terms_url, configured.privacy_url, configured.refund_policy_url].every(isPublicHttpsUrl)
        && [configured.terms_version, configured.privacy_version, configured.refund_policy_version].every((value) => value && !isPlaceholderLike(value) && !/draft/i.test(value)),
      strict,
      snapshot: configured,
      error: "POLICY_CONFIG_REQUIRED",
    };
  }
  const appHost = String(APP_HOST || "http://localhost:4173").replace(/\/+$/, "");
  return {
    ok: true,
    strict,
    snapshot: {
      terms_url: configured.terms_url || `${appHost}/legal/dev-terms`,
      privacy_url: configured.privacy_url || `${appHost}/legal/dev-privacy`,
      refund_policy_url: configured.refund_policy_url || `${appHost}/legal/dev-refund`,
      terms_version: configured.terms_version || "dev-policy-terms",
      privacy_version: configured.privacy_version || "dev-policy-privacy",
      refund_policy_version: configured.refund_policy_version || "dev-policy-refund",
    },
    error: null,
  };
}
const uuid = () => crypto.randomUUID();
const TERMINAL_ACTIVE_INVOICE_STATUSES = new Set(["issued", "payment_detected", "confirming"]);

function isTerminalActiveInvoiceStatus(status) {
  return TERMINAL_ACTIVE_INVOICE_STATUSES.has(String(status || ""));
}

function generateTerminalPublicEntryToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function buildTerminalPublicEntryUrl(publicEntryToken) {
  const token = String(publicEntryToken || "").trim();
  if (!token) return null;
  return `${APP_HOST}/t/${encodeURIComponent(token)}`;
}

function buildTerminalPublicEntryMeta(terminal) {
  const publicEntryToken = String(terminal?.public_entry_token || "").trim();
  return {
    public_entry_token: publicEntryToken || null,
    fixed_qr_url: publicEntryToken ? buildTerminalPublicEntryUrl(publicEntryToken) : null,
  };
}

function terminalCurrentInvoiceSnapshot(terminal, extra = {}) {
  return {
    terminal_id: terminal?.id || null,
    current_invoice_id: terminal?.current_invoice_id || null,
    current_invoice_assigned_at: terminal?.current_invoice_assigned_at || null,
    ...extra,
  };
}

function summarizeInvoiceForTerminalState(invoice) {
  if (!invoice) return null;
  const review = findLatestReviewCase(invoice.id);
  return {
    invoice_id: invoice.id,
    invoice_no: invoice.invoice_no,
    checkout_session_id: invoice.checkout_session_id || null,
    terminal_id: invoice.terminal_id || null,
    status: invoice.status,
    status_reason: invoice.status_reason || null,
    amount_jpy: invoice.amount_jpy,
    amount_jpyc_base: invoice.amount_jpyc_base,
    paid_amount_jpyc_base: invoice.paid_amount_jpyc_base,
    expires_at: invoice.expires_at,
    payment_url: invoice.payment_url,
    recipient_address: invoice.recipient_address,
    review_case_id: review?.id || null,
  };
}

function getTerminalById(terminalId) {
  return db.prepare(`SELECT * FROM terminals WHERE id = ?`).get(terminalId) || null;
}

function getTerminalByPublicEntryToken(publicEntryToken) {
  return (
    db
      .prepare(
        `SELECT t.*, s.name AS store_name
         FROM terminals t
         JOIN stores s ON s.id = t.store_id
         WHERE t.public_entry_token = ?`
      )
      .get(String(publicEntryToken || "").trim()) || null
  );
}

function ensureTerminalPublicEntryToken(terminalId) {
  const current = getTerminalById(terminalId);
  if (!current) return null;
  if (String(current.public_entry_token || "").trim()) return current;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = generateTerminalPublicEntryToken();
    const updated = db
      .prepare(
        `UPDATE terminals
         SET public_entry_token = ?, updated_at = ?
         WHERE id = ?
           AND (public_entry_token IS NULL OR public_entry_token = '')`
      )
      .run(token, nowIso(), terminalId);
    if (updated.changes === 1) {
      return getTerminalById(terminalId);
    }
    const refreshed = getTerminalById(terminalId);
    if (String(refreshed?.public_entry_token || "").trim()) return refreshed;
  }
  throw new Error(`failed to assign terminal public entry token: ${terminalId}`);
}

function backfillTerminalPublicEntryTokens() {
  const terminals = db
    .prepare(`SELECT id FROM terminals WHERE public_entry_token IS NULL OR public_entry_token = '' ORDER BY created_at ASC, id ASC`)
    .all();
  for (const terminal of terminals) {
    ensureTerminalPublicEntryToken(terminal.id);
  }
}

function listTerminalActiveInvoices(terminalId) {
  return db
    .prepare(
      `SELECT *
       FROM invoices
       WHERE terminal_id = ?
         AND status IN ('issued', 'payment_detected', 'confirming')
       ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, rowid DESC`
    )
    .all(terminalId);
}

function auditTerminalCurrentInvoiceChange({
  beforeTerminal,
  afterTerminal,
  actorType = "system",
  actorId = "system",
  requestId = null,
  idempotencyKey = null,
  ip = null,
  reason = null,
}) {
  const beforeInvoiceId = String(beforeTerminal?.current_invoice_id || "");
  const afterInvoiceId = String(afterTerminal?.current_invoice_id || "");
  if (beforeInvoiceId === afterInvoiceId) return;
  let action = "terminal.current_invoice.reconciled";
  if (!beforeInvoiceId && afterInvoiceId) action = "terminal.current_invoice.assigned";
  if (beforeInvoiceId && !afterInvoiceId) action = "terminal.current_invoice.cleared";
  if (beforeInvoiceId && afterInvoiceId && beforeInvoiceId !== afterInvoiceId) action = "terminal.current_invoice.swapped";
  audit({
    actorType,
    actorId,
    action,
    targetType: "terminal",
    targetId: afterTerminal?.id || beforeTerminal?.id || null,
    requestId,
    idempotencyKey,
    beforeState: terminalCurrentInvoiceSnapshot(beforeTerminal, { reason }),
    afterState: terminalCurrentInvoiceSnapshot(afterTerminal, { reason }),
    ip,
  });
}

function setTerminalCurrentInvoicePointer({
  terminalId,
  invoiceId = null,
  assignedAt = null,
  actorType = "system",
  actorId = "system",
  requestId = null,
  idempotencyKey = null,
  ip = null,
  reason = null,
}) {
  const beforeTerminal = getTerminalById(terminalId);
  if (!beforeTerminal) return null;
  const nextInvoiceId = invoiceId ? String(invoiceId) : null;
  const nextAssignedAt = nextInvoiceId ? String(assignedAt || nowIso()) : null;
  if (
    String(beforeTerminal.current_invoice_id || "") === String(nextInvoiceId || "")
    && String(beforeTerminal.current_invoice_assigned_at || "") === String(nextAssignedAt || "")
  ) {
    return beforeTerminal;
  }
  db.prepare(
    `UPDATE terminals
     SET current_invoice_id = ?, current_invoice_assigned_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(nextInvoiceId, nextAssignedAt, nowIso(), terminalId);
  const afterTerminal = getTerminalById(terminalId);
  auditTerminalCurrentInvoiceChange({
    beforeTerminal,
    afterTerminal,
    actorType,
    actorId,
    requestId,
    idempotencyKey,
    ip,
    reason,
  });
  return afterTerminal;
}

function resolveTerminalCurrentInvoiceContext(
  terminalId,
  {
    repairPointer = false,
    actorType = "system",
    actorId = "system",
    requestId = null,
    idempotencyKey = null,
    ip = null,
  } = {}
) {
  let terminal = getTerminalById(terminalId);
  if (!terminal) {
    return {
      terminal: null,
      currentInvoice: null,
      activeInvoices: [],
      invariantBroken: false,
    };
  }

  const activeInvoices = listTerminalActiveInvoices(terminalId);
  if (activeInvoices.length > 1) {
    return {
      terminal,
      currentInvoice: null,
      activeInvoices,
      invariantBroken: true,
    };
  }

  const pointedInvoice = terminal.current_invoice_id
    ? db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(terminal.current_invoice_id) || null
    : null;
  const activeInvoice = activeInvoices[0] || null;
  const pointedIsUsable =
    pointedInvoice
    && String(pointedInvoice.terminal_id || "") === String(terminalId)
    && isTerminalActiveInvoiceStatus(pointedInvoice.status);
  let currentInvoice = pointedIsUsable ? pointedInvoice : activeInvoice;

  if (repairPointer) {
    if (currentInvoice && String(terminal.current_invoice_id || "") !== String(currentInvoice.id)) {
      terminal = setTerminalCurrentInvoicePointer({
        terminalId,
        invoiceId: currentInvoice.id,
        assignedAt: terminal.current_invoice_assigned_at || currentInvoice.created_at || nowIso(),
        actorType,
        actorId,
        requestId,
        idempotencyKey,
        ip,
        reason: pointedInvoice ? "pointer_reconciled_to_active_invoice" : "pointer_assigned_to_active_invoice",
      }) || terminal;
    } else if (!currentInvoice && terminal.current_invoice_id) {
      terminal = setTerminalCurrentInvoicePointer({
        terminalId,
        invoiceId: null,
        actorType,
        actorId,
        requestId,
        idempotencyKey,
        ip,
        reason: "pointer_cleared_without_active_invoice",
      }) || terminal;
    }
  }

  return {
    terminal,
    currentInvoice,
    activeInvoices,
    invariantBroken: false,
  };
}

function buildTerminalActiveInvoiceError(context) {
  if (context?.invariantBroken) {
    return {
      code: "TERMINAL_ACTIVE_INVOICE_INVARIANT_BROKEN",
      message: "multiple active invoices exist for this terminal",
      details: {
        terminal_id: context?.terminal?.id || null,
        active_invoices: (context?.activeInvoices || []).map(summarizeInvoiceForTerminalState),
      },
    };
  }
  return {
    code: "TERMINAL_ACTIVE_INVOICE_EXISTS",
    message: "active invoice exists for this terminal",
    details: {
      terminal_id: context?.terminal?.id || null,
      active_invoice: summarizeInvoiceForTerminalState(context?.currentInvoice || null),
    },
  };
}

function buildPublicTerminalEntryState(publicEntryToken) {
  const terminal = getTerminalByPublicEntryToken(publicEntryToken);
  if (!terminal) return null;
  const context = resolveTerminalCurrentInvoiceContext(terminal.id, {
    repairPointer: true,
    actorType: "system",
    actorId: "terminal.public_entry",
    reason: "public_entry_reconciliation",
  });
  const publicMeta = buildTerminalPublicEntryMeta(context.terminal || terminal);
  if (context.invariantBroken) {
    return {
      status: "blocked",
      store_name: terminal.store_name || "JPYC Store",
      fixed_qr_url: publicMeta.fixed_qr_url,
      public_entry_token: publicMeta.public_entry_token,
      active_invoices: context.activeInvoices.map(summarizeInvoiceForTerminalState),
      message: "terminal has multiple active invoices",
    };
  }
  if (context.currentInvoice) {
    const providerSummary = buildProviderSummary(context.currentInvoice);
    if (providerSummary?.qr_available === false) {
      return {
        status: "tap_presented",
        store_name: terminal.store_name || "JPYC Store",
        fixed_qr_url: publicMeta.fixed_qr_url,
        public_entry_token: publicMeta.public_entry_token,
        active_invoice: summarizeInvoiceForTerminalState(context.currentInvoice),
        customer_payment_mode: providerSummary.customer_payment_mode,
        message: providerSummary.customer_payment_mode?.body || "店頭端末でお支払いをご案内しています。",
      };
    }
    return {
      status: "ready",
      store_name: terminal.store_name || "JPYC Store",
      fixed_qr_url: publicMeta.fixed_qr_url,
      public_entry_token: publicMeta.public_entry_token,
      pay_url: context.currentInvoice.payment_url,
      active_invoice: summarizeInvoiceForTerminalState(context.currentInvoice),
      resolved_at: nowIso(),
    };
  }
  return {
    status: "waiting",
    store_name: terminal.store_name || "JPYC Store",
    fixed_qr_url: publicMeta.fixed_qr_url,
    public_entry_token: publicMeta.public_entry_token,
    poll_interval_ms: 3000,
  };
}

function safeDecimalToBase(value, context) {
  try {
    return parseDecimalToBaseUnits(String(value ?? "0"), JPYC_SCALE_DECIMALS);
  } catch (error) {
    console.warn(
      JSON.stringify({
        ts: nowIso(),
        level: "warn",
        type: "amount.base_conversion_failed",
        context,
        value: String(value ?? ""),
        message: String(error.message || error),
      })
    );
    return "0";
  }
}

function parseJsonWithWarning(raw, context, fallback = null) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(
      JSON.stringify({
        ts: nowIso(),
        level: "warn",
        type: "json.parse_failed",
        context,
        message: String(error.message || error),
      })
    );
    return fallback;
  }
}


function toDisplayJpyc(baseUnits) {
  try {
    return formatBaseUnitsForDisplay(String(baseUnits ?? "0"), JPYC_SCALE_DECIMALS);
  } catch (_error) {
    return "0";
  }
}

function getNetworkLabel(chainId) {
  const normalized = String(chainId ?? "").trim();
  if (normalized === "137") return "Polygon";
  return normalized || "Unknown";
}

function computeInvoiceExpectedAmountAtomic(invoice) {
  const invoiceBase = String(invoice?.amount_jpyc_base || safeDecimalToBase(invoice?.amount_jpyc, "invoice.wallet_payload.amount"));
  try {
    const converted = convertBaseUnitsBetweenDecimals(invoiceBase, JPYC_SCALE_DECIMALS, TOKEN_DECIMALS);
    return converted.value;
  } catch (_error) {
    return null;
  }
}

function computeTtlRemainingSec(expiresAt, nowMs = Date.now()) {
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return null;
  return Math.floor((expiryMs - nowMs) / 1000);
}

function getReissueRootInvoiceId(invoice) {
  return String(invoice?.reissue_root_invoice_id || invoice?.reissued_from_invoice_id || invoice?.id || "");
}

function listInvoiceReissueHistory(invoice) {
  const rootInvoiceId = getReissueRootInvoiceId(invoice);
  if (!rootInvoiceId) {
    return {
      root_invoice_id: null,
      latest_invoice_id: null,
      total_versions: 0,
      history: [],
    };
  }
  const rows = db
    .prepare(
      `SELECT rowid, id, invoice_no, status, status_reason, recipient_address, payment_url, expires_at, created_at, updated_at,
              reissued_from_invoice_id
       FROM invoices
       WHERE id = ? OR reissue_root_invoice_id = ?
       ORDER BY datetime(created_at) DESC, datetime(updated_at) DESC, rowid DESC`
    )
    .all(rootInvoiceId, rootInvoiceId);
  return {
    root_invoice_id: rootInvoiceId,
    latest_invoice_id: rows[0]?.id || rootInvoiceId,
    total_versions: rows.length,
    history: rows.map((row) => ({
      invoice_id: row.id,
      invoice_no: row.invoice_no,
      status: row.status,
      status_reason: row.status_reason,
      receive_address: row.recipient_address,
      pay_url: row.payment_url,
      expires_at: row.expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      reissued_from_invoice_id: row.reissued_from_invoice_id || null,
    })),
  };
}

function buildInvoiceWalletPayload(invoice, store = null) {
  return buildWalletLaunchPayload({
    env: ENV,
    chainId: invoice?.chain_id || CHAIN_ID,
    network: getNetworkLabel(invoice?.chain_id || CHAIN_ID),
    tokenSymbol: TOKEN_SYMBOL,
    tokenContract: invoice?.token_contract || TOKEN_CONTRACT,
    tokenDecimals: TOKEN_DECIMALS,
    receiveAddress: invoice?.recipient_address || RECIPIENT_ADDRESS,
    expectedAmountAtomic: computeInvoiceExpectedAmountAtomic(invoice),
    amountJpy: invoice?.amount_jpy,
    expiresAt: invoice?.expires_at,
    payUrl: invoice?.payment_url,
    storeName: store?.name,
  });
}

function buildInvoiceDiagnostics(invoice, store = null, reviewCase = null) {
  const walletPayload = buildInvoiceWalletPayload(invoice, store);
  return {
    enabled: true,
    generated_at: nowIso(),
    invoice_status: invoice.status,
    status_reason: invoice.status_reason || null,
    review_reason_type: reviewCase?.reason_type ? normalizeReviewReasonCode(reviewCase.reason_type) : null,
    payment_uri: walletPayload.payment_uri,
    wallet_deeplink: walletPayload.wallet_deeplink,
    wallet_url: walletPayload.wallet_url,
    wallet_adapter: {
      adapter_type: walletPayload.wallet_adapter?.adapter_type || null,
      available: walletPayload.wallet_adapter?.available === true,
      status: walletPayload.wallet_adapter?.status || null,
      reason: walletPayload.wallet_adapter?.reason || null,
    },
    supported_wallets: Array.isArray(walletPayload.supported_wallets) ? walletPayload.supported_wallets : [],
    chain_id: walletPayload.chain_id,
    network: walletPayload.network,
    token_symbol: walletPayload.token_symbol,
    token_contract: walletPayload.token_contract,
    token_decimals: walletPayload.token_decimals,
    receive_address: walletPayload.receive_address,
    expected_amount_atomic: walletPayload.expected_amount_atomic,
    payment_url: invoice.payment_url,
    pay_url: walletPayload.pay_url,
    expires_at: invoice.expires_at,
    ttl_remaining_sec: computeTtlRemainingSec(invoice.expires_at),
    copy_fallback: walletPayload.copy_fallback,
    reissue: listInvoiceReissueHistory(invoice),
  };
}

function formatJpyc(baseUnits) {
  return toDisplayJpyc(baseUnits);
}

function defaultProviderCodeForPresentation() {
  return ENABLE_PROVIDER_RAIL_MOCK ? PROVIDER_CODES.MOCK_PROVIDER : PROVIDER_CODES.MYNA_WALLET_STERA;
}

function runMigration(version, fn) {
  const exists = db.prepare(`SELECT 1 AS ok FROM schema_migrations WHERE version = ?`).get(version);
  if (exists?.ok === 1) return;
  db.transaction(() => {
    fn();
    db.prepare(`INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`).run(version, nowIso());
  })();
}

runMigration("20260419_001_money_base_units", () => {
  const invoiceRows = db.prepare(`SELECT id, amount_jpyc, paid_amount_jpyc, amount_jpyc_base, paid_amount_jpyc_base FROM invoices`).all();
  for (const row of invoiceRows) {
    const amountBase = row.amount_jpyc_base ? String(row.amount_jpyc_base) : safeDecimalToBase(row.amount_jpyc, "migration.invoices.amount");
    const paidBase = row.paid_amount_jpyc_base
      ? String(row.paid_amount_jpyc_base)
      : safeDecimalToBase(row.paid_amount_jpyc, "migration.invoices.paid_amount");
    db.prepare(`UPDATE invoices SET amount_jpyc_base = ?, paid_amount_jpyc_base = ? WHERE id = ?`).run(amountBase, paidBase, row.id);
  }
  const eventRows = db.prepare(`SELECT id, amount_jpyc, amount_jpyc_base FROM payment_events`).all();
  for (const row of eventRows) {
    const amountBase = row.amount_jpyc_base ? String(row.amount_jpyc_base) : safeDecimalToBase(row.amount_jpyc, "migration.payment_events.amount");
    db.prepare(`UPDATE payment_events SET amount_jpyc_base = ? WHERE id = ?`).run(amountBase, row.id);
  }
  const refundRows = db.prepare(`SELECT id, refund_amount_jpyc, refund_amount_jpyc_base FROM refund_requests`).all();
  for (const row of refundRows) {
    const amountBase = row.refund_amount_jpyc_base
      ? String(row.refund_amount_jpyc_base)
      : safeDecimalToBase(row.refund_amount_jpyc, "migration.refunds.amount");
    db.prepare(`UPDATE refund_requests SET refund_amount_jpyc_base = ? WHERE id = ?`).run(amountBase, row.id);
  }
  const settlementRows = db.prepare(`SELECT id, total_paid_jpyc, total_paid_jpyc_base FROM settlements`).all();
  for (const row of settlementRows) {
    const amountBase = row.total_paid_jpyc_base
      ? String(row.total_paid_jpyc_base)
      : safeDecimalToBase(row.total_paid_jpyc, "migration.settlement.amount");
    db.prepare(`UPDATE settlements SET total_paid_jpyc_base = ? WHERE id = ?`).run(amountBase, row.id);
  }
});

function computeAuditEntryHash(prevHash, entryData) {
  const payload = JSON.stringify({
    prev_hash: prevHash || null,
    actor_type: entryData.actorType,
    actor_id: entryData.actorId,
    action: entryData.action,
    target_type: entryData.targetType,
    target_id: entryData.targetId,
    request_id: entryData.requestId || null,
    idempotency_key: entryData.idempotencyKey || null,
    before_state: entryData.beforeState || null,
    after_state: entryData.afterState || null,
    ip_address: entryData.ip || null,
    created_at: entryData.createdAt
  });
  return sha256(payload);
}

runMigration("20260419_002_audit_hash_backfill", () => {
  const rows = db.prepare(`SELECT rowid, * FROM audit_logs ORDER BY rowid ASC`).all();
  let prevHash = null;
  for (const row of rows) {
    const createdAt = row.created_at || nowIso();
    const entryHash = computeAuditEntryHash(prevHash, {
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      requestId: row.request_id,
      idempotencyKey: row.idempotency_key,
      beforeState: parseJsonWithWarning(row.before_state, "audit_hash_backfill.before_state", null),
      afterState: parseJsonWithWarning(row.after_state, "audit_hash_backfill.after_state", null),
      ip: row.ip_address,
      createdAt
    });
    db.prepare(`UPDATE audit_logs SET prev_hash = ?, entry_hash = ? WHERE id = ?`).run(prevHash, entryHash, row.id);
    prevHash = entryHash;
  }
});

runMigration("20260419_003_audit_hash_rechain_rowid", () => {
  const rows = db.prepare(`SELECT rowid, * FROM audit_logs ORDER BY rowid ASC`).all();
  let prevHash = null;
  for (const row of rows) {
    const createdAt = row.created_at || nowIso();
    const beforeState = parseJsonWithWarning(row.before_state, "audit_hash_rechain.before_state", null);
    const afterState = parseJsonWithWarning(row.after_state, "audit_hash_rechain.after_state", null);
    const entryHash = computeAuditEntryHash(prevHash, {
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      requestId: row.request_id,
      idempotencyKey: row.idempotency_key,
      beforeState,
      afterState,
      ip: row.ip_address,
      createdAt
    });
    db.prepare(`UPDATE audit_logs SET prev_hash = ?, entry_hash = ? WHERE id = ?`).run(prevHash, entryHash, row.id);
    prevHash = entryHash;
  }
});

runMigration("20260420_001_idempotency_ttl_backfill", () => {
  const fallbackExpiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SEC * 1000).toISOString();
  db.prepare(`UPDATE idempotency_records SET expires_at = ? WHERE expires_at IS NULL OR expires_at = ''`).run(fallbackExpiresAt);
});

runMigration("20260422_001_review_reason_code_normalization", () => {
  const rows = db.prepare(`SELECT id, reason_type, action_history_json, resolution_status FROM review_cases`).all();
  for (const row of rows) {
    const normalized = normalizeReviewReasonCode(row.reason_type || REVIEW_REASON_CODES.OTHER);
    const history = row.action_history_json && String(row.action_history_json).trim() ? row.action_history_json : "[]";
    const resolutionStatus = normalizeReviewResolutionStatus(row.resolution_status, "pending") || "pending";
    db.prepare(`UPDATE review_cases SET reason_type = ?, action_history_json = ?, resolution_status = ? WHERE id = ?`).run(
      normalized,
      history,
      resolutionStatus,
      row.id
    );
  }
});

function hmac(value) {
  return crypto.createHmac("sha256", APP_SECRET).update(value).digest("hex");
}

function hmacWithSecret(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function hashPin(pin) {
  return bcrypt.hashSync(String(pin), 12);
}

function verifyPin(staffPin, storedHash) {
  const value = String(staffPin);
  if (!storedHash) return false;
  if (storedHash.startsWith("$2a$") || storedHash.startsWith("$2b$") || storedHash.startsWith("$2y$")) {
    return bcrypt.compareSync(value, storedHash);
  }
  return sha256(value) === storedHash;
}

function toHexBuffer(value) {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) return null;
  return Buffer.from(value, "hex");
}

function safeHexEqual(left, right) {
  const a = toHexBuffer(left);
  const b = toHexBuffer(right);
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signInvoiceAccess(invoiceId, expiresAtIso) {
  const expiresSec = Math.floor(new Date(expiresAtIso).getTime() / 1000) + PUBLIC_LINK_GRACE_SEC;
  const nonce = crypto.randomBytes(12).toString("hex");
  const sig = hmac(`${invoiceId}.${expiresSec}.${nonce}`);
  return { expiresSec, nonce, sig };
}

function createSignedPayRef(invoiceId, expiresAtIso) {
  const signature = signInvoiceAccess(invoiceId, expiresAtIso);
  const payload = {
    invoice_id: invoiceId,
    exp: signature.expiresSec,
    nonce: signature.nonce,
    sig: signature.sig,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function parseSignedPayRef(ref) {
  try {
    const decoded = Buffer.from(String(ref || ""), "base64url").toString("utf8");
    const payload = JSON.parse(decoded);
    return {
      invoiceId: String(payload.invoice_id || ""),
      exp: String(payload.exp || ""),
      nonce: String(payload.nonce || ""),
      sig: String(payload.sig || ""),
    };
  } catch (_error) {
    return null;
  }
}

function verifySig(invoiceId, expRaw, nonce, sig) {
  if (!invoiceId || !expRaw || !nonce || !sig) return { ok: false, reason: "missing_signature_fields" };
  const exp = Number(expRaw);
  if (!Number.isInteger(exp)) return { ok: false, reason: "invalid_exp" };
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp < nowSec) return { ok: false, reason: "signature_expired" };
  if (!/^[0-9a-f]{24}$/i.test(nonce)) return { ok: false, reason: "invalid_nonce" };
  const expected = hmac(`${invoiceId}.${exp}.${nonce}`);
  if (!safeHexEqual(expected, sig)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

const RATE_LIMIT_RETENTION_MS =
  Math.max(PUBLIC_RATE_LIMIT_WINDOW_MS, LOGIN_RATE_LIMIT_WINDOW_MS, 60_000) * 12;
let rateLimitCleanupTick = 0;
function cleanupRateLimitEvents(nowMs) {
  rateLimitCleanupTick = (rateLimitCleanupTick + 1) % 100;
  if (rateLimitCleanupTick !== 0) return;
  db.prepare(`DELETE FROM rate_limit_events WHERE created_at_unix_ms <= ?`).run(nowMs - RATE_LIMIT_RETENTION_MS);
}

function makeHybridRateLimiter(scope, windowMs, maxRequests) {
  const buckets = new Map();
  return function isRateLimited(key) {
    const nowMs = Date.now();
    const windowStart = nowMs - windowMs;
    const keyHash = sha256(`${scope}:${String(key || "")}`);
    const bucket = buckets.get(keyHash) || [];
    const fresh = bucket.filter((ts) => ts > windowStart);
    fresh.push(nowMs);
    buckets.set(keyHash, fresh);
    cleanupRateLimitEvents(nowMs);
    try {
      db.prepare(
        `INSERT INTO rate_limit_events(id, scope, key_hash, created_at, created_at_unix_ms)
         VALUES (?, ?, ?, ?, ?)`
      ).run(uuid(), scope, keyHash, nowIso(), nowMs);
      const dbCount = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rate_limit_events
             WHERE scope = ? AND key_hash = ? AND created_at_unix_ms > ?`
          )
          .get(scope, keyHash, windowStart)?.count || 0
      );
      return Math.max(fresh.length, dbCount) > maxRequests;
    } catch (error) {
      console.warn(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "rate_limit.db_fallback",
          scope,
          message: String(error.message || error),
        })
      );
      return fresh.length > maxRequests;
    }
  };
}

const isPublicRateLimited = makeHybridRateLimiter("public", PUBLIC_RATE_LIMIT_WINDOW_MS, PUBLIC_RATE_LIMIT_MAX);
const isLoginRateLimited = makeHybridRateLimiter("login", LOGIN_RATE_LIMIT_WINDOW_MS, LOGIN_RATE_LIMIT_MAX);

function parseTxHash(txHash) {
  const hash = String(txHash || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return null;
  return hash;
}

function utcRangeForBusinessDate(businessDate, timezone) {
  const start = DateTime.fromISO(businessDate, { zone: timezone }).startOf("day");
  if (!start.isValid) {
    return { error: "INVALID_BUSINESS_DATE", details: start.invalidExplanation || start.invalidReason };
  }
  const end = start.endOf("day");
  return {
    businessDateFrom: start.toISODate(),
    businessDateTo: end.toISODate(),
    fromUtc: start.toUTC().toISO({ suppressMilliseconds: false }),
    toUtc: end.toUTC().toISO({ suppressMilliseconds: false })
  };
}

function utcRangeForBusinessMonth(yearMonth, timezone) {
  const start = DateTime.fromISO(`${yearMonth}-01`, { zone: timezone }).startOf("month");
  if (!start.isValid) {
    return { error: "INVALID_BUSINESS_MONTH", details: start.invalidExplanation || start.invalidReason };
  }
  const end = start.endOf("month");
  return {
    businessDateFrom: start.toISODate(),
    businessDateTo: end.toISODate(),
    fromUtc: start.toUTC().toISO({ suppressMilliseconds: false }),
    toUtc: end.toUTC().toISO({ suppressMilliseconds: false })
  };
}

const SETTLEMENT_EXPORT_HEADERS = [
  "export_version",
  "export_reference",
  "settlement_id",
  "settlement_export_run_id",
  "settlement_export_row_id",
  "business_date",
  "invoice_id",
  "invoice_no",
  "checkout_session_id",
  "merchant_id",
  "store_id",
  "terminal_id",
  "operator_id",
  "event_id",
  "booth_id",
  "invoice_status",
  "status_reason",
  "amount_jpy",
  "amount_jpyc_base",
  "paid_amount_jpyc_base",
  "tx_hash",
  "payment_attempt_ids",
  "primary_tx_hash",
  "primary_tx_log_index",
  "reason_code",
  "review_case_id",
  "review_reason_type",
  "review_status",
  "block_timestamp",
  "detected_at",
  "audit_ref",
  "refund_status",
  "refund_request_id",
  "refund_tx_hash",
  "audit_log_refs",
  "external_sync_refs",
  "source_ledger_snapshot_hash",
  "rail_type",
  "provider_code",
  "accounting_status",
  "cash_recognition_status",
  "receivable_status",
  "onchain_cash_amount_jpyc_base",
  "provider_receivable_amount_jpyc_base",
  "exception_amount_jpyc_base",
  "refund_amount_jpyc_base",
  "void_amount_jpyc_base",
  "evidence_hash",
  "payload_schema_version",
  "export_excluded_private_data",
  "refund_verified_at",
  "created_at",
  "updated_at",
  "settled_at",
];

function sanitizeCsvCell(value) {
  const raw = String(value ?? "");
  const firstNonSpace = raw.match(/[^\s]/)?.[0] || "";
  if (["=", "+", "-", "@", "\t", "\r"].includes(firstNonSpace)) return `'${raw}`;
  return raw;
}

function escapeCsvCell(value) {
  return `"${sanitizeCsvCell(value).replace(/"/g, '""')}"`;
}

function serializeSettlementCsvValue(value) {
  if (Array.isArray(value) || (value && typeof value === "object")) {
    return JSON.stringify(value);
  }
  return value;
}

function buildSettlementExportCsv(rows) {
  const lines = [SETTLEMENT_EXPORT_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      SETTLEMENT_EXPORT_HEADERS.map((header) => {
        if (header === "reason_code") {
          return escapeCsvCell(normalizeReviewReasonCode(row.reason_code || REVIEW_REASON_CODES.OTHER));
        }
        return escapeCsvCell(serializeSettlementCsvValue(row[header]));
      }).join(",")
    );
  }
  return lines.join("\n");
}

function settlementAuditRefsForInvoice(invoiceId, extraTargetIds = []) {
  const targetIds = [...new Set([invoiceId, ...extraTargetIds].filter(Boolean))];
  if (targetIds.length === 0) return [];
  const refs = db
    .prepare(
      `SELECT id
       FROM audit_logs
       WHERE target_id IN (${targetIds.map(() => "?").join(",")})
       ORDER BY created_at ASC, id ASC
       LIMIT 20`
    )
    .all(...targetIds)
    .map((row) => row.id);
  return [...new Set(refs)];
}

function settlementPaymentAttemptIds(invoiceId) {
  return db
    .prepare(`SELECT id FROM payment_attempts WHERE invoice_id = ? ORDER BY created_at ASC, id ASC`)
    .all(invoiceId)
    .map((row) => row.id);
}

function settlementPrimaryLogIndex(invoiceId, txHash) {
  if (!txHash) return null;
  const event = db
    .prepare(
      `SELECT log_index
       FROM payment_events
       WHERE invoice_id = ? AND tx_hash = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`
    )
    .get(invoiceId, txHash);
  return event?.log_index ?? null;
}

function serializeSettlementExportV1Row(row, { exportReference = null, exportRunId = null, businessDate = null } = {}) {
  const payload = {
    export_version: "v1",
    export_reference: exportReference || row.export_reference || `settlement-${row.business_date}.csv`,
    settlement_id: row.settlement_id || null,
    settlement_export_run_id: exportRunId || row.settlement_export_run_id || row.export_run_id,
    settlement_export_row_id: row.settlement_export_row_id || row.id,
    business_date: businessDate || row.business_date,
    invoice_id: row.invoice_id,
    invoice_no: row.invoice_no || null,
    checkout_session_id: row.checkout_session_id || null,
    merchant_id: row.merchant_id || null,
    store_id: row.store_id || null,
    terminal_id: row.terminal_id || null,
    operator_id: row.operator_id || row.staff_user_id || null,
    event_id: row.event_id || null,
    booth_id: row.booth_id || null,
    invoice_status: row.invoice_status || null,
    status_reason: row.status_reason || null,
    amount_jpy: row.amount_jpy ?? null,
    amount_jpyc_base: row.amount_jpyc_base ?? row.invoice_amount_jpyc_base ?? null,
    paid_amount_jpyc_base: row.paid_amount_jpyc_base ?? null,
    tx_hash: row.tx_hash || row.onchain_transfer_ref || null,
    payment_attempt_ids: Array.isArray(row.payment_attempt_ids) ? row.payment_attempt_ids : [],
    primary_tx_hash: row.primary_tx_hash || row.tx_hash || row.onchain_transfer_ref || null,
    primary_tx_log_index: row.primary_tx_log_index ?? null,
    reason_code: normalizeReviewReasonCode(row.reason_code || row.review_reason_type || REVIEW_REASON_CODES.OTHER),
    review_case_id: row.review_case_id || null,
    review_reason_type: row.review_reason_type || null,
    review_status: row.review_status || null,
    block_timestamp: row.block_timestamp || null,
    detected_at: row.detected_at || null,
    audit_ref: row.audit_ref || null,
    refund_status: row.refund_status || null,
    refund_request_id: row.refund_request_id || null,
    refund_tx_hash: row.refund_tx_hash || null,
    audit_log_refs: Array.isArray(row.audit_log_refs) ? row.audit_log_refs : [],
    external_sync_refs: Array.isArray(row.external_sync_refs) ? row.external_sync_refs : [],
    source_ledger_snapshot_hash: row.source_ledger_snapshot_hash || row.evidence_hash,
    rail_type: row.rail_type || PAYMENT_RAIL_TYPES.WALLET_DIRECT,
    provider_code: row.provider_code || PROVIDER_CODES.SELF_WALLET,
    accounting_status: row.accounting_status,
    cash_recognition_status: row.cash_recognition_status,
    receivable_status: row.receivable_status,
    onchain_cash_amount_jpyc_base: toIntegerAmount(row.onchain_cash_amount_jpyc_base, 0),
    provider_receivable_amount_jpyc_base: toIntegerAmount(row.provider_receivable_amount_jpyc_base, 0),
    exception_amount_jpyc_base: toIntegerAmount(row.exception_amount_jpyc_base, 0),
    refund_amount_jpyc_base: toIntegerAmount(row.refund_amount_jpyc_base, 0),
    void_amount_jpyc_base: toIntegerAmount(row.void_amount_jpyc_base, 0),
    evidence_hash: row.evidence_hash || row.source_ledger_snapshot_hash,
    payload_schema_version: "settlement_export_v1",
    export_excluded_private_data: 1,
    refund_verified_at: row.refund_verified_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    settled_at: row.settled_at || null,
  };
  return Object.fromEntries(SETTLEMENT_EXPORT_HEADERS.map((header) => [header, payload[header] ?? null]));
}

function buildSettlementExportApiRows(rows, options) {
  return rows.map((row) => serializeSettlementExportV1Row(row, options));
}

function invoiceNo() {
  const date = new Date();
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const rnd = crypto.randomInt(100000, 999999);
  return `INV-${y}${m}${d}-${rnd}`;
}

function jsonError(res, status, code, message, details = {}) {
  return res.status(status).json({ error: { code, message, details } });
}

function requestIdFromReq(req) {
  return String(req.requestId || req.header("X-Request-Id") || uuid());
}

function parsePositiveNumber(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return { error: `${label} must be positive number` };
  return { value: num };
}

const INVOICE_FORBIDDEN_FIELDS = new Set([
  "chain_id",
  "token_contract",
  "recipient_address",
  "to_address",
  "contract",
  "chain",
]);

function findForbiddenInvoiceField(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of Object.keys(payload)) {
    if (INVOICE_FORBIDDEN_FIELDS.has(String(key))) return key;
  }
  return null;
}

function countRecipientActiveInvoices(storeId, recipientAddress) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM invoices i
       LEFT JOIN review_cases r ON r.invoice_id = i.id
       WHERE i.store_id = ?
         AND lower(i.recipient_address) = lower(?)
         AND (
           i.status IN ('issued', 'payment_detected', 'confirming')
           OR (i.status = 'review_required' AND COALESCE(r.status, 'open') IN ('open', 'in_progress'))
         )`
    )
    .get(storeId, recipientAddress);
  return Number(row?.count || 0);
}

function computeDailyStoreTotals(storeId, businessDate, timezone) {
  const range = utcRangeForBusinessDate(businessDate, timezone);
  if (range.error) return { error: range.error, details: range.details };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS invoice_count, COALESCE(SUM(amount_jpy), 0) AS amount_jpy
       FROM invoices
       WHERE store_id = ? AND created_at BETWEEN ? AND ?`
    )
    .get(storeId, range.fromUtc, range.toUtc);
  return {
    invoice_count: Number(row?.invoice_count || 0),
    amount_jpy: Number(row?.amount_jpy || 0),
  };
}

function issueInvoiceRecord({
  store,
  session,
  amountJpy,
  checkoutSessionId = null,
  reissuedFromInvoiceId = null,
  reissueRootInvoiceId = null,
  actorType = "system",
  actorId = "system",
  requestId = null,
  idempotencyKey = null,
  ip = null,
}) {
  const result = db.transaction(() => {
    const terminalContext = resolveTerminalCurrentInvoiceContext(session.terminal_id, {
      repairPointer: true,
      actorType,
      actorId,
      requestId,
      idempotencyKey,
      ip,
    });
    if (terminalContext.invariantBroken || terminalContext.currentInvoice) {
      return { error: buildTerminalActiveInvoiceError(terminalContext) };
    }

    const amountBase = toBaseUnits(amountJpy);
    if (amountBase.error) {
      return { error: { code: "VALIDATION_ERROR", message: "amount_jpy conversion failed" } };
    }

    const id = uuid();
    const no = invoiceNo();
    const ts = nowIso();
    const ttl = Number(store.invoice_ttl_sec || 300);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const chainId = String(store.chain_id || CHAIN_ID);
    const tokenContract = String(store.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT).toLowerCase();
    const poolConfigured = hasConfiguredReceiveAddressPool(session.store_id);
    const allocatedAddress = poolConfigured ? allocateReceiveAddress({ storeId: session.store_id, invoiceId: id }) : null;
    const recipient = allocatedAddress?.address || (!poolConfigured && !IS_PRODUCTION ? String(RECIPIENT_ADDRESS || "") : "");

    if (!recipient) {
      return {
        error: {
          code: "ADDRESS_POOL_EXHAUSTED",
          message: "no approved receive address is available for invoice issuance",
        },
      };
    }

    const activeRecipientInvoiceCount = countRecipientActiveInvoices(session.store_id, recipient);
    if (activeRecipientInvoiceCount >= MAX_ACTIVE_INVOICES_PER_RECIPIENT) {
      return {
        error: {
          code: "ADDRESS_POOL_EXHAUSTED",
          message: "active invoice exists for this receive address",
          details: { max_active_invoices_per_recipient: MAX_ACTIVE_INVOICES_PER_RECIPIENT },
        },
      };
    }

    const effectiveCheckoutSessionId = checkoutSessionId || uuid();
    const merchantId = store?.merchant_id || "merchant-001";
    if (!checkoutSessionId) {
      db.prepare(`INSERT INTO checkout_sessions(id, merchant_id, store_id, terminal_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        effectiveCheckoutSessionId,
        merchantId,
        session.store_id,
        session.terminal_id,
        ts
      );
    }
    const signedRef = createSignedPayRef(id, expiresAt);
    const paymentUrl = `${APP_HOST}/pay?ref=${encodeURIComponent(signedRef)}`;
    db.prepare(
      `INSERT INTO invoices
      (id, invoice_no, checkout_session_id, merchant_id, store_id, terminal_id, staff_user_id, operator_id, event_id, booth_id, amount_jpy, amount_jpyc, amount_jpyc_base,
       chain_id, token_contract, recipient_address, payment_url, expires_at, status, created_at, updated_at,
       reissued_from_invoice_id, reissue_root_invoice_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?)`
    ).run(
      id,
      no,
      effectiveCheckoutSessionId,
      merchantId,
      session.store_id,
      session.terminal_id,
      session.staff_user_id,
      session.staff_user_id,
      null,
      null,
      amountJpy,
      amountJpy,
      amountBase.value,
      chainId,
      tokenContract,
      recipient,
      paymentUrl,
      expiresAt,
      ts,
      ts,
      reissuedFromInvoiceId,
      reissueRootInvoiceId || reissuedFromInvoiceId || null
    );
    const createdInvoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id);
    ensureWalletDirectPaymentSession(createdInvoice);
    setTerminalCurrentInvoicePointer({
      terminalId: session.terminal_id,
      invoiceId: createdInvoice.id,
      assignedAt: ts,
      actorType,
      actorId,
      requestId,
      idempotencyKey,
      ip,
      reason: reissuedFromInvoiceId ? "reissue_new_active_invoice" : "invoice_created",
    });
    return {
      invoice: createdInvoice,
      checkoutSessionId: effectiveCheckoutSessionId,
      allocatedAddress,
      paymentUrl,
      expiresAt,
      signedRef,
    };
  })();
  return result;
}

function parsePositiveBaseUnits(value, label) {
  try {
    const parsed = parseDecimalToBaseUnits(String(value ?? ""), JPYC_SCALE_DECIMALS);
    if (BigInt(parsed) <= 0n) {
      return { error: `${label} must be positive amount` };
    }
    return { value: parsed };
  } catch (_error) {
    return { error: `${label} must be positive amount` };
  }
}

function parsePositiveBaseUnitInteger(value, label) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return { error: `${label} must be unsigned integer base units` };
  }
  try {
    if (BigInt(raw) <= 0n) {
      return { error: `${label} must be > 0` };
    }
  } catch (_error) {
    return { error: `${label} must be unsigned integer base units` };
  }
  return { value: raw };
}

function toIntegerAmount(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  try {
    return Number(BigInt(String(value)));
  } catch (_error) {
    return fallback;
  }
}

function createPaymentSession({
  invoiceId,
  railType,
  providerCode,
  status = PAYMENT_SESSION_STATUSES.CREATED,
  fulfillmentDecision = FULFILLMENT_DECISIONS.NONE,
  createdAt = nowIso(),
}) {
  const id = uuid();
  db.prepare(
    `INSERT INTO payment_sessions
     (id, invoice_id, rail_type, provider_code, status, fulfillment_decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, invoiceId, railType, providerCode, status, fulfillmentDecision, createdAt, createdAt);
  return db.prepare(`SELECT * FROM payment_sessions WHERE id = ?`).get(id);
}

function ensureWalletDirectPaymentSession(invoice) {
  const existing = db
    .prepare(
      `SELECT *
       FROM payment_sessions
       WHERE invoice_id = ? AND rail_type = ? AND provider_code = ?
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(invoice.id, PAYMENT_RAIL_TYPES.WALLET_DIRECT, PROVIDER_CODES.SELF_WALLET);
  if (existing) return existing;
  return createPaymentSession({
    invoiceId: invoice.id,
    railType: PAYMENT_RAIL_TYPES.WALLET_DIRECT,
    providerCode: PROVIDER_CODES.SELF_WALLET,
    status: PAYMENT_SESSION_STATUSES.CREATED,
  });
}

function getFallbackPaymentSession(invoice) {
  return {
    id: null,
    invoice_id: invoice.id,
    rail_type: PAYMENT_RAIL_TYPES.WALLET_DIRECT,
    provider_code: PROVIDER_CODES.SELF_WALLET,
    status: PAYMENT_SESSION_STATUSES.CREATED,
    fulfillment_decision: FULFILLMENT_DECISIONS.NONE,
    created_at: invoice.created_at,
    updated_at: invoice.updated_at,
  };
}

function getPaymentSessionsForInvoice(invoice) {
  const sessions = db.prepare(`SELECT * FROM payment_sessions WHERE invoice_id = ? ORDER BY created_at ASC`).all(invoice.id);
  if (sessions.length > 0) return sessions;
  return [getFallbackPaymentSession(invoice)];
}

function getLatestProviderRailSessionBundle(invoice, providerCode = null) {
  if (!invoice?.id) return null;
  const providerFilter = providerCode ? "AND provider_code = ?" : "";
  const args = providerCode
    ? [invoice.id, PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL, providerCode]
    : [invoice.id, PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL];
  const paymentSession = db
    .prepare(
      `SELECT *
       FROM payment_sessions
       WHERE invoice_id = ?
         AND rail_type = ?
         ${providerFilter}
       ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, rowid DESC
       LIMIT 1`
    )
    .get(...args);
  if (!paymentSession) return null;
  const providerSession = db
    .prepare(
      `SELECT *
       FROM provider_payment_sessions
       WHERE payment_session_id = ?
       ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, rowid DESC
       LIMIT 1`
    )
    .get(paymentSession.id) || null;
  const providerAllocation = providerSession?.provider_payment_id
    ? findLatestProviderAllocationForPayment(providerSession.provider_payment_id, invoice.id)
    : null;
  return { paymentSession, providerSession, providerAllocation };
}

function buildProviderOperatorState({ invoice, paymentSession, providerSession, providerAllocation }) {
  const invoiceStatus = String(invoice?.status || "");
  const paymentStatus = String(paymentSession?.status || "");
  const providerStatus = String(providerSession?.provider_status || "");
  const fulfillmentDecision = String(paymentSession?.fulfillment_decision || FULFILLMENT_DECISIONS.NONE);
  const allocationStatus = String(providerAllocation?.allocation_status || "");

  if (
    ["review_required", "manual_review"].includes(invoiceStatus)
    || paymentStatus === PAYMENT_SESSION_STATUSES.DISPUTED
    || providerStatus === "disputed"
    || allocationStatus === "disputed"
  ) {
    return {
      code: "needs_review",
      label: "要確認",
      headline: "金額差異や照合例外の確認が必要です",
      body: "商品は渡さず、review queue で確認してください。",
    };
  }

  if (paymentStatus === PAYMENT_SESSION_STATUSES.PRESENTED) {
    return {
      code: "waiting_customer",
      label: "受付待ち",
      headline: "カード・スマホをかざしてください",
      body: "店頭端末でタッチ待ちです。QR には切り替えず、この会計の案内を続けてください。",
    };
  }

  if (
    (paymentStatus === PAYMENT_SESSION_STATUSES.CREATED && providerSession)
    || providerStatus === "initialized"
  ) {
    return {
      code: "authorizing",
      label: "認証中",
      headline: "provider の受付結果を待っています",
      body: "端末の結果を待ち、追加操作はまだ案内しないでください。",
    };
  }

  if (
    fulfillmentDecision === FULFILLMENT_DECISIONS.ALLOW_FULFILLMENT
    || paymentStatus === PAYMENT_SESSION_STATUSES.ACCEPTED
    || ["authorized", "captured", "settlement_pending", "settled"].includes(providerStatus)
  ) {
    return {
      code: "fulfillment_ok",
      label: "商品渡しOK",
      headline: "店頭判断としては商品を渡してよい状態です",
      body: "ただし会計上の paid とは別です。settlement / on-chain 証跡は後続で確認されます。",
    };
  }

  if (
    [PAYMENT_SESSION_STATUSES.FAILED, PAYMENT_SESSION_STATUSES.CANCELLED].includes(paymentStatus)
    || ["failed", "voided"].includes(providerStatus)
  ) {
    return {
      code: "retry_required",
      label: "要再試行",
      headline: "このままでは完了していません",
      body: "必要なら店員操作で QR に戻すか、もう一度 tap を提示してください。",
    };
  }

  return {
    code: "waiting_customer",
    label: "受付待ち",
    headline: "tap セッションの準備中です",
    body: "顧客案内は店頭端末側の表示を優先してください。",
  };
}

function buildCustomerPaymentMode(invoice, providerSummary = null) {
  if (!providerSummary || providerSummary.qr_available !== false) {
    return {
      mode: "wallet_qr",
      wallet_enabled: true,
      title: "ウォレットで支払う",
      body: "QR から開いた会計です。ウォレットで送金してください。",
    };
  }

  const operatorCode = String(providerSummary.operator_state?.code || "");
  if (operatorCode === "fulfillment_ok") {
    return {
      mode: "tap_processing",
      wallet_enabled: false,
      title: "お支払いを確認中です",
      body: "店頭端末の案内に従って、そのままお待ちください。",
    };
  }
  if (operatorCode === "retry_required") {
    return {
      mode: "tap_retry",
      wallet_enabled: false,
      title: "店頭端末で再案内します",
      body: "別のカード・スマホをお試しいただくか、スタッフの案内をお待ちください。",
    };
  }
  if (operatorCode === "needs_review") {
    return {
      mode: "tap_review",
      wallet_enabled: false,
      title: "店舗スタッフへお声がけください",
      body: "このお支払いは店舗側で確認が必要です。",
    };
  }
  return {
    mode: "tap_only",
    wallet_enabled: false,
    title: "カード・スマホをかざしてください",
    body: "この会計は店頭端末でご案内します。ウォレット送金へは切り替えず、スタッフの案内に従ってください。",
  };
}

function buildProviderSummary(invoice) {
  const bundle = getLatestProviderRailSessionBundle(invoice);
  if (!bundle?.paymentSession) {
    return {
      available: false,
      qr_available: true,
      can_present: String(invoice?.status || "") === "issued",
      can_cancel_presentation: false,
      requires_explicit_qr_resume: false,
      customer_payment_mode: buildCustomerPaymentMode(invoice, null),
    };
  }

  const { paymentSession, providerSession, providerAllocation } = bundle;
  const operatorState = buildProviderOperatorState({ invoice, paymentSession, providerSession, providerAllocation });
  const paymentStatus = String(paymentSession.status || "");
  const providerStatus = String(providerSession?.provider_status || "");
  const fulfillmentDecision = String(paymentSession.fulfillment_decision || FULFILLMENT_DECISIONS.NONE);
  const qrSuppressed = !(paymentStatus === PAYMENT_SESSION_STATUSES.CANCELLED && fulfillmentDecision === FULFILLMENT_DECISIONS.NONE);
  const canCancelPresentation =
    qrSuppressed
    && fulfillmentDecision !== FULFILLMENT_DECISIONS.ALLOW_FULFILLMENT
    && !["authorized", "captured", "settlement_pending", "settled"].includes(providerStatus);
  const canPresent =
    String(invoice?.status || "") === "issued"
    && (
      paymentStatus === PAYMENT_SESSION_STATUSES.CANCELLED
      || paymentStatus === PAYMENT_SESSION_STATUSES.FAILED
      || providerStatus === "failed"
      || providerStatus === "voided"
    );

  const customerPaymentMode = buildCustomerPaymentMode(invoice, {
    qr_available: !qrSuppressed,
    operator_state: operatorState,
  });

  return {
    available: true,
    payment_session_id: paymentSession.id,
    payment_session_status: paymentSession.status,
    fulfillment_decision: paymentSession.fulfillment_decision,
    provider_code: paymentSession.provider_code || providerSession?.provider_code || null,
    provider_session_id: providerSession?.provider_session_id || null,
    provider_payment_id: providerSession?.provider_payment_id || null,
    provider_status: providerSession?.provider_status || null,
    provider_amount_jpyc_base: providerSession?.provider_amount_jpyc_base ?? null,
    provider_authorized_at: providerSession?.provider_authorized_at || null,
    provider_captured_at: providerSession?.provider_captured_at || null,
    provider_voided_at: providerSession?.provider_voided_at || null,
    provider_cancelled_at: providerSession?.provider_cancelled_at || null,
    provider_settlement_ref: providerAllocation?.external_provider_settlement_id || providerAllocation?.batch_reference || null,
    allocation_status: providerAllocation?.allocation_status || null,
    qr_available: !qrSuppressed,
    qr_suppressed_reason: qrSuppressed ? "provider_tap_active" : null,
    can_present: canPresent,
    can_cancel_presentation: canCancelPresentation,
    requires_explicit_qr_resume: qrSuppressed,
    operator_state: operatorState,
    customer_payment_mode: customerPaymentMode,
  };
}

function findProviderPaymentSessionRecord({ paymentSessionId = null, providerCode, providerPaymentId = null, providerSessionId = null }) {
  if (providerPaymentId) {
    const found = db
      .prepare(`SELECT * FROM provider_payment_sessions WHERE provider_code = ? AND provider_payment_id = ?`)
      .get(providerCode, providerPaymentId);
    if (found) return found;
  }
  if (providerSessionId) {
    const found = db
      .prepare(`SELECT * FROM provider_payment_sessions WHERE provider_code = ? AND provider_session_id = ?`)
      .get(providerCode, providerSessionId);
    if (found) return found;
  }
  if (paymentSessionId) {
    const found = db
      .prepare(`SELECT * FROM provider_payment_sessions WHERE payment_session_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(paymentSessionId);
    if (found) return found;
  }
  return null;
}

function ensureProviderPaymentSession({
  invoice,
  providerCode,
  providerTerminalId = null,
  providerSessionId = null,
  providerPaymentId = null,
  providerStatus = "initialized",
  providerAmountBase = null,
  payloadHash = null,
  occurredAt = null,
}) {
  let providerSession = findProviderPaymentSessionRecord({
    providerCode,
    providerPaymentId,
    providerSessionId,
  });
  let paymentSession = null;
  const ts = nowIso();
  if (providerSession) {
    paymentSession = db.prepare(`SELECT * FROM payment_sessions WHERE id = ?`).get(providerSession.payment_session_id);
  }
  if (!paymentSession) {
    paymentSession = db
      .prepare(
        `SELECT *
         FROM payment_sessions
         WHERE invoice_id = ? AND rail_type = ? AND provider_code = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(invoice.id, PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL, providerCode);
  }
  if (!paymentSession) {
    paymentSession = createPaymentSession({
      invoiceId: invoice.id,
      railType: PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL,
      providerCode,
      status: PAYMENT_SESSION_STATUSES.CREATED,
      createdAt: occurredAt || ts,
    });
  }
  if (!providerSession) {
    const id = uuid();
    db.prepare(
      `INSERT INTO provider_payment_sessions
       (id, payment_session_id, provider_code, provider_terminal_id, provider_session_id, provider_payment_id,
        provider_status, provider_amount_jpyc_base, provider_created_at, provider_payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      paymentSession.id,
      providerCode,
      providerTerminalId || null,
      providerSessionId || null,
      providerPaymentId || null,
      providerStatus,
      providerAmountBase != null ? toIntegerAmount(providerAmountBase, null) : null,
      occurredAt || null,
      payloadHash || null,
      ts,
      ts
    );
    providerSession = db.prepare(`SELECT * FROM provider_payment_sessions WHERE id = ?`).get(id);
  }
  if (String(paymentSession.invoice_id) !== String(invoice.id)) {
    return { error: { code: "PROVIDER_SESSION_INVOICE_MISMATCH", message: "provider session is bound to another invoice" } };
  }
  return { paymentSession, providerSession };
}

function updatePaymentSessionState(paymentSessionId, status, fulfillmentDecision = null) {
  const ts = nowIso();
  db.prepare(
    `UPDATE payment_sessions
     SET status = ?, fulfillment_decision = COALESCE(?, fulfillment_decision), updated_at = ?
     WHERE id = ?`
  ).run(status, fulfillmentDecision, ts, paymentSessionId);
  return db.prepare(`SELECT * FROM payment_sessions WHERE id = ?`).get(paymentSessionId);
}

function updateProviderPaymentSessionState(providerSessionId, patch = {}) {
  const current = db.prepare(`SELECT * FROM provider_payment_sessions WHERE id = ?`).get(providerSessionId);
  if (!current) return null;
  const ts = nowIso();
  const next = {
    provider_terminal_id: patch.providerTerminalId ?? current.provider_terminal_id,
    provider_session_id: patch.providerSessionId ?? current.provider_session_id,
    provider_payment_id: patch.providerPaymentId ?? current.provider_payment_id,
    provider_status: patch.providerStatus ?? current.provider_status,
    provider_amount_jpyc_base: patch.providerAmountBase != null ? toIntegerAmount(patch.providerAmountBase, 0) : current.provider_amount_jpyc_base,
    provider_currency: patch.providerCurrency ?? current.provider_currency,
    provider_created_at: patch.providerCreatedAt ?? current.provider_created_at,
    provider_authorized_at: patch.providerAuthorizedAt ?? current.provider_authorized_at,
    provider_captured_at: patch.providerCapturedAt ?? current.provider_captured_at,
    provider_cancelled_at: patch.providerCancelledAt ?? current.provider_cancelled_at,
    provider_voided_at: patch.providerVoidedAt ?? current.provider_voided_at,
    provider_payload_hash: patch.payloadHash ?? current.provider_payload_hash,
  };
  db.prepare(
    `UPDATE provider_payment_sessions
     SET provider_terminal_id = ?, provider_session_id = ?, provider_payment_id = ?, provider_status = ?,
         provider_amount_jpyc_base = ?, provider_currency = ?, provider_created_at = ?, provider_authorized_at = ?,
         provider_captured_at = ?, provider_cancelled_at = ?, provider_voided_at = ?, provider_payload_hash = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    next.provider_terminal_id,
    next.provider_session_id,
    next.provider_payment_id,
    next.provider_status,
    next.provider_amount_jpyc_base,
    next.provider_currency,
    next.provider_created_at,
    next.provider_authorized_at,
    next.provider_captured_at,
    next.provider_cancelled_at,
    next.provider_voided_at,
    next.provider_payload_hash,
    ts,
    providerSessionId
  );
  return db.prepare(`SELECT * FROM provider_payment_sessions WHERE id = ?`).get(providerSessionId);
}

function createProviderPresentedSession({
  invoice,
  providerCode,
  providerTerminalId = null,
  actorType = "system",
  actorId = "system",
  requestId = null,
  idempotencyKey = null,
  ip = null,
}) {
  const ts = nowIso();
  const paymentSession = createPaymentSession({
    invoiceId: invoice.id,
    railType: PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL,
    providerCode,
    status: PAYMENT_SESSION_STATUSES.PRESENTED,
    fulfillmentDecision: FULFILLMENT_DECISIONS.NONE,
    createdAt: ts,
  });
  const providerSessionId = uuid();
  db.prepare(
    `INSERT INTO provider_payment_sessions
     (id, payment_session_id, provider_code, provider_terminal_id, provider_status, provider_amount_jpyc_base,
      provider_created_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'initialized', ?, ?, ?, ?)`
  ).run(
    providerSessionId,
    paymentSession.id,
    providerCode,
    providerTerminalId || null,
    toIntegerAmount(invoice.amount_jpyc_base, 0),
    ts,
    ts,
    ts
  );
  const providerSession = db.prepare(`SELECT * FROM provider_payment_sessions WHERE id = ?`).get(providerSessionId);
  audit({
    actorType,
    actorId,
    action: "provider_presentation.started",
    targetType: "invoice",
    targetId: invoice.id,
    requestId,
    idempotencyKey,
    afterState: {
      invoice_id: invoice.id,
      payment_session_id: paymentSession.id,
      provider_code: providerCode,
      payment_session_status: paymentSession.status,
      provider_status: providerSession.provider_status,
    },
    ip,
  });
  return { paymentSession, providerSession };
}

function cancelProviderPresentation({
  invoice,
  actorType = "system",
  actorId = "system",
  requestId = null,
  idempotencyKey = null,
  ip = null,
}) {
  const bundle = getLatestProviderRailSessionBundle(invoice);
  if (!bundle?.paymentSession) {
    return { error: { code: "PROVIDER_PRESENTATION_NOT_FOUND", message: "provider presentation not found for this invoice" } };
  }
  const summary = buildProviderSummary(invoice);
  if (summary.qr_available !== false) {
    return { paymentSession: bundle.paymentSession, providerSession: bundle.providerSession };
  }
  if (!summary.can_cancel_presentation) {
    return {
      error: {
        code: "PROVIDER_PRESENTATION_CANNOT_RESUME_QR",
        message: "provider presentation cannot resume QR from current state",
        details: {
          payment_session_status: bundle.paymentSession.status,
          provider_status: bundle.providerSession?.provider_status || null,
          fulfillment_decision: bundle.paymentSession.fulfillment_decision,
        },
      },
    };
  }
  const previousPaymentSession = bundle.paymentSession;
  const nextPaymentSession = updatePaymentSessionState(
    bundle.paymentSession.id,
    PAYMENT_SESSION_STATUSES.CANCELLED,
    FULFILLMENT_DECISIONS.NONE
  );
  audit({
    actorType,
    actorId,
    action: "provider_presentation.cancelled",
    targetType: "invoice",
    targetId: invoice.id,
    requestId,
    idempotencyKey,
    beforeState: {
      payment_session_id: previousPaymentSession.id,
      payment_session_status: previousPaymentSession.status,
      provider_status: bundle.providerSession?.provider_status || null,
    },
    afterState: {
      payment_session_id: nextPaymentSession.id,
      payment_session_status: nextPaymentSession.status,
      provider_status: bundle.providerSession?.provider_status || null,
    },
    ip,
  });
  return { paymentSession: nextPaymentSession, providerSession: bundle.providerSession };
}

function createReconciliationLink({
  invoiceId = null,
  providerPaymentId = null,
  providerSettlementId = null,
  blockchainTransferId = null,
  linkType,
  amountBase = null,
  confidenceLevel = "provider_reported",
}) {
  db.prepare(
    `INSERT INTO payment_reconciliation_links
     (id, invoice_id, provider_payment_id, provider_settlement_id, blockchain_transfer_id, link_type, amount_jpyc_base, confidence_level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    invoiceId,
    providerPaymentId,
    providerSettlementId,
    blockchainTransferId,
    linkType,
    amountBase != null ? toIntegerAmount(amountBase, 0) : null,
    confidenceLevel,
    nowIso()
  );
}

function hashProviderEvidence(payload) {
  return sha256(JSON.stringify(payload || {}));
}

function assertNoPrivateProviderFields(payload) {
  const fieldPath = findPrivateProviderField(payload || {});
  if (fieldPath) {
    return { error: { code: "PRIVATE_PROVIDER_FIELD_NOT_ALLOWED", message: "private provider field is not allowed", details: { field: fieldPath } } };
  }
  return { ok: true };
}

function parseProviderMockEventPayload(payload) {
  const privacy = assertNoPrivateProviderFields(payload);
  if (privacy.error) return privacy;
  const picked = pickAllowedFields(payload || {}, PROVIDER_EVENT_ALLOWED_FIELDS);
  const providerCode = String(picked.provider_code || PROVIDER_CODES.MOCK_PROVIDER).trim() || PROVIDER_CODES.MOCK_PROVIDER;
  const providerEventId = String(picked.provider_event_id || "").trim();
  const invoiceId = String(picked.invoice_id || "").trim();
  const eventType = String(picked.event_type || "").trim().toLowerCase();
  const defaultProviderStatus = eventType === "session_created"
    ? "initialized"
    : (eventType === "settlement_reported" ? "settlement_pending" : eventType);
  const providerStatus = String(picked.provider_status || defaultProviderStatus || "").trim().toLowerCase();
  if (!providerEventId) {
    return { error: { code: "VALIDATION_ERROR", message: "provider_event_id is required" } };
  }
  if (!invoiceId) {
    return { error: { code: "VALIDATION_ERROR", message: "invoice_id is required" } };
  }
  if (!PROVIDER_EVENT_TYPES.includes(eventType)) {
    return { error: { code: "VALIDATION_ERROR", message: "unsupported provider event_type" } };
  }
  if (providerStatus && !PROVIDER_PAYMENT_SESSION_STATUSES.includes(providerStatus) && eventType !== "session_created" && eventType !== "settlement_reported") {
    return { error: { code: "VALIDATION_ERROR", message: "unsupported provider_status" } };
  }
  const occurredAt = String(picked.occurred_at || nowIso());
  if (!Number.isFinite(new Date(occurredAt).getTime())) {
    return { error: { code: "VALIDATION_ERROR", message: "occurred_at must be valid ISO timestamp" } };
  }
  let amountBase = null;
  if (picked.amount_jpyc_base != null) {
    const parsedAmount = parsePositiveBaseUnitInteger(picked.amount_jpyc_base, "amount_jpyc_base");
    if (parsedAmount.error) return { error: { code: "VALIDATION_ERROR", message: parsedAmount.error } };
    amountBase = parsedAmount.value;
  }
  const txHash = picked.tx_hash ? parseTxHash(picked.tx_hash) : null;
  if (picked.tx_hash && !txHash) {
    return { error: { code: "VALIDATION_ERROR", message: "tx_hash must be a 0x-prefixed 32-byte hash" } };
  }
  const sanitized = {
    provider_code: providerCode,
    provider_event_id: providerEventId,
    provider_session_id: picked.provider_session_id ? String(picked.provider_session_id) : null,
    provider_payment_id: picked.provider_payment_id ? String(picked.provider_payment_id) : null,
    invoice_id: invoiceId,
    terminal_id: picked.terminal_id ? String(picked.terminal_id) : null,
    event_type: eventType,
    provider_status: providerStatus || null,
    amount_jpyc_base: amountBase,
    occurred_at: occurredAt,
    tx_hash: txHash,
    provider_settlement_id: picked.provider_settlement_id ? String(picked.provider_settlement_id) : null,
    batch_reference: picked.batch_reference ? String(picked.batch_reference) : null,
  };
  return { event: sanitized, payloadHash: hashProviderEvidence(sanitized) };
}

function parseProviderMockSettlementPayload(payload) {
  const privacy = assertNoPrivateProviderFields(payload);
  if (privacy.error) return privacy;
  const picked = pickAllowedFields(payload || {}, PROVIDER_SETTLEMENT_ALLOWED_FIELDS);
  const providerCode = String(picked.provider_code || PROVIDER_CODES.MOCK_PROVIDER).trim() || PROVIDER_CODES.MOCK_PROVIDER;
  const externalSettlementId = String(picked.provider_settlement_id || "").trim();
  if (!externalSettlementId) {
    return { error: { code: "VALIDATION_ERROR", message: "provider_settlement_id is required" } };
  }
  const status = String(picked.settlement_status || "reported").trim().toLowerCase();
  if (!PROVIDER_SETTLEMENT_STATUSES.includes(status)) {
    return { error: { code: "VALIDATION_ERROR", message: "unsupported settlement_status" } };
  }
  const parsedAmount = parsePositiveBaseUnitInteger(picked.settlement_amount_jpyc_base, "settlement_amount_jpyc_base");
  if (parsedAmount.error) return { error: { code: "VALIDATION_ERROR", message: parsedAmount.error } };
  const allocations = Array.isArray(picked.allocations) ? picked.allocations : [];
  const normalizedAllocations = [];
  for (const rawAllocation of allocations) {
    const privateField = findPrivateProviderField(rawAllocation || {});
    if (privateField) {
      return { error: { code: "PRIVATE_PROVIDER_FIELD_NOT_ALLOWED", message: "private provider field is not allowed", details: { field: privateField } } };
    }
    const allocation = pickAllowedFields(rawAllocation || {}, PROVIDER_SETTLEMENT_ALLOCATION_ALLOWED_FIELDS);
    const providerPaymentId = String(allocation.provider_payment_id || "").trim();
    if (!providerPaymentId) {
      return { error: { code: "VALIDATION_ERROR", message: "allocation.provider_payment_id is required" } };
    }
    const parsedAllocationAmount = parsePositiveBaseUnitInteger(
      allocation.allocated_amount_jpyc_base,
      "allocation.allocated_amount_jpyc_base"
    );
    if (parsedAllocationAmount.error) {
      return { error: { code: "VALIDATION_ERROR", message: parsedAllocationAmount.error } };
    }
    const allocationStatus = String(allocation.allocation_status || "reported").trim().toLowerCase();
    if (!PROVIDER_ALLOCATION_STATUSES.includes(allocationStatus)) {
      return { error: { code: "VALIDATION_ERROR", message: "unsupported allocation_status" } };
    }
    normalizedAllocations.push({
      provider_payment_id: providerPaymentId,
      invoice_id: allocation.invoice_id ? String(allocation.invoice_id) : null,
      allocated_amount_jpyc_base: parsedAllocationAmount.value,
      allocation_status: allocationStatus,
    });
  }
  const txHash = picked.tx_hash ? parseTxHash(picked.tx_hash) : null;
  if (picked.tx_hash && !txHash) {
    return { error: { code: "VALIDATION_ERROR", message: "tx_hash must be a 0x-prefixed 32-byte hash" } };
  }
  const sanitized = {
    provider_code: providerCode,
    provider_settlement_id: externalSettlementId,
    batch_reference: picked.batch_reference ? String(picked.batch_reference) : null,
    settlement_status: status,
    settlement_amount_jpyc_base: parsedAmount.value,
    settlement_currency: String(picked.settlement_currency || "JPYC"),
    reported_at: picked.reported_at ? String(picked.reported_at) : nowIso(),
    settled_at: picked.settled_at ? String(picked.settled_at) : null,
    tx_hash: txHash,
    allocations: normalizedAllocations,
  };
  return { settlement: sanitized, payloadHash: hashProviderEvidence(sanitized) };
}

function getAppConfig(key) {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(String(key));
  return row ? String(row.value) : null;
}

function setAppConfig(key, value, updatedBy) {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO app_config(key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).run(String(key), String(value), updatedBy || null, ts);
}

function isPaymentsDisabled() {
  if (PAYMENTS_DISABLED_ENV) return true;
  const value = getAppConfig("payments.disabled");
  return value === "true";
}

function paymentDisableConfigKey(scope, id = null) {
  if (scope === "global") return "payments.disabled";
  return `payments.disabled.${scope}.${String(id || "")}`;
}

function isScopedPaymentsDisabled(scope, id) {
  if (!id) return false;
  const value = getAppConfig(paymentDisableConfigKey(scope, id));
  return value === "true";
}

function getPaymentsDisableState({ storeId = null, terminalId = null } = {}) {
  const envForced = PAYMENTS_DISABLED_ENV;
  const globalDisabled = isPaymentsDisabled();
  const storeDisabled = isScopedPaymentsDisabled("store", storeId);
  const terminalDisabled = isScopedPaymentsDisabled("terminal", terminalId);
  return {
    env_forced: envForced,
    global_disabled: globalDisabled,
    store_disabled: storeDisabled,
    terminal_disabled: terminalDisabled,
    disabled: envForced || globalDisabled || storeDisabled || terminalDisabled,
  };
}

function getInvoiceIssuanceBlockReason({ store, session }) {
  if (!store) {
    return {
      code: "NOT_FOUND",
      message: "Store not found",
      details: {},
    };
  }
  const state = getPaymentsDisableState({ storeId: session?.store_id, terminalId: session?.terminal_id });
  if (state.disabled) {
    return {
      code: "PAYMENTS_DISABLED",
      message: "Payments are temporarily disabled",
      details: state,
    };
  }
  if (String(store.status || "active") !== "active") {
    return {
      code: "STORE_PAYMENTS_DISABLED",
      message: "Store is temporarily disabled for new invoices",
      details: { store_id: store.id, store_status: store.status },
    };
  }
  const terminal = session?.terminal_id
    ? db.prepare(`SELECT * FROM terminals WHERE id = ? AND store_id = ?`).get(session.terminal_id, session.store_id)
    : null;
  if (!terminal) {
    return {
      code: "TERMINAL_NOT_FOUND",
      message: "Terminal not found",
      details: { terminal_id: session?.terminal_id || null },
    };
  }
  if (String(terminal.status || "active") !== "active") {
    return {
      code: "TERMINAL_PAYMENTS_DISABLED",
      message: "Terminal is temporarily disabled for new invoices",
      details: { terminal_id: terminal.id, terminal_status: terminal.status },
    };
  }
  return null;
}

function normalizeSettlementUnresolvedReviewPolicy(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["block", "warn", "allow"].includes(raw)) return raw;
  return null;
}

function resolveSettlementUnresolvedReviewPolicy(store = null) {
  const storePolicy = normalizeSettlementUnresolvedReviewPolicy(store?.settlement_unresolved_review_policy);
  if (storePolicy) return storePolicy;
  const envPolicy = normalizeSettlementUnresolvedReviewPolicy(SETTLEMENT_UNRESOLVED_REVIEW_POLICY);
  if (envPolicy) return envPolicy;
  if (IS_PRODUCTION || SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS) return "block";
  return "warn";
}

function parseEvidenceStatus(rawStatus) {
  const raw = String(rawStatus || "").trim().toLowerCase();
  if (!raw) return "missing";
  if (["pass", "approved", "signed", "ok"].includes(raw)) return "pass";
  if (["fail", "failed", "no"].includes(raw)) return "fail";
  if (["pending", "todo", "tbd", "in_progress"].includes(raw)) return "pending";
  return raw;
}

function extractStatusFromMarkdown(content) {
  const raw = String(content || "");
  const direct = raw.match(/^[\\-\\*]?\\s*(?:status|判定)\\s*:\\s*([^\\n\\r]+)/im);
  if (direct) return parseEvidenceStatus(direct[1]);
  return "missing";
}

function extractMarkdownKeyValues(content) {
  const map = {};
  for (const line of String(content || "").split(/\\r?\\n/)) {
    const matched = line.match(/^[\\-\\*]?\\s*([A-Za-z0-9_\\-\\s\\.]+)\\s*:\\s*(.*)$/);
    if (!matched) continue;
    const key = String(matched[1]).trim().toLowerCase().replace(/[\\s\\.\\-]+/g, "_");
    map[key] = String(matched[2] || "").trim();
  }
  return map;
}

function resolveEvidenceFilePath(dirPath, candidates) {
  for (const fileName of candidates) {
    const fullPath = path.join(dirPath, fileName);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function listEvidenceDirectories(rootDir) {
  try {
    if (!fs.existsSync(rootDir)) return [];
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        fullPath: path.join(rootDir, entry.name),
      }))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch (_error) {
    return [];
  }
}

function detectLatestEvidenceDirectory(rootDir = COMMERCIAL_EVIDENCE_ROOT) {
  const dirs = listEvidenceDirectories(rootDir);
  const timestampDirs = dirs.filter((entry) => /^\d{8}T\d{6}Z$/.test(entry.name));
  const candidates = timestampDirs.length > 0 ? timestampDirs : dirs.filter((entry) => String(entry.name || "").toLowerCase() !== "templates");
  for (const entry of candidates) {
    const maybeExt = [
      "EXT-001-real-jpyc-payment.md",
      "EXT-002-wallet-device-launch.md",
      "EXT-002-hashport-device-launch.md",
      "EXT-003-public-fqdn-tls.md",
      "EXT-004-store-ops-drill.md",
    ];
    if (maybeExt.some((fileName) => fs.existsSync(path.join(entry.fullPath, fileName)))) {
      return entry;
    }
  }
  return candidates[0] || null;
}

function evaluateExternalEvidenceGates() {
  const latest = detectLatestEvidenceDirectory();
  if (!latest) {
    return {
      latest_dir: null,
      wallet_evidence_gate: { ok: false, status: "missing", file: null },
      real_payment_evidence_gate: { ok: false, status: "missing", file: null },
      tls_evidence_gate: { ok: false, status: "missing", file: null },
      store_ops_drill_gate: { ok: false, status: "missing", file: null },
    };
  }

  function evaluateOne(candidates) {
    const file = resolveEvidenceFilePath(latest.fullPath, candidates);
    if (!file) return { ok: false, status: "missing", file: null };
    const content = fs.readFileSync(file, "utf8");
    const status = extractStatusFromMarkdown(content);
    const kv = extractMarkdownKeyValues(content);
    return {
      ok: status === "pass",
      status,
      file,
      fields: kv,
    };
  }

  const realPayment = evaluateOne(["EXT-001-real-jpyc-payment.md"]);
  const wallet = evaluateOne(["EXT-002-wallet-device-launch.md", "EXT-002-hashport-device-launch.md"]);
  const tls = evaluateOne(["EXT-003-public-fqdn-tls.md"]);
  const storeOps = evaluateOne(["EXT-004-store-ops-drill.md"]);

  if (wallet.ok) {
    const ios = parseEvidenceStatus(wallet.fields?.hashport_wallet_ios_status || wallet.fields?.hashport_ios_status || "");
    const android = parseEvidenceStatus(wallet.fields?.hashport_wallet_android_status || wallet.fields?.hashport_android_status || "");
    const copyFallback = parseEvidenceStatus(wallet.fields?.copy_fallback_status || "");
    if ((ios && ios !== "pass") || (android && android !== "pass") || (copyFallback && copyFallback !== "pass")) {
      wallet.ok = false;
      wallet.status = "fail";
    }
  }

  return {
    latest_dir: latest.fullPath,
    wallet_evidence_gate: wallet,
    real_payment_evidence_gate: realPayment,
    tls_evidence_gate: tls,
    store_ops_drill_gate: storeOps,
  };
}

function evaluateDangerousFlagsGate() {
  const blockers = [];
  if (ENABLE_PUBLIC_PAYMENT_SIMULATION) blockers.push("ENABLE_PUBLIC_PAYMENT_SIMULATION must be false");
  if (DEMO_CONTROLS_ENABLED) blockers.push("DEMO_CONTROLS_ENABLED must be false");
  if (DIAGNOSTIC_MODE_ENABLED && isPlaceholderLike(DIAGNOSTIC_MODE_APPROVAL_REF)) {
    blockers.push("DIAGNOSTIC_MODE_ENABLED requires DIAGNOSTIC_MODE_APPROVAL_REF");
  }
  if (ALLOW_MANUAL_PAYMENT_INGEST && isPlaceholderLike(MANUAL_INGEST_APPROVAL_REF)) {
    blockers.push("ALLOW_MANUAL_PAYMENT_INGEST requires MANUAL_INGEST_APPROVAL_REF");
  }
  if (String(ENV.WALLET_ADAPTER_TYPE || "mock").toLowerCase() === "mock") blockers.push("WALLET_ADAPTER_TYPE=mock is not allowed");
  if (INSECURE_SECRETS.has(APP_SECRET) || APP_SECRET.length < 32) blockers.push("APP_SECRET is weak");
  if (INSECURE_SECRETS.has(SERVICE_INGEST_SECRET) || SERVICE_INGEST_SECRET.length < 32) blockers.push("SERVICE_INGEST_SECRET is weak");
  if (INSECURE_SECRETS.has(METRICS_SECRET) || METRICS_SECRET.length < 32) blockers.push("METRICS_SECRET is weak");
  if (CORS_ALLOW_ORIGINS.some((origin) => origin === "*" || origin.includes("*"))) blockers.push("CORS_ALLOW_ORIGINS wildcard is not allowed");
  if (!TRUST_PROXY) blockers.push("TRUST_PROXY must be true");
  if (!Number.isFinite(SESSION_TTL_SEC) || SESSION_TTL_SEC <= 0) blockers.push("SESSION_TTL_SEC must be positive");
  if (!Number.isFinite(SSE_TOKEN_MAX_TTL_SEC) || SSE_TOKEN_MAX_TTL_SEC < 60 || SSE_TOKEN_MAX_TTL_SEC > 900) {
    blockers.push("SSE_TOKEN_MAX_TTL_SEC must be between 60 and 900");
  }
  if (!Number.isFinite(PIN_LOCKOUT_MAX_ATTEMPTS) || PIN_LOCKOUT_MAX_ATTEMPTS < 1) blockers.push("PIN_LOCKOUT_MAX_ATTEMPTS must be >= 1");
  if (!Number.isFinite(PIN_LOCKOUT_SEC) || PIN_LOCKOUT_SEC < 1) blockers.push("PIN_LOCKOUT_SEC must be >= 1");
  if (!Number.isFinite(SERVICE_REPLAY_GUARD_TTL_SEC) || SERVICE_REPLAY_GUARD_TTL_SEC <= 0) blockers.push("SERVICE_REPLAY_GUARD_TTL_SEC must be enabled");
  if (!Number.isFinite(IDEMPOTENCY_TTL_SEC) || IDEMPOTENCY_TTL_SEC <= 0) blockers.push("IDEMPOTENCY_TTL_SEC must be enabled");
  if (!Number.isFinite(PUBLIC_RATE_LIMIT_MAX) || PUBLIC_RATE_LIMIT_MAX <= 0) blockers.push("PUBLIC_RATE_LIMIT_MAX must be enabled");
  if (!Number.isFinite(LOGIN_RATE_LIMIT_MAX) || LOGIN_RATE_LIMIT_MAX <= 0) blockers.push("LOGIN_RATE_LIMIT_MAX must be enabled");
  return { ok: blockers.length === 0, blockers };
}

function evaluateCommercialRuntimeGate(metrics = null) {
  const runtimeMetrics = metrics || collectRuntimeMetrics();
  const externalEvidence = evaluateExternalEvidenceGates();
  const dangerousFlagsGate = evaluateDangerousFlagsGate();
  const settlementPolicy = resolveSettlementUnresolvedReviewPolicy(null);
  const auditChainOk = Boolean(runtimeMetrics.audit_chain?.ok);

  const gates = {
    app_env: APP_ENV,
    payments_disabled: isPaymentsDisabled(),
    commercial_go_mode: COMMERCIAL_GO_MODE,
    legal_gate: LEGAL_GATE_APPROVED && !isPlaceholderLike(LEGAL_GATE_APPROVAL_REF),
    aml_gate: AML_POLICY_APPROVED && !isPlaceholderLike(AML_POLICY_APPROVAL_REF),
    privacy_gate: PRIVACY_POLICY_APPROVED && !isPlaceholderLike(PRIVACY_POLICY_APPROVAL_REF),
    appi_gate: APPI_POLICY_APPROVED && !isPlaceholderLike(APPI_POLICY_APPROVAL_REF),
    jpyc_contract_gate:
      !isPlaceholderLike(JPYC_CONTRACT_APPROVAL_REF)
	      && CHAIN_ID === "137"
	      && !!APPROVED_JPYC_TOKEN_CONTRACT
	      && String(TOKEN_CONTRACT).toLowerCase() === APPROVED_JPYC_TOKEN_CONTRACT
	      && Number.isFinite(TOKEN_DECIMALS)
	      && Number.isFinite(JPYC_SCALE_DECIMALS),
    confirmation_policy_gate:
      !isPlaceholderLike(CONFIRMATIONS_POLICY_APPROVAL_REF)
      && REQUIRED_CONFIRMATIONS >= MIN_REQUIRED_CONFIRMATIONS,
    backscan_policy_gate: !isPlaceholderLike(BACKSCAN_POLICY_APPROVAL_REF) && MONITOR_BACKSCAN_BLOCKS >= MIN_MONITOR_BACKSCAN_BLOCKS,
    wallet_evidence_gate: externalEvidence.wallet_evidence_gate.ok,
    real_payment_evidence_gate: externalEvidence.real_payment_evidence_gate.ok,
    tls_evidence_gate: externalEvidence.tls_evidence_gate.ok,
    store_ops_drill_gate: externalEvidence.store_ops_drill_gate.ok,
    audit_chain_gate: auditChainOk,
    settlement_policy_gate: settlementPolicy === "block",
    refund_policy_gate: REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR,
    dangerous_flags_gate: dangerousFlagsGate.ok,
  };

  const blockers = [];
  if (!gates.legal_gate) blockers.push("legal_gate");
  if (!gates.aml_gate) blockers.push("aml_gate");
  if (!gates.privacy_gate) blockers.push("privacy_gate");
  if (!gates.appi_gate) blockers.push("appi_gate");
  if (!gates.jpyc_contract_gate) blockers.push("jpyc_contract_gate");
  if (!gates.confirmation_policy_gate) blockers.push("confirmation_policy_gate");
  if (!gates.backscan_policy_gate) blockers.push("backscan_policy_gate");
  if (!gates.audit_chain_gate) blockers.push("audit_chain_gate");
  if (!gates.settlement_policy_gate) blockers.push("settlement_policy_gate");
  if (!gates.refund_policy_gate) blockers.push("refund_policy_gate");
  if (!gates.dangerous_flags_gate) blockers.push("dangerous_flags_gate");
  if (gates.commercial_go_mode) {
    if (!gates.wallet_evidence_gate) blockers.push("wallet_evidence_gate");
    if (!gates.real_payment_evidence_gate) blockers.push("real_payment_evidence_gate");
    if (!gates.tls_evidence_gate) blockers.push("tls_evidence_gate");
    if (!gates.store_ops_drill_gate) blockers.push("store_ops_drill_gate");
  }

  let commercialVerdict = "LIMITED_PILOT_MODE";
  if (gates.commercial_go_mode) {
    commercialVerdict = blockers.length === 0 ? "COMMERCIAL_GO" : "CONDITIONAL_NO_GO_FOR_COMMERCIAL";
  } else if (blockers.length === 0) {
    commercialVerdict = "READY_FOR_LIMITED_PILOT";
  } else {
    commercialVerdict = "NO_GO";
  }

  return {
    ...gates,
    settlement_unresolved_review_policy: settlementPolicy,
    commercial_verdict: commercialVerdict,
    blockers: [...new Set(blockers)],
    dangerous_flag_details: dangerousFlagsGate.blockers,
    external_evidence: externalEvidence,
  };
}

function getCommercialGateBlockedError() {
  const gate = evaluateCommercialRuntimeGate();
  if (!gate.commercial_go_mode) return null;
  if (!gate.blockers.length) return null;
  return {
    code: "COMMERCIAL_GATE_BLOCKED",
    message: "commercial go gate is not satisfied",
    details: {
      commercial_verdict: gate.commercial_verdict,
      blockers: gate.blockers,
      payments_disabled: gate.payments_disabled,
      evidence_dir: gate.external_evidence?.latest_dir || null,
    },
  };
}

function buildCorrelationContext(invoice, extra = {}) {
  const normalizedInvoice = invoice || {};
  return {
    invoice_id: normalizedInvoice.id || extra.invoice_id || null,
    checkout_session_id: normalizedInvoice.checkout_session_id || extra.checkout_session_id || null,
    payment_attempt_id: extra.payment_attempt_id || null,
    tx_hash: extra.tx_hash || normalizedInvoice.paid_tx_hash || null,
    log_index: extra.log_index ?? null,
    status: extra.status || normalizedInvoice.status || null,
    status_version: extra.status_version || normalizedInvoice.updated_at || null,
    event_id: extra.event_id || null,
    merchant_id: extra.merchant_id || normalizedInvoice.merchant_id || normalizedInvoice.store_id || null,
    store_id: extra.store_id || normalizedInvoice.store_id || null,
    terminal_id: extra.terminal_id || normalizedInvoice.terminal_id || null,
  };
}

function logCorrelationEvent(type, invoice, extra = {}) {
  console.log(
    JSON.stringify({
      ts: nowIso(),
      level: extra.level || "info",
      type,
      ...buildCorrelationContext(invoice, extra),
      ...(extra.details ? { details: extra.details } : {}),
    })
  );
}

const CHAIN_ID_NUMERIC = Number(CHAIN_ID);
const transferInterface = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const rpcProviders = RPC_URLS.map((rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    return new JsonRpcProvider(
      parsed.toString(),
      Number.isFinite(CHAIN_ID_NUMERIC) ? CHAIN_ID_NUMERIC : undefined,
      { staticNetwork: true }
    );
  } catch (error) {
    console.error(`FATAL: RPC_URLS contains invalid URL "${rawUrl}": ${String(error.message || error)}`);
    process.exit(1);
  }
});

function normalizeAddress(value) {
  if (!isEvmAddress(value)) return null;
  return String(value).trim().toLowerCase();
}

function looksLikePrivateKeyMaterial(value) {
  const normalized = normalizeEnvString(value);
  if (!normalized) return false;
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized) || /^[0-9a-fA-F]{64}$/.test(normalized)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(normalized)) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 12 && words.length <= 24) return true;
  return false;
}

function normalizeReceiveAddressProofScope({ address, proof, policy, sourceLabel }) {
  const batchId = String(proof?.proof_batch_id || proof?.batch_id || "").trim();
  const nonce = String(proof?.proof_nonce || proof?.nonce || "").trim();
  const validFrom = String(proof?.proof_valid_from || proof?.valid_from || "").trim();
  const validUntil = String(proof?.proof_valid_until || proof?.valid_until || "").trim();
  if ([batchId, nonce, validFrom, validUntil].some((value) => !value || isPlaceholderLike(value))) {
    return { error: { code: "INVALID_CONTROL_PROOF", message: "control proof requires batch_id, nonce, valid_from, and valid_until" } };
  }
  const validFromMs = Date.parse(validFrom);
  const validUntilMs = Date.parse(validUntil);
  const nowMs = Date.now();
  if (!Number.isFinite(validFromMs) || !Number.isFinite(validUntilMs) || validFromMs > validUntilMs) {
    return { error: { code: "INVALID_CONTROL_PROOF", message: "control proof validity window is invalid" } };
  }
  if (nowMs < validFromMs || nowMs > validUntilMs) {
    return { error: { code: "INVALID_CONTROL_PROOF", message: "control proof validity window is not current" } };
  }
  const scope = {
    merchant_id: policy.merchantId,
    store_id: policy.storeId,
    batch_id: batchId,
    source_label: sourceLabel || "ops_import",
    address: String(address || "").toLowerCase(),
    network: String(policy.network || ""),
    token_contract: String(policy.tokenContract || "").toLowerCase(),
    valid_from: new Date(validFromMs).toISOString(),
    valid_until: new Date(validUntilMs).toISOString(),
    nonce,
  };
  return {
    scope,
    batchId,
    nonceHash: hashJson({
      merchant_id: scope.merchant_id,
      store_id: scope.store_id,
      batch_id: scope.batch_id,
      nonce,
    }),
    validFrom: scope.valid_from,
    validUntil: scope.valid_until,
    scopeHash: hashJson(scope),
  };
}

function receiveAddressProofMessage(scope) {
  return [
    "JPYC Merchant Ops receive address control",
    `merchant_id:${scope.merchant_id}`,
    `store_id:${scope.store_id}`,
    `batch_id:${scope.batch_id}`,
    `source_label:${scope.source_label}`,
    `address:${scope.address}`,
    `network:${scope.network}`,
    `token_contract:${scope.token_contract}`,
    `valid_from:${scope.valid_from}`,
    `valid_until:${scope.valid_until}`,
    `nonce:${scope.nonce}`,
  ].join("\n");
}

function verifyReceiveAddressControlProof({ address, proof, actorId, policy, sourceLabel }) {
  const type = String(proof?.control_proof_type || proof?.type || "").trim().toLowerCase();
  if (!type) return { status: "pending_verification", proofType: null };
  if (type === "eip191_signature") {
    const proofScope = normalizeReceiveAddressProofScope({ address, proof, policy, sourceLabel });
    if (proofScope.error) return proofScope;
    const reusedNonce = db
      .prepare(`SELECT id FROM receive_addresses WHERE proof_nonce_hash = ? LIMIT 1`)
      .get(proofScope.nonceHash);
    if (reusedNonce) {
      return { error: { code: "INVALID_CONTROL_PROOF", message: "control proof nonce has already been used" } };
    }
    const signature = String(proof?.signature || proof?.control_proof_signature || "").trim();
    if (!signature) return { error: { code: "INVALID_CONTROL_PROOF", message: "EIP-191 proof requires signature" } };
    try {
      const recovered = verifyMessage(
        receiveAddressProofMessage(proofScope.scope),
        signature
      ).toLowerCase();
      if (recovered !== String(address).toLowerCase()) {
        return { error: { code: "INVALID_CONTROL_PROOF", message: "EIP-191 proof signer does not match receive address" } };
      }
      return {
        status: "available",
        proofType: "eip191_signature",
        payloadHash: hashJson({ type, scope_hash: proofScope.scopeHash, signature }),
        verifiedBy: actorId,
        verifiedAt: nowIso(),
        approvalRef: null,
        proofBatchId: proofScope.batchId,
        proofNonceHash: proofScope.nonceHash,
        proofValidFrom: proofScope.validFrom,
        proofValidUntil: proofScope.validUntil,
        proofScopeHash: proofScope.scopeHash,
      };
    } catch (_error) {
      return { error: { code: "INVALID_CONTROL_PROOF", message: "EIP-191 proof signature is invalid" } };
    }
  }
  if (type === "external_approval") {
    const approvalRef = String(proof?.approval_ref || "").trim();
    const auditEvidenceRef = String(proof?.audit_evidence_ref || proof?.evidence_ref || "").trim();
    if (isPlaceholderLike(approvalRef) || isPlaceholderLike(auditEvidenceRef)) {
      return { error: { code: "INVALID_CONTROL_PROOF", message: "external approval proof requires approval_ref and audit_evidence_ref" } };
    }
    return {
      status: "available",
      proofType: "external_approval",
      payloadHash: hashJson({ type, address, approval_ref: approvalRef, audit_evidence_ref: auditEvidenceRef }),
      verifiedBy: actorId,
      verifiedAt: nowIso(),
      approvalRef,
    };
  }
  return { error: { code: "INVALID_CONTROL_PROOF", message: "unsupported receive address control proof type" } };
}

function getReceiveAddressPoolPolicy(storeId) {
  const store = db.prepare(`SELECT merchant_id FROM stores WHERE id = ?`).get(storeId);
  return {
    merchantId: store?.merchant_id || "merchant-001",
    storeId,
    network: CHAIN_ID,
    tokenContract: APPROVED_TOKEN_CONTRACT,
  };
}

function listReceiveAddresses(storeId) {
  const policy = getReceiveAddressPoolPolicy(storeId);
  return db
    .prepare(
      `SELECT *
       FROM receive_addresses
       WHERE store_id = ?
         AND network = ?
         AND lower(token_contract) = lower(?)
       ORDER BY created_at ASC`
    )
    .all(policy.storeId, policy.network, policy.tokenContract);
}

function hasConfiguredReceiveAddressPool(storeId) {
  const policy = getReceiveAddressPoolPolicy(storeId);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM receive_addresses
       WHERE store_id = ?
         AND network = ?
         AND lower(token_contract) = lower(?)
         AND status IN ('available', 'allocated')`
    )
    .get(policy.storeId, policy.network, policy.tokenContract);
  return Number(row?.count || 0) > 0;
}

function allocateReceiveAddress({ storeId, invoiceId }) {
  const policy = getReceiveAddressPoolPolicy(storeId);
  const ts = nowIso();
  const allocate = db.transaction(() => {
    const selected = db
      .prepare(
        `SELECT *
         FROM receive_addresses
         WHERE store_id = ?
           AND network = ?
           AND lower(token_contract) = lower(?)
           AND status = 'available'
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(policy.storeId, policy.network, policy.tokenContract);
    if (!selected) {
      return null;
    }
    const updated = db
      .prepare(
        `UPDATE receive_addresses
         SET status = 'allocated',
             allocated_invoice_id = ?,
             allocated_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'available'`
      )
      .run(invoiceId, ts, ts, selected.id);
    if (updated.changes !== 1) {
      return null;
    }
    return db.prepare(`SELECT * FROM receive_addresses WHERE id = ?`).get(selected.id);
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const allocated = allocate();
    if (allocated) return allocated;
  }
  return null;
}

function importReceiveAddresses({ storeId, actorId, addresses, sourceLabel, requestId, idempotencyKey, ip }) {
  const normalizedEntries = [];
  const seen = new Set();
  for (const entry of addresses) {
	    const raw = typeof entry === "string" ? entry : entry?.address;
	    const source = typeof entry === "object" && entry ? String(entry.source_label || sourceLabel || "").trim() : String(sourceLabel || "").trim();
    if (looksLikePrivateKeyMaterial(raw)) {
      return { error: { code: "PRIVATE_KEY_MATERIAL_REJECTED", message: "private key or mnemonic-like material cannot be imported" } };
    }
    const address = normalizeAddress(raw);
    if (!address) {
      return { error: { code: "VALIDATION_ERROR", message: "receive address import requires valid EVM addresses" } };
    }
    if (seen.has(address)) continue;
    seen.add(address);
	    normalizedEntries.push({ address, sourceLabel: source || "ops_import", proof: typeof entry === "object" && entry ? entry : null });
  }

  if (normalizedEntries.length === 0) {
    return { error: { code: "VALIDATION_ERROR", message: "at least one receive address is required" } };
  }

	const policy = getReceiveAddressPoolPolicy(storeId);
  const imported = [];
  try {
    db.transaction(() => {
	      for (const entry of normalizedEntries) {
	        const id = uuid();
	        const ts = nowIso();
		        const proof = verifyReceiveAddressControlProof({ address: entry.address, proof: entry.proof, actorId, policy, sourceLabel: entry.sourceLabel });
		        if (proof.error) throw new Error(`invalid_control_proof:${proof.error.message}`);
		        try {
		          db.prepare(
		            `INSERT INTO receive_addresses
		             (id, merchant_id, store_id, network, token_contract, address, status, source_label, control_proof_type,
		              control_proof_payload_hash, verified_by, verified_at, approval_ref, proof_batch_id, proof_nonce_hash,
		              proof_valid_from, proof_valid_until, proof_scope_hash, created_at, updated_at)
		             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		          ).run(
		            id,
		            policy.merchantId,
	            policy.storeId,
	            policy.network,
	            policy.tokenContract,
	            entry.address,
	            proof.status,
	            entry.sourceLabel,
	            proof.proofType,
	            proof.payloadHash || null,
		            proof.verifiedBy || null,
		            proof.verifiedAt || null,
		            proof.approvalRef || null,
		            proof.proofBatchId || null,
		            proof.proofNonceHash || null,
		            proof.proofValidFrom || null,
		            proof.proofValidUntil || null,
		            proof.proofScopeHash || null,
		            ts,
		            ts
		          );
          const row = db.prepare(`SELECT * FROM receive_addresses WHERE id = ?`).get(id);
          imported.push(row);
        } catch (error) {
          if (String(error.message || error).includes("UNIQUE")) {
            throw new Error(`duplicate_receive_address:${entry.address}`);
          }
          throw error;
        }
      }
    })();
  } catch (error) {
    const message = String(error.message || error);
	    if (message.startsWith("duplicate_receive_address:")) {
      return {
        error: {
          code: "DUPLICATE_RECEIVE_ADDRESS",
          message: `receive address already imported: ${message.slice("duplicate_receive_address:".length)}`,
        },
      };
	    }
	    if (message.startsWith("invalid_control_proof:")) {
	      return {
	        error: {
	          code: "INVALID_CONTROL_PROOF",
	          message: message.slice("invalid_control_proof:".length),
	        },
	      };
	    }
    throw error;
  }

  audit({
    actorType: "admin",
    actorId,
    action: "receive_address.imported",
    targetType: "receive_address_pool",
    targetId: storeId,
    requestId,
    idempotencyKey,
    afterState: {
      imported_count: imported.length,
      addresses: imported.map((row) => row.address),
      network: policy.network,
      token_contract: policy.tokenContract,
    },
    ip,
  });
  return { rows: imported };
}

function disableReceiveAddress({ storeId, receiveAddressId, actorId, reason, requestId, idempotencyKey, ip }) {
  const row = db
    .prepare(
      `SELECT *
       FROM receive_addresses
       WHERE id = ?
         AND store_id = ?`
    )
    .get(receiveAddressId, storeId);
  if (!row) {
    return { error: { code: "NOT_FOUND", message: "Receive address not found" } };
  }
  if (row.status === "allocated") {
    return { error: { code: "ADDRESS_IN_USE", message: "Allocated receive address cannot be disabled" } };
  }
  const ts = nowIso();
  db.prepare(
    `UPDATE receive_addresses
     SET status = 'disabled',
         disabled_reason = ?,
         retired_at = COALESCE(retired_at, ?),
         updated_at = ?
     WHERE id = ?`
  ).run(reason || "disabled_by_admin", ts, ts, row.id);
  const after = db.prepare(`SELECT * FROM receive_addresses WHERE id = ?`).get(row.id);
  audit({
    actorType: "admin",
    actorId,
    action: "receive_address.disabled",
    targetType: "receive_address",
    targetId: row.id,
    requestId,
    idempotencyKey,
    beforeState: row,
    afterState: after,
    ip,
  });
  return { row: after };
}

async function withRpcProvider(label, fn) {
  if (rpcProviders.length === 0) {
    throw new Error("rpc_unavailable");
  }
  let lastError = null;
  for (const provider of rpcProviders) {
    try {
      return await fn(provider);
    } catch (error) {
      lastError = error;
      console.warn(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "rpc.provider_failed",
          label,
          message: String(error.message || error),
        })
      );
    }
  }
  throw lastError || new Error(`rpc_failed:${label}`);
}

function getReceiptTransferLogs(receipt, tokenContract) {
  const normalizedToken = normalizeAddress(tokenContract);
  const decoded = [];
  for (const log of receipt?.logs || []) {
    if (normalizeAddress(log.address) !== normalizedToken) continue;
    try {
      const parsed = transferInterface.parseLog(log);
      decoded.push({
        txHash: String(log.transactionHash || receipt.hash || ""),
        logIndex: Number(log.index ?? log.logIndex ?? 0),
        blockNumber: Number(log.blockNumber ?? receipt.blockNumber ?? 0),
        from: normalizeAddress(parsed.args.from),
        to: normalizeAddress(parsed.args.to),
        amountBase: parsed.args.value.toString(),
      });
    } catch (_error) {
      // ignore non-Transfer logs on same contract
    }
  }
  return decoded;
}

function convertTokenTransferLogToAppBase(log) {
  const converted = convertBaseUnitsBetweenDecimals(log.amountBase, TOKEN_DECIMALS, JPYC_SCALE_DECIMALS);
  if (!converted.exact) {
    return {
      ...log,
      rawTokenAmountBase: log.amountBase,
      amountBase: null,
      conversionError: converted.error || "NON_EXACT_DECIMAL_CONVERSION",
    };
  }
  return {
    ...log,
    rawTokenAmountBase: log.amountBase,
    amountBase: converted.value,
    conversionError: null,
  };
}

async function verifyTransferOnChain({
  txHash,
  expectedTokenContract = APPROVED_TOKEN_CONTRACT,
  expectedToAddress = null,
  expectedFromAddress = null,
  expectedAmountBase = null,
}) {
  const parsedTxHash = parseTxHash(txHash);
  if (!parsedTxHash) {
    return { ok: false, code: "INVALID_TX_HASH", message: "tx_hash must be a 0x-prefixed 32-byte hash" };
  }

  return withRpcProvider("verify_transfer", async (provider) => {
    const rpcChainIdHex = String(await provider.send("eth_chainId", []));
    const rpcChainId = rpcChainIdHex.startsWith("0x") ? BigInt(rpcChainIdHex).toString() : rpcChainIdHex;
    if (String(rpcChainId) !== String(CHAIN_ID)) {
      return { ok: false, code: "WRONG_CHAIN", message: "RPC chain does not match configured chain" };
    }

    const receipt = await provider.getTransactionReceipt(parsedTxHash);
    if (!receipt) {
      return { ok: false, code: "TX_NOT_FOUND", message: "transaction receipt not found" };
    }
    if (Number(receipt.status || 0) !== 1) {
      return { ok: false, code: "TX_REVERTED", message: "transaction did not succeed", receipt };
    }

    const latestBlockHex = String(await provider.send("eth_blockNumber", []));
    const latestBlock = latestBlockHex.startsWith("0x") ? Number(BigInt(latestBlockHex)) : Number(latestBlockHex);
    const confirmations = Math.max(0, latestBlock - Number(receipt.blockNumber || 0) + 1);
    const block = receipt.blockNumber != null
      ? await provider.send("eth_getBlockByNumber", [`0x${BigInt(Number(receipt.blockNumber)).toString(16)}`, false])
      : null;
    const rawBlockTimestamp = block?.timestamp
      ? (String(block.timestamp).startsWith("0x") ? Number(BigInt(block.timestamp)) : Number(block.timestamp))
      : null;
    const blockTimestamp = rawBlockTimestamp ? new Date(rawBlockTimestamp * 1000).toISOString() : null;
    const observedAt = nowIso();

    const transferLogs = getReceiptTransferLogs(receipt, expectedTokenContract).map(convertTokenTransferLogToAppBase);
    if (transferLogs.length === 0) {
      return { ok: false, code: "WRONG_TOKEN", message: "approved token Transfer log not found", receipt, confirmations, observedAt, blockTimestamp };
    }
    const exactTransferLogs = transferLogs.filter((log) => !log.conversionError);
    if (exactTransferLogs.length === 0) {
      return {
        ok: false,
        code: "NON_EXACT_DECIMAL_CONVERSION",
        message: "Transfer amount cannot be converted exactly to app base units",
        receipt,
        confirmations,
        observedAt,
        blockTimestamp,
        transfer: transferLogs[0],
      };
    }

    const expectedTo = expectedToAddress ? normalizeAddress(expectedToAddress) : null;
    const toMatches = expectedTo ? exactTransferLogs.filter((log) => log.to === expectedTo) : exactTransferLogs;
    if (expectedTo && toMatches.length === 0) {
      return { ok: false, code: "WRONG_RECIPIENT", message: "Transfer recipient does not match", receipt, confirmations, observedAt, blockTimestamp };
    }

    const expectedFrom = expectedFromAddress ? normalizeAddress(expectedFromAddress) : null;
    const fromMatches = expectedFrom ? toMatches.filter((log) => log.from === expectedFrom) : toMatches;
    if (expectedFrom && fromMatches.length === 0) {
      return { ok: false, code: "WRONG_FROM_ADDRESS", message: "Transfer sender does not match", receipt, confirmations, observedAt, blockTimestamp };
    }

    const amountMatches = expectedAmountBase
      ? fromMatches.filter((log) => {
          try {
            return compareBaseUnits(log.amountBase, String(expectedAmountBase)) === 0;
          } catch (_error) {
            return false;
          }
        })
      : fromMatches;

    if (expectedAmountBase && amountMatches.length === 0) {
      const candidate = fromMatches[0] || toMatches[0] || transferLogs[0];
      return {
        ok: false,
        code: "WRONG_AMOUNT",
        message: "Transfer amount does not match",
	        receipt,
	        confirmations,
	        observedAt,
	        blockTimestamp,
	        transfer: candidate,
	      };
    }

    return {
      ok: true,
	      confirmations,
	      observedAt,
	      blockTimestamp,
	      receipt,
      transfer: amountMatches[0] || fromMatches[0] || toMatches[0] || transferLogs[0],
    };
  });
}

function createSseToken({ invoiceId, terminalId, storeId, sessionId, expiresAtIso }) {
  const invoiceExpiryMs = new Date(expiresAtIso).getTime();
  const fallbackExpiryMs = Date.now() + SSE_TOKEN_MAX_TTL_SEC * 1000;
  const ttlCapMs = Date.now() + SSE_TOKEN_MAX_TTL_SEC * 1000;
  const tokenExpiryMs = Number.isFinite(invoiceExpiryMs)
    ? Math.min(ttlCapMs, Math.max(Date.now() + 60_000, invoiceExpiryMs + 300_000))
    : fallbackExpiryMs;
  const payload = {
    aud: "sse",
    scope: "invoice:read",
    invoice_id: invoiceId,
    terminal_id: terminalId,
    store_id: storeId,
    session_id: sessionId,
    exp: Math.floor(tokenExpiryMs / 1000),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = hmac(`sse.${body}`);
  return `${body}.${sig}`;
}

function verifySseToken(token, expected) {
  const raw = String(token || "");
  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, code: "INVALID_SSE_TOKEN", message: "malformed sse token" };
  const [body, sig] = parts;
  const expectedSig = hmac(`sse.${body}`);
  if (!safeHexEqual(expectedSig, sig)) {
    return { ok: false, code: "INVALID_SSE_TOKEN", message: "signature mismatch" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (_error) {
    return { ok: false, code: "INVALID_SSE_TOKEN", message: "payload decode failed" };
  }
  const exp = Number(payload.exp);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, code: "SSE_TOKEN_EXPIRED", message: "sse token expired" };
  }
  if (payload.aud !== "sse" || payload.scope !== "invoice:read") {
    return { ok: false, code: "INVALID_SSE_TOKEN_SCOPE", message: "invalid sse token scope" };
  }
  if (expected.invoiceId && String(payload.invoice_id) !== String(expected.invoiceId)) {
    return { ok: false, code: "SSE_TOKEN_INVOICE_MISMATCH", message: "invoice binding mismatch" };
  }
  if (expected.terminalId && String(payload.terminal_id) !== String(expected.terminalId)) {
    return { ok: false, code: "SSE_TOKEN_TERMINAL_MISMATCH", message: "terminal binding mismatch" };
  }
  return { ok: true, payload };
}

function redactUrlForLogs(urlValue) {
  const raw = String(urlValue || "");
  if (!raw.includes("?")) return raw;
  try {
    const parsed = new URL(raw, APP_HOST);
    for (const key of ["token", "sse_token"]) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    if (!/^[a-z]+:\/\//i.test(raw)) {
      return `${parsed.pathname}${parsed.search}`;
    }
    return parsed.toString();
  } catch (_error) {
    return raw.replace(/([?&](?:token|sse_token)=)[^&]+/gi, "$1[REDACTED]");
  }
}

function recordSuspiciousActivity({ storeId, invoiceId, reason, payload }) {
  db.prepare(
    `INSERT INTO suspicious_activity_logs(id, store_id, invoice_id, reason, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuid(), storeId || null, invoiceId || null, String(reason), JSON.stringify(payload || {}), nowIso());
}

function getTerminalLockout(terminalCode) {
  return db.prepare(`SELECT * FROM terminal_login_lockouts WHERE terminal_code = ?`).get(String(terminalCode));
}

function registerPinFailure(terminalCode) {
  const current = getTerminalLockout(terminalCode);
  const nextFailures = Number(current?.failed_attempts || 0) + 1;
  const lockRequired = nextFailures >= PIN_LOCKOUT_MAX_ATTEMPTS;
  const lockedUntil = lockRequired ? new Date(Date.now() + PIN_LOCKOUT_SEC * 1000).toISOString() : null;
  db.prepare(
    `INSERT INTO terminal_login_lockouts(terminal_code, failed_attempts, locked_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(terminal_code) DO UPDATE SET
       failed_attempts = excluded.failed_attempts,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`
  ).run(String(terminalCode), nextFailures, lockedUntil, nowIso());
  return { failedAttempts: nextFailures, lockedUntil };
}

function clearPinFailures(terminalCode) {
  db.prepare(`DELETE FROM terminal_login_lockouts WHERE terminal_code = ?`).run(String(terminalCode));
}

function cleanupServiceReplayGuards() {
  db.prepare(`DELETE FROM service_replay_guards WHERE expires_at <= ?`).run(nowIso());
}

function cleanupIdempotencyRecords() {
  db.prepare(`DELETE FROM idempotency_records WHERE expires_at <= ?`).run(nowIso());
}

function parseAuth(req) {
  const raw = req.headers.authorization || "";
  if (!raw.startsWith("Bearer ")) return null;
  return raw.slice(7).trim();
}

function getSessionByToken(token) {
  const tokenHash = sha256(token);
  const session = db
    .prepare(
      `SELECT s.id AS session_id, s.terminal_id, s.staff_user_id, s.started_at, t.store_id, u.role, u.permissions_override
       FROM terminal_sessions s
       JOIN terminals t ON t.id = s.terminal_id
       JOIN staff_users u ON u.id = s.staff_user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.ended_at IS NULL AND u.status = 'active'`
    )
    .get(tokenHash);
  if (!session) return null;
  if (Number.isFinite(SESSION_TTL_SEC) && SESSION_TTL_SEC > 0) {
    const ageMs = Date.now() - new Date(session.started_at).getTime();
    if (!Number.isFinite(ageMs) || ageMs > SESSION_TTL_SEC * 1000) {
      db.prepare(`UPDATE terminal_sessions SET ended_at = COALESCE(ended_at, ?), ended_reason = COALESCE(ended_reason, 'expired') WHERE id = ?`).run(
        nowIso(),
        session.session_id
      );
      return null;
    }
  }
  return session;
}

function requireSession(req, res, next) {
  if (req.path.startsWith("/public/")) return next();
  if (req.path.startsWith("/streams/")) return next();
  const token = parseAuth(req);
  if (!token) return jsonError(res, 401, "UNAUTHORIZED", "Bearer token is required");
  const session = getSessionByToken(token);
  if (!session) return jsonError(res, 401, "UNAUTHORIZED", "Invalid or expired session");
  req.session = session;
  next();
}

const ROLE_PERMISSIONS = {
  staff: new Set(["invoice.create", "invoice.read"]),
  operator: new Set(["invoice.create", "invoice.read"]),
  accounting: new Set(["invoice.read", "review.read", "refund.view", "settlement.close", "settlement.export", "audit.read", "audit.export"]),
  manager: new Set([
    "invoice.create",
    "invoice.read",
    "review.read",
    "review.update",
    "refund.request",
    "refund.view",
    "refund.approve",
    "settlement.close",
    "settlement.export",
    "audit.read",
    "session.read"
  ]),
  admin: new Set([
    "invoice.create",
    "invoice.read",
    "review.read",
    "review.update",
    "refund.request",
    "refund.view",
    "refund.approve",
    "refund.execute",
    "payment.ingest.manual",
    "payments.control",
    "address_pool.manage",
    "settlement.close",
    "settlement.export",
    "staff.manage",
    "terminal.manage",
    "session.read",
    "session.revoke",
    "audit.read",
    "audit.export",
    "monitor.read"
  ])
};

function getPermissionsForSession(session) {
  const defaults = new Set(ROLE_PERMISSIONS[session?.role] || []);
  if (!session?.permissions_override) return defaults;
  try {
    const parsed = JSON.parse(session.permissions_override);
    if (!Array.isArray(parsed)) return defaults;
    return new Set(parsed.map((value) => String(value)));
  } catch (error) {
    console.warn(
      JSON.stringify({
        ts: nowIso(),
        level: "warn",
        type: "session.permissions_override_invalid",
        staff_user_id: session?.staff_user_id || null,
        message: String(error.message || error),
      })
    );
    return defaults;
  }
}

function hasPermission(session, permission) {
  const permissions = getPermissionsForSession(session);
  return permissions.has(permission);
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.session) return jsonError(res, 401, "UNAUTHORIZED", "Session required");
    if (!hasPermission(req.session, permission)) {
      return jsonError(res, 403, "FORBIDDEN", `Permission denied: ${permission}`);
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.session || !["manager", "admin"].includes(req.session.role)) {
    return jsonError(res, 403, "FORBIDDEN", "Admin or manager role required");
  }
  next();
}

function requireServiceSignature(req, res, next) {
  const serviceId = String(req.header("X-Service-Id") || "");
  const timestampRaw = String(req.header("X-Service-Timestamp") || "");
  const signature = String(req.header("X-Service-Signature") || "");
  const serviceJti = String(req.header("X-Service-JTI") || req.header("Idempotency-Key") || "");
  if (!serviceId || !timestampRaw || !signature || !serviceJti) {
    return jsonError(res, 401, "UNAUTHORIZED", "Service auth headers are required");
  }
  if (serviceId !== SERVICE_INGEST_ID) {
    return jsonError(res, 401, "UNAUTHORIZED", "Unknown service id");
  }
  const timestamp = Number(timestampRaw);
  if (!Number.isInteger(timestamp)) {
    return jsonError(res, 401, "UNAUTHORIZED", "Invalid service timestamp");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (timestamp < nowSec - SERVICE_AUTH_MAX_SKEW_SEC) {
    return jsonError(res, 401, "UNAUTHORIZED", "Service signature timestamp is too old");
  }
  if (timestamp > nowSec + SERVICE_AUTH_MAX_FUTURE_SEC) {
    return jsonError(res, 401, "UNAUTHORIZED", "Service signature timestamp is in the future");
  }
  const payloadHash = sha256(JSON.stringify(req.body || {}));
  const expected = hmacWithSecret(SERVICE_INGEST_SECRET, `${serviceId}.${timestamp}.${serviceJti}.${payloadHash}`);
  if (!safeHexEqual(expected, signature)) {
    return jsonError(res, 401, "UNAUTHORIZED", "Invalid service signature");
  }
  cleanupServiceReplayGuards();
  const replayFound = db.prepare(`SELECT 1 AS ok FROM service_replay_guards WHERE service_id = ? AND jti = ?`).get(serviceId, serviceJti);
  if (replayFound?.ok === 1) {
    return jsonError(res, 409, "REPLAY_DETECTED", "Service request replay detected");
  }
  const replayExpiresAt = new Date(Date.now() + SERVICE_REPLAY_GUARD_TTL_SEC * 1000).toISOString();
  db.prepare(
    `INSERT INTO service_replay_guards(id, service_id, jti, request_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    serviceId,
    serviceJti,
    payloadHash,
    nowIso(),
    replayExpiresAt
  );
  req.serviceAuth = { serviceId, timestamp, serviceJti };
  next();
}

function isTransitionAllowed(from, to) {
  const transitions = {
    draft: new Set(["issued"]),
    issued: new Set(["payment_detected", "expired", "cancelled"]),
    payment_detected: new Set(["confirming", "review_required"]),
    confirming: new Set(["paid", "review_required"]),
    paid: new Set(["review_required"]),
    expired: new Set(["review_required"]),
    review_required: new Set(["review_required"]),
    cancelled: new Set([])
  };
  return transitions[from] && transitions[from].has(to);
}

function audit({
  actorType,
  actorId,
  action,
  targetType,
  targetId,
  requestId,
  idempotencyKey,
  beforeState,
  afterState,
  ip
}) {
  const createdAt = nowIso();
  const latest = db.prepare(`SELECT entry_hash FROM audit_logs ORDER BY rowid DESC LIMIT 1`).get();
  const prevHash = latest?.entry_hash || null;
  const entryHash = computeAuditEntryHash(prevHash, {
    actorType,
    actorId,
    action,
    targetType,
    targetId,
    requestId,
    idempotencyKey,
    beforeState,
    afterState,
    ip,
    createdAt
  });
  db.prepare(
    `INSERT INTO audit_logs
    (id, actor_type, actor_id, action, target_type, target_id, request_id, idempotency_key, before_state, after_state, prev_hash, entry_hash, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    actorType,
    actorId,
    action,
    targetType,
    targetId,
    requestId || null,
    idempotencyKey || null,
    beforeState ? JSON.stringify(beforeState) : null,
    afterState ? JSON.stringify(afterState) : null,
    prevHash,
    entryHash,
    ip || null,
    createdAt
  );
}

const RESOLVED_REFUND_STATUSES = new Set(["succeeded", "verified", "cancelled", "rejected"]);

function isUnresolvedRefundStatus(status) {
  const value = String(status || "").trim();
  return !RESOLVED_REFUND_STATUSES.has(value);
}

function refundAuditLogRefs(refundId) {
  return db
    .prepare(`SELECT id, action, created_at FROM audit_logs WHERE target_type = 'refund' AND target_id = ? ORDER BY rowid ASC`)
    .all(refundId);
}

function buildRefundEvidenceResponse(refund) {
  if (!refund) return null;
  const auditRefs = refundAuditLogRefs(refund.id);
  return {
    refund_request_id: refund.id,
    refund_case_id: refund.id,
    source_invoice_id: refund.invoice_id,
    original_invoice_id: refund.original_invoice_id || refund.invoice_id,
    checkout_session_id: refund.checkout_session_id || null,
    original_tx_hash: refund.original_tx_hash || null,
    status: refund.status,
    reason: refund.reason || null,
    requested_by: refund.requested_by,
    approved_by: refund.approved_by || null,
    executed_by: refund.executed_by || null,
    executed_wallet: refund.executed_wallet || null,
    refund_tx_hash: refund.refund_tx_hash || null,
    refund_tx_log_index: refund.refund_tx_log_index ?? null,
    refund_amount_jpyc: refund.refund_amount_jpyc,
    refund_amount: refund.refund_amount_jpyc,
    refund_amount_jpyc_base: refund.refund_amount_jpyc_base,
    refund_amount_base: refund.refund_amount_jpyc_base,
    eligible_refund_amount_jpyc_base: refund.refund_eligible_jpyc_base,
    evidence_screenshot: refund.evidence_screenshot || null,
    evidence_note_path: refund.evidence_note_path || null,
    customer_note: refund.customer_note || null,
    failure_reason: refund.failure_reason || null,
    audit_log_refs: auditRefs,
    chain_id: refund.chain_id || refund.refund_chain_id || null,
    token_contract: refund.token_contract || null,
    from_address: refund.from_address || null,
    to_address: refund.to_address || refund.refund_to_address || null,
    executor_type: refund.executor_type || null,
    execution_ref: refund.execution_ref || null,
    block_number: refund.block_number || null,
    block_timestamp: refund.block_timestamp || null,
    detected_at: refund.detected_at || null,
    verified_at: refund.verified_at || null,
    verified_onchain: refund.status === "succeeded" || refund.status === "verified",
  };
}

function verifyAuditChain() {
  const rows = db.prepare(`SELECT rowid, * FROM audit_logs ORDER BY rowid ASC`).all();
  let prevHash = null;
  for (const row of rows) {
    const beforeState = parseJsonWithWarning(row.before_state, "audit_chain_verify.before_state", null);
    const afterState = parseJsonWithWarning(row.after_state, "audit_chain_verify.after_state", null);
    const expected = computeAuditEntryHash(prevHash, {
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      requestId: row.request_id,
      idempotencyKey: row.idempotency_key,
      beforeState,
      afterState,
      ip: row.ip_address,
      createdAt: row.created_at
    });
    if (row.prev_hash !== prevHash || row.entry_hash !== expected) {
      return {
        ok: false,
        total: rows.length,
        broken_at: row.id,
        expected_prev_hash: prevHash,
        actual_prev_hash: row.prev_hash,
        expected_entry_hash: expected,
        actual_entry_hash: row.entry_hash
      };
    }
    prevHash = row.entry_hash;
  }
  return { ok: true, total: rows.length, tail_hash: prevHash };
}

function idempotent(req, res, endpoint, actorId, logicFn) {
  const key = req.header("Idempotency-Key");
  if (!key) {
    console.warn(
      JSON.stringify({
        ts: nowIso(),
        level: "warn",
        type: "idempotency.key_missing",
        endpoint,
        request_id: requestIdFromReq(req),
        actor_id: actorId,
      })
    );
    return jsonError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
  }

  cleanupIdempotencyRecords();
  const requestHash = hashJson(req.body);
  const existing = db
    .prepare(
      `SELECT status_code, response_json, request_hash
       FROM idempotency_records
       WHERE actor_id = ? AND endpoint = ? AND idempotency_key = ? AND expires_at > ?`
    )
    .get(actorId, endpoint, key, nowIso());

  if (existing) {
    if (existing.request_hash !== requestHash) {
      return jsonError(res, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key already used with different payload");
    }
    const parsedResponse = parseJsonWithWarning(existing.response_json, "idempotency.response_json", null);
    if (!parsedResponse || typeof parsedResponse !== "object") {
      console.error(
        JSON.stringify({
          ts: nowIso(),
          level: "error",
          type: "idempotency.response_parse_failed",
          endpoint,
          request_id: requestIdFromReq(req),
          actor_id: actorId,
        })
      );
      return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error");
    }
    return res.status(existing.status_code).json(parsedResponse);
  }

  let result;
  try {
    result = logicFn();
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: nowIso(),
        level: "error",
        type: "idempotency.logic_failed",
        endpoint,
        request_id: requestIdFromReq(req),
        actor_id: actorId,
        message: String(error.message || error),
      })
    );
    return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error");
  }

  const statusCode = result.status ?? 200;
  const responseBody = result.body ?? {};
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SEC * 1000).toISOString();

  db.prepare(
    `INSERT INTO idempotency_records
    (id, actor_id, endpoint, idempotency_key, request_hash, status_code, response_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), actorId, endpoint, key, requestHash, statusCode, JSON.stringify(responseBody), nowIso(), expiresAt);

  return res.status(statusCode).json(responseBody);
}

async function idempotentAsync(req, res, endpoint, actorId, logicFn) {
  const key = req.header("Idempotency-Key");
  if (!key) {
    return jsonError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
  }

  cleanupIdempotencyRecords();
  const requestHash = hashJson(req.body);
  const existing = db
    .prepare(
      `SELECT status_code, response_json, request_hash
       FROM idempotency_records
       WHERE actor_id = ? AND endpoint = ? AND idempotency_key = ? AND expires_at > ?`
    )
    .get(actorId, endpoint, key, nowIso());

  if (existing) {
    if (existing.request_hash !== requestHash) {
      return jsonError(res, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key already used with different payload");
    }
    const parsedResponse = parseJsonWithWarning(existing.response_json, "idempotency_async.response_json", null);
    return res.status(existing.status_code).json(parsedResponse || {});
  }

  let result;
  try {
    result = await logicFn();
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: nowIso(),
        level: "error",
        type: "idempotency_async.logic_failed",
        endpoint,
        request_id: requestIdFromReq(req),
        actor_id: actorId,
        message: String(error.message || error),
      })
    );
    return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error");
  }

  const statusCode = result.status ?? 200;
  const responseBody = result.body ?? {};
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SEC * 1000).toISOString();
  db.prepare(
    `INSERT INTO idempotency_records
    (id, actor_id, endpoint, idempotency_key, request_hash, status_code, response_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), actorId, endpoint, key, requestHash, statusCode, JSON.stringify(responseBody), nowIso(), expiresAt);

  return res.status(statusCode).json(responseBody);
}

const clientsByTerminal = new Map();
function sendEvent(terminalId, event, payload) {
  const clients = clientsByTerminal.get(terminalId);
  if (!clients || clients.size === 0) return;
  const lines = [`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`];
  if (event === "invoice.updated") {
    lines.push(`event: status_changed\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  for (const client of clients) {
    if (payload?.invoiceId && client.invoiceId && String(client.invoiceId) !== String(payload.invoiceId)) {
      continue;
    }
    for (const line of lines) {
      client.res.write(line);
    }
  }
}

function parseBaseUnitOrZero(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !/^-?\\d+$/.test(raw)) return 0n;
  try {
    return BigInt(raw);
  } catch (_error) {
    return 0n;
  }
}

function normalizeReviewResolutionStatus(value, fallback = null) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  const mapped = {
    open: "pending",
    in_progress: "pending",
    pending: "pending",
    resolved: "settled",
    settled: "settled",
    rejected: "cancelled",
    cancelled: "cancelled",
    manual_review: "manual_review",
  }[raw];
  return mapped || fallback;
}

function computeReviewRefundableCandidateBase(reasonCodeRaw, billedBaseRaw, paidBaseRaw) {
  const reasonCode = normalizeReviewReasonCode(reasonCodeRaw);
  const billedBase = parseBaseUnitOrZero(billedBaseRaw);
  const paidBase = parseBaseUnitOrZero(paidBaseRaw);
  if (reasonCode === REVIEW_REASON_CODES.OVERPAYMENT) {
    return paidBase > billedBase ? (paidBase - billedBase).toString() : "0";
  }
  if (reasonCode === REVIEW_REASON_CODES.LATE_PAYMENT) {
    return paidBase > 0n ? paidBase.toString() : "0";
  }
  if (
    reasonCode === REVIEW_REASON_CODES.DUPLICATE_PAYMENT
    || reasonCode === REVIEW_REASON_CODES.UNKNOWN_TRANSFER
    || reasonCode === REVIEW_REASON_CODES.ADDRESS_MISMATCH
    || reasonCode === REVIEW_REASON_CODES.CHAIN_INCONSISTENT
  ) {
    return paidBase > 0n ? paidBase.toString() : "0";
  }
  return "0";
}

function appendReviewActionHistory(existingHistoryJson, actionEntry) {
  const parsed = parseJsonWithWarning(existingHistoryJson, "review.action_history_json", []);
  const history = Array.isArray(parsed) ? parsed : [];
  history.push(actionEntry);
  return JSON.stringify(history.slice(-100));
}

function buildReviewCasePayload(invoice, reasonType, context = {}) {
  const reasonCode = normalizeReviewReasonCode(reasonType);
  const billedAmountBase = String(invoice?.amount_jpyc_base || "0");
  const paidAmountBase = String(context.eventAmountBase ?? invoice?.paid_amount_jpyc_base ?? "0");
  const diff = (parseBaseUnitOrZero(paidAmountBase) - parseBaseUnitOrZero(billedAmountBase)).toString();
  const refundable = computeReviewRefundableCandidateBase(reasonCode, billedAmountBase, paidAmountBase);
  const blockTimestamp = context.blockTimestamp || context.observedAt || nowIso();
  const detectedAt = context.detectedAt || nowIso();
  return {
    reasonCode,
    txHash: context.txHash || invoice?.paid_tx_hash || null,
    billedAmountBase,
    paidAmountBase,
    diff,
    suggestedAction: context.suggestedAction || suggestedReviewAction(reasonCode),
    refundableCandidateBase: refundable,
    resolutionStatus: normalizeReviewResolutionStatus(context.resolutionStatus, "pending") || "pending",
    auditRef: context.auditRef || null,
    blockTimestamp,
    detectedAt,
  };
}

function upsertReviewCase(invoice, reasonType, context = {}) {
  const existing = db.prepare(`SELECT * FROM review_cases WHERE invoice_id = ?`).get(invoice.id);
  const ts = nowIso();
  const payload = buildReviewCasePayload(invoice, reasonType, context);
  const actionEntry = {
    at: ts,
    action: "review.detected",
    reason_code: payload.reasonCode,
    tx_hash: payload.txHash,
    block_timestamp: payload.blockTimestamp,
    detected_at: payload.detectedAt,
  };
  if (existing) {
    const actionHistory = appendReviewActionHistory(existing.action_history_json, actionEntry);
    db.prepare(
      `UPDATE review_cases
       SET reason_type = ?,
           tx_hash = ?,
           billed_amount_jpyc_base = ?,
           paid_amount_jpyc_base = ?,
           diff_jpyc_base = ?,
           suggested_action = ?,
           refundable_candidate_jpyc_base = ?,
           resolution_status = ?,
           audit_ref = ?,
           block_timestamp = ?,
           detected_at = ?,
           action_history_json = ?,
           status = 'open',
           updated_at = ?,
           resolved_at = NULL
       WHERE id = ?`
    ).run(
      payload.reasonCode,
      payload.txHash,
      payload.billedAmountBase,
      payload.paidAmountBase,
      payload.diff,
      payload.suggestedAction,
      payload.refundableCandidateBase,
      payload.resolutionStatus,
      payload.auditRef,
      payload.blockTimestamp,
      payload.detectedAt,
      actionHistory,
      ts,
      existing.id
    );
    return db.prepare(`SELECT * FROM review_cases WHERE id = ?`).get(existing.id);
  }
  const reviewId = uuid();
  const actionHistory = JSON.stringify([actionEntry]);
  db.prepare(
    `INSERT INTO review_cases
     (id, invoice_id, reason_type, tx_hash, billed_amount_jpyc_base, paid_amount_jpyc_base, diff_jpyc_base, suggested_action,
      refundable_candidate_jpyc_base, admin_note, action_history_json, resolution_status, audit_ref, block_timestamp, detected_at,
      status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(
    reviewId,
    invoice.id,
    payload.reasonCode,
    payload.txHash,
    payload.billedAmountBase,
    payload.paidAmountBase,
    payload.diff,
    payload.suggestedAction,
    payload.refundableCandidateBase,
    actionHistory,
    payload.resolutionStatus,
    payload.auditRef,
    payload.blockTimestamp,
    payload.detectedAt,
    ts,
    ts
  );
  return db.prepare(`SELECT * FROM review_cases WHERE id = ?`).get(reviewId);
}

function updateInvoiceStatus(invoiceId, nextStatus, reason = null, pointerContext = null) {
  const current = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId);
  if (!current) return { error: "NOT_FOUND" };
  if (current.status === nextStatus) return { invoice: current };
  if (!isTransitionAllowed(current.status, nextStatus)) {
    return { error: "INVALID_STATE_TRANSITION", from: current.status, to: nextStatus };
  }
  const ts = nowIso();
  db.prepare(
    `UPDATE invoices
     SET status = ?, status_reason = ?, updated_at = ?
     WHERE id = ?`
  ).run(nextStatus, reason, ts, invoiceId);
  const updated = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId);
  if (String(current.terminal_id || "")) {
    const actorType = pointerContext?.actorType || "system";
    const actorId = pointerContext?.actorId || "invoice.status_transition";
    if (isTerminalActiveInvoiceStatus(updated.status)) {
      setTerminalCurrentInvoicePointer({
        terminalId: updated.terminal_id,
        invoiceId: updated.id,
        assignedAt: pointerContext?.assignedAt || updated.updated_at || ts,
        actorType,
        actorId,
        requestId: pointerContext?.requestId || null,
        idempotencyKey: pointerContext?.idempotencyKey || null,
        ip: pointerContext?.ip || null,
        reason: pointerContext?.reason || "active_invoice_status_transition",
      });
    } else {
      const terminal = getTerminalById(updated.terminal_id);
      if (String(terminal?.current_invoice_id || "") === String(updated.id)) {
        setTerminalCurrentInvoicePointer({
          terminalId: updated.terminal_id,
          invoiceId: null,
          actorType,
          actorId,
          requestId: pointerContext?.requestId || null,
          idempotencyKey: pointerContext?.idempotencyKey || null,
          ip: pointerContext?.ip || null,
          reason: pointerContext?.reason || "invoice_became_non_active",
        });
      }
    }
  }
  return { invoice: updated, before: current };
}


function transitionInvoiceForPayment(invoice, nextStatus, reasonLabel, pointerContext = null) {
  let update = { invoice };
  if (nextStatus === invoice.status) return update;

  if (invoice.status === "issued" && ["confirming", "paid", "review_required"].includes(nextStatus)) {
    // For safety, all first payment outcomes move through payment_detected.
    const detected = updateInvoiceStatus(invoice.id, "payment_detected", "payment_event_detected", pointerContext);
    if (detected.error) return detected;

    if (nextStatus === "review_required") {
      return updateInvoiceStatus(invoice.id, "review_required", reasonLabel || "needs_review", pointerContext);
    }

    // Confirming and paid share the same intermediate transition.
    const confirming = updateInvoiceStatus(invoice.id, "confirming", "awaiting_confirmations", pointerContext);
    if (confirming.error) return confirming;
    if (nextStatus === "paid") {
      return updateInvoiceStatus(invoice.id, "paid", reasonLabel || "confirmed", pointerContext);
    }
    return confirming;
  }

  if (invoice.status === "payment_detected" && nextStatus === "paid") {
    const confirming = updateInvoiceStatus(invoice.id, "confirming", "awaiting_confirmations", pointerContext);
    if (confirming.error) return confirming;
    return updateInvoiceStatus(invoice.id, "paid", reasonLabel || "confirmed", pointerContext);
  }

  return updateInvoiceStatus(invoice.id, nextStatus, reasonLabel || null, pointerContext);
}

function findLatestReviewCase(invoiceId) {
  return db.prepare(`SELECT * FROM review_cases WHERE invoice_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(invoiceId) || null;
}

function findLatestRefundRequest(invoiceId) {
  return db
    .prepare(`SELECT * FROM refund_requests WHERE invoice_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`)
    .get(invoiceId) || null;
}

function determineProviderTransition(invoice, { eventType, txHash = null, amountMatches = true }) {
  if (!amountMatches) return { nextStatus: "review_required", reason: "provider_amount_mismatch" };
  if (eventType === "captured" && txHash) {
    if (["issued", "payment_detected"].includes(String(invoice.status))) {
      return { nextStatus: "confirming", reason: "provider_capture_chain_pending" };
    }
    return { nextStatus: null, reason: "provider_capture_chain_pending" };
  }
  if (["authorized", "captured", "session_created"].includes(eventType) && String(invoice.status) === "issued") {
    return { nextStatus: "payment_detected", reason: "provider_payment_detected" };
  }
  if (eventType === "voided") {
    return { nextStatus: null, reason: "provider_voided" };
  }
  return { nextStatus: null, reason: null };
}

function applyProviderInvoiceTransition(invoice, transition) {
  if (!transition?.nextStatus) return { invoice };
  return transitionInvoiceForPayment(invoice, transition.nextStatus, transition.reason);
}

function buildSettlementExportBaseInvoices(storeId, range) {
  return db
    .prepare(
      `SELECT i.*
       FROM invoices i
       WHERE i.store_id = ?
         AND (
           i.created_at BETWEEN ? AND ?
           OR i.updated_at BETWEEN ? AND ?
           OR EXISTS (
             SELECT 1
             FROM payment_events pe
             WHERE pe.invoice_id = i.id
               AND COALESCE(pe.block_timestamp, pe.detected_at, pe.observed_at, pe.created_at) BETWEEN ? AND ?
           )
           OR EXISTS (
             SELECT 1
             FROM refund_requests rr
             WHERE rr.invoice_id = i.id
               AND COALESCE(rr.block_timestamp, rr.verified_at, rr.created_at) BETWEEN ? AND ?
           )
           OR EXISTS (
             SELECT 1
             FROM payment_sessions ps
             JOIN provider_payment_sessions pps ON pps.payment_session_id = ps.id
             WHERE ps.invoice_id = i.id
               AND COALESCE(pps.provider_captured_at, pps.provider_authorized_at, pps.updated_at, pps.created_at) BETWEEN ? AND ?
           )
           OR EXISTS (
             SELECT 1
             FROM provider_settlement_allocations psa
             JOIN provider_settlements pst ON pst.id = psa.provider_settlement_id
             LEFT JOIN provider_payment_sessions pps ON pps.provider_payment_id = psa.provider_payment_id
             LEFT JOIN payment_sessions ps ON ps.id = pps.payment_session_id
             WHERE COALESCE(psa.invoice_id, ps.invoice_id) = i.id
               AND COALESCE(pst.settled_at, pst.reported_at, psa.updated_at, psa.created_at) BETWEEN ? AND ?
           )
         )
       ORDER BY i.created_at ASC`
    )
    .all(
      storeId,
      range.fromUtc,
      range.toUtc,
      range.fromUtc,
      range.toUtc,
      range.fromUtc,
      range.toUtc,
      range.fromUtc,
      range.toUtc,
      range.fromUtc,
      range.toUtc,
      range.fromUtc,
      range.toUtc
    );
}

function findLatestProviderAllocationForPayment(providerPaymentId, invoiceId = null) {
  if (!providerPaymentId) return null;
  if (invoiceId) {
    return db
      .prepare(
        `SELECT psa.*,
                ps.provider_settlement_id AS external_provider_settlement_id,
                ps.batch_reference,
                ps.settlement_status,
                ps.reported_at AS provider_settlement_reported_at,
                ps.settled_at AS provider_settlement_settled_at
         FROM provider_settlement_allocations psa
         JOIN provider_settlements ps ON ps.id = psa.provider_settlement_id
         WHERE psa.provider_payment_id = ?
           AND COALESCE(psa.invoice_id, '') IN (?, '')
         ORDER BY psa.updated_at DESC, psa.created_at DESC
         LIMIT 1`
      )
      .get(providerPaymentId, invoiceId) || null;
  }
  return db
    .prepare(
      `SELECT psa.*,
              ps.provider_settlement_id AS external_provider_settlement_id,
              ps.batch_reference,
              ps.settlement_status,
              ps.reported_at AS provider_settlement_reported_at,
              ps.settled_at AS provider_settlement_settled_at
       FROM provider_settlement_allocations psa
       JOIN provider_settlements ps ON ps.id = psa.provider_settlement_id
       WHERE psa.provider_payment_id = ?
       ORDER BY psa.updated_at DESC, psa.created_at DESC
       LIMIT 1`
    )
    .get(providerPaymentId) || null;
}

function shouldIncludeSettlementSnapshotRow({ invoice, paymentSession, providerSession, refund }) {
  if (refund) return true;
  if (providerSession || String(paymentSession?.rail_type) === PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL) return true;
  return ["paid", "review_required", "cancelled"].includes(String(invoice.status));
}

function hasCleanProviderAllocation(providerAllocation, invoiceId) {
  if (!providerAllocation) return false;
  if (String(providerAllocation.allocation_status || "") !== "matched") return false;
  return String(providerAllocation.invoice_id || "") === String(invoiceId || "");
}

function buildSettlementExportRow({
  invoice,
  paymentSession,
  providerSession,
  providerAllocation,
  review,
  refund,
  exportRunId,
  businessDate,
}) {
  if (!shouldIncludeSettlementSnapshotRow({ invoice, paymentSession, providerSession, refund })) return null;
  const invoiceAmountBase = toIntegerAmount(invoice.amount_jpyc_base, 0);
  const paidAmountBase = toIntegerAmount(invoice.paid_amount_jpyc_base, 0);
  const providerAmountBase = toIntegerAmount(providerSession?.provider_amount_jpyc_base, invoiceAmountBase);
  const refundAmountBase = toIntegerAmount(refund?.refund_amount_jpyc_base, 0);
  const allocationAmountBase = toIntegerAmount(providerAllocation?.allocated_amount_jpyc_base, providerAmountBase);

  let accountingStatus = "cancelled";
  let cashRecognitionStatus = "none";
  let receivableStatus = "none";
  let onchainCashAmount = 0;
  let providerReceivableAmount = 0;
  let exceptionAmount = 0;
  let voidAmount = 0;
  let refundAmount = 0;

  const refundHasOnchainEvidence =
    refund?.status === "succeeded"
    && refund.refund_tx_hash
    && refund.verified_at
    && refund.block_timestamp;

  if (refundHasOnchainEvidence) {
    accountingStatus = "refunded_onchain";
    cashRecognitionStatus = "none";
    refundAmount = refundAmountBase;
  } else if (refund && ["recorded", "pending_verification"].includes(String(refund.status))) {
    accountingStatus = "exception_pending";
    cashRecognitionStatus = "disputed";
    exceptionAmount = refundAmountBase || paidAmountBase || invoiceAmountBase;
  } else if (refund && ["verification_failed", "failed", "cancelled"].includes(String(refund.status))) {
    accountingStatus = "exception_pending";
    cashRecognitionStatus = "disputed";
    receivableStatus = "disputed";
    exceptionAmount = refundAmountBase || paidAmountBase || invoiceAmountBase;
  } else if (providerSession?.provider_status === "refund_accepted") {
    accountingStatus = "provider_refunded";
    refundAmount = providerAmountBase;
  } else if (providerSession?.provider_status === "voided") {
    accountingStatus = "voided";
    voidAmount = providerAmountBase;
  } else if (String(invoice.status) === "paid") {
    accountingStatus = "onchain_cash_confirmed";
    cashRecognitionStatus = "onchain_confirmed";
    onchainCashAmount = paidAmountBase;
  } else if (providerAllocation && String(providerAllocation.allocation_status) === "disputed") {
    accountingStatus = "exception_pending";
    cashRecognitionStatus = "disputed";
    receivableStatus = canonicalReceivableStatus(providerSession?.provider_status, providerAllocation.settlement_status);
    exceptionAmount = allocationAmountBase || providerAmountBase || invoiceAmountBase;
  } else if (providerAllocation && ["reported", "matched"].includes(String(providerAllocation.allocation_status))) {
    const settlementStatus = String(providerAllocation.settlement_status || "");
    accountingStatus = hasCleanProviderAllocation(providerAllocation, invoice.id)
      ? "provider_settlement_pending"
      : "provider_settled_unallocated";
    if (["chain_detected", "confirmed"].includes(settlementStatus)) {
      cashRecognitionStatus = "batch_confirmed";
    }
    receivableStatus = canonicalReceivableStatus(providerSession?.provider_status, providerAllocation.settlement_status);
    providerReceivableAmount = allocationAmountBase;
  } else if (String(invoice.status) === "review_required") {
    accountingStatus = "exception_pending";
    cashRecognitionStatus = "disputed";
    receivableStatus = providerSession ? canonicalReceivableStatus(providerSession.provider_status) : "none";
    exceptionAmount = paidAmountBase > 0 ? paidAmountBase : (providerSession ? providerAmountBase : invoiceAmountBase);
  } else if (providerSession && ["authorized", "captured", "initialized", "settlement_pending", "settled"].includes(String(providerSession.provider_status))) {
    accountingStatus = "provider_receivable";
    receivableStatus = canonicalReceivableStatus(providerSession.provider_status);
    providerReceivableAmount = providerAmountBase;
  } else if (String(invoice.status) === "cancelled") {
    accountingStatus = "cancelled";
  } else {
    return null;
  }

  if (!ACCOUNTING_STATUS_VALUES.includes(accountingStatus)) return null;
  if (!CASH_RECOGNITION_STATUS_VALUES.includes(cashRecognitionStatus)) return null;
  if (!RECEIVABLE_STATUS_VALUES.includes(receivableStatus)) return null;

  const providerPaymentRef = providerSession?.provider_payment_id || providerSession?.provider_session_id || null;
  const providerSettlementRef = providerAllocation?.external_provider_settlement_id || providerAllocation?.batch_reference || null;
  const onchainTransferRef = invoice.paid_tx_hash || null;
  const paymentAttemptIds = settlementPaymentAttemptIds(invoice.id);
  const primaryEvent = invoice.paid_tx_hash
    ? db.prepare(`SELECT log_index, block_timestamp, detected_at FROM payment_events WHERE invoice_id = ? AND tx_hash = ? ORDER BY created_at ASC LIMIT 1`).get(invoice.id, invoice.paid_tx_hash)
    : null;
  const auditRefs = settlementAuditRefsForInvoice(invoice.id, [refund?.id, review?.id]);
  const evidenceHash = hashProviderEvidence({
    invoice_id: invoice.id,
    payment_session_id: paymentSession?.id || null,
    provider_payment_ref: providerPaymentRef,
    provider_settlement_ref: providerSettlementRef,
    onchain_transfer_ref: onchainTransferRef,
    invoice_status: invoice.status,
    review_status: review?.status || null,
    refund_status: refund?.status || null,
    accounting_status: accountingStatus,
  });

	  const rowId = uuid();
	  return {
	    id: rowId,
	    export_reference: `settlement-${businessDate}.csv`,
	    settlement_id: invoice.settlement_id || null,
	    settlement_export_run_id: exportRunId,
	    settlement_export_row_id: rowId,
	    export_run_id: exportRunId,
	    export_version: "v1",
    business_date: businessDate,
    store_id: invoice.store_id || null,
    terminal_id: invoice.terminal_id || null,
    merchant_id: invoice.merchant_id || null,
    operator_id: invoice.operator_id || invoice.staff_user_id || null,
    event_id: invoice.event_id || null,
    booth_id: invoice.booth_id || null,
    invoice_id: invoice.id,
	    invoice_no: invoice.invoice_no || null,
	    checkout_session_id: invoice.checkout_session_id || null,
    payment_session_id: paymentSession?.id || null,
    rail_type: paymentSession?.rail_type || PAYMENT_RAIL_TYPES.WALLET_DIRECT,
    provider_code: paymentSession?.provider_code || PROVIDER_CODES.SELF_WALLET,
    invoice_amount_jpyc_base: invoiceAmountBase,
    invoice_status: String(invoice.status),
    status_reason: invoice.status_reason || null,
    amount_jpy: invoice.amount_jpy ?? null,
    amount_jpyc_base: invoiceAmountBase,
    paid_amount_jpyc_base: paidAmountBase,
    accounting_status: accountingStatus,
    cash_recognition_status: cashRecognitionStatus,
    receivable_status: receivableStatus,
    onchain_cash_amount_jpyc_base: onchainCashAmount,
    provider_receivable_amount_jpyc_base: providerReceivableAmount,
    exception_amount_jpyc_base: exceptionAmount,
    refund_amount_jpyc_base: refundAmount,
    void_amount_jpyc_base: voidAmount,
    provider_payment_ref: providerPaymentRef,
    provider_settlement_ref: providerSettlementRef,
    onchain_transfer_ref: onchainTransferRef,
    tx_hash: invoice.paid_tx_hash || null,
    payment_attempt_ids: paymentAttemptIds,
    primary_tx_hash: invoice.paid_tx_hash || null,
    primary_tx_log_index: primaryEvent?.log_index ?? null,
    reason_code: normalizeReviewReasonCode(review?.reason_type || REVIEW_REASON_CODES.OTHER),
    review_case_id: review?.id || null,
    review_reason_type: review?.reason_type || null,
    review_status: review?.status || null,
    block_timestamp: refund?.block_timestamp || primaryEvent?.block_timestamp || review?.block_timestamp || null,
    detected_at: refund?.detected_at || primaryEvent?.detected_at || review?.detected_at || null,
    audit_ref: review?.audit_ref || null,
    refund_status: refund?.status || null,
    refund_request_id: refund?.id || null,
    refund_tx_hash: refundHasOnchainEvidence ? refund.refund_tx_hash : null,
    refund_verified_at: refund?.verified_at || null,
    audit_log_refs: auditRefs,
    external_sync_refs: [providerPaymentRef, providerSettlementRef].filter(Boolean),
    source_ledger_snapshot_hash: evidenceHash,
    evidence_hash: evidenceHash,
    payload_schema_version: "settlement_export_v1",
    export_excluded_private_data: 1,
    created_at: nowIso(),
  };
}

function createSettlementExportSnapshot({
  businessDate,
  store,
  terminalId = null,
  actorId = null,
  requestId = null,
  idempotencyKey = null,
  ip = null,
  range,
}) {
  const runId = uuid();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO settlement_export_runs
     (id, export_version, business_date, store_id, terminal_id, status, exported_at, created_by, created_at)
     VALUES (?, 'v1', ?, ?, ?, 'created', ?, ?, ?)`
  ).run(runId, businessDate, store.id, terminalId || null, createdAt, actorId || null, createdAt);

  audit({
    actorType: actorId ? "admin" : "system",
    actorId: actorId || "system",
    action: "settlement_export_run_created",
    targetType: "settlement_export",
    targetId: runId,
    requestId,
    idempotencyKey,
    afterState: { business_date: businessDate, export_version: "v1", store_id: store.id },
    ip,
  });

  const rows = buildSettlementExportRowsForRange({ store, range, exportRunId: runId });
  for (const row of rows) {
    const payloadJson = JSON.stringify(serializeSettlementExportV1Row(row));
    db.prepare(
        `INSERT INTO settlement_export_rows
         (id, export_run_id, export_version, business_date, store_id, terminal_id, operator_id, invoice_id, checkout_session_id,
          payment_session_id, rail_type, provider_code, invoice_amount_jpyc_base, invoice_status, accounting_status,
          cash_recognition_status, receivable_status, onchain_cash_amount_jpyc_base, provider_receivable_amount_jpyc_base,
          exception_amount_jpyc_base, refund_amount_jpyc_base, void_amount_jpyc_base, provider_payment_ref, provider_settlement_ref,
          onchain_transfer_ref, evidence_hash, payload_json, payload_schema_version, export_excluded_private_data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id,
      row.export_run_id,
      row.export_version,
      row.business_date,
      row.store_id,
      row.terminal_id,
      row.operator_id,
      row.invoice_id,
      row.checkout_session_id,
      row.payment_session_id,
      row.rail_type,
      row.provider_code,
      row.invoice_amount_jpyc_base,
      row.invoice_status,
      row.accounting_status,
      row.cash_recognition_status,
      row.receivable_status,
      row.onchain_cash_amount_jpyc_base,
      row.provider_receivable_amount_jpyc_base,
      row.exception_amount_jpyc_base,
      row.refund_amount_jpyc_base,
      row.void_amount_jpyc_base,
      row.provider_payment_ref,
      row.provider_settlement_ref,
      row.onchain_transfer_ref,
      row.evidence_hash,
      payloadJson,
      row.payload_schema_version,
      row.export_excluded_private_data,
      row.created_at
    );
  }

  db.prepare(`UPDATE settlement_export_runs SET status = 'completed' WHERE id = ?`).run(runId);
  audit({
    actorType: actorId ? "admin" : "system",
    actorId: actorId || "system",
    action: "settlement_export_run_completed",
    targetType: "settlement_export",
    targetId: runId,
    requestId,
    idempotencyKey,
    afterState: { business_date: businessDate, row_count: rows.length },
    ip,
  });

  return {
    exportRunId: runId,
    rows,
    accountingSummary: buildDailyAccountingSummary(rows),
  };
}

function businessDateFromIso(value, timezone) {
  const dt = DateTime.fromISO(String(value || ""), { zone: "utc" }).setZone(timezone || "Asia/Tokyo");
  return dt.isValid ? dt.toISODate() : DateTime.now().setZone(timezone || "Asia/Tokyo").toISODate();
}

function canonicalBusinessDateForSettlementRow({ invoice, providerSession, providerAllocation, refund, timezone }) {
  if (refund && String(refund.status) === "succeeded") {
    return businessDateFromIso(refund.block_timestamp || refund.verified_at || invoice.created_at, timezone);
  }
  if (providerAllocation) {
    return businessDateFromIso(
      providerAllocation.provider_settlement_settled_at
        || providerAllocation.provider_settlement_reported_at
        || providerAllocation.updated_at
        || providerAllocation.created_at
        || invoice.created_at,
      timezone
    );
  }
  if (providerSession) {
    return businessDateFromIso(providerSession.updated_at || providerSession.created_at || invoice.created_at, timezone);
  }
  if (String(invoice.status) === "paid") {
    const event = invoice.paid_tx_hash
      ? db.prepare(`SELECT block_timestamp, detected_at, observed_at, created_at FROM payment_events WHERE invoice_id = ? AND tx_hash = ? ORDER BY created_at ASC LIMIT 1`).get(invoice.id, invoice.paid_tx_hash)
      : null;
    return businessDateFromIso(event?.block_timestamp || event?.detected_at || event?.observed_at || invoice.updated_at || invoice.created_at, timezone);
  }
  return businessDateFromIso(invoice.created_at, timezone);
}

function businessDateMatchesRange(businessDate, range) {
  if (!range?.businessDateFrom || !range?.businessDateTo) return true;
  return String(businessDate || "") >= String(range.businessDateFrom) && String(businessDate || "") <= String(range.businessDateTo);
}

function buildSettlementExportRowsForRange({ store, range, exportRunId, fixedBusinessDate = null }) {
  const invoices = buildSettlementExportBaseInvoices(store.id, range);
  const rows = [];
  for (const invoice of invoices) {
    const review = findLatestReviewCase(invoice.id);
    const refund = findLatestRefundRequest(invoice.id);
    const sessions = getPaymentSessionsForInvoice(invoice);
    for (const paymentSession of sessions) {
      const providerSession = paymentSession.id
        ? db.prepare(`SELECT * FROM provider_payment_sessions WHERE payment_session_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(paymentSession.id) || null
        : null;
      const providerAllocation = providerSession
        ? findLatestProviderAllocationForPayment(providerSession.provider_payment_id, invoice.id)
        : null;
      const businessDate = fixedBusinessDate || canonicalBusinessDateForSettlementRow({
        invoice,
        providerSession,
        providerAllocation,
        refund,
        timezone: store.timezone || "Asia/Tokyo",
      });
      const row = buildSettlementExportRow({
        invoice,
        paymentSession,
        providerSession,
        providerAllocation,
        review,
        refund,
        exportRunId,
        businessDate,
      });
      if (row && businessDateMatchesRange(row.business_date, range)) rows.push(row);
    }
  }
  return rows;
}

function ingestProviderEventRecord({
  invoice,
  providerEvent,
  payloadHash,
  requestId,
  idempotencyKey,
  actorId,
  ip,
}) {
  const existingEvent = db
    .prepare(`SELECT * FROM provider_payment_events WHERE provider_code = ? AND provider_event_id = ?`)
    .get(providerEvent.provider_code, providerEvent.provider_event_id);
  if (existingEvent) {
    if (String(existingEvent.payload_hash) !== String(payloadHash)) {
      return { status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "provider_event_id already used with different payload" } } };
    }
    audit({
      actorType: "service",
      actorId,
      action: "provider_event_duplicate",
      targetType: "provider_event",
      targetId: providerEvent.provider_event_id,
      requestId,
      idempotencyKey,
      afterState: { provider_code: providerEvent.provider_code, provider_event_id: providerEvent.provider_event_id },
      ip,
    });
    const currentInvoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
    return {
      status: 200,
      body: {
        duplicate: true,
        invoice_id: currentInvoice.id,
        invoice_status: currentInvoice.status,
        provider_status: existingEvent.provider_status || providerEvent.provider_status || null,
      },
    };
  }

  const result = db.transaction(() => {
    const ensured = ensureProviderPaymentSession({
      invoice,
      providerCode: providerEvent.provider_code,
      providerTerminalId: providerEvent.terminal_id,
      providerSessionId: providerEvent.provider_session_id,
      providerPaymentId: providerEvent.provider_payment_id,
      providerStatus: providerEvent.provider_status || "initialized",
      providerAmountBase: providerEvent.amount_jpyc_base,
      payloadHash,
      occurredAt: providerEvent.occurred_at,
    });
    if (ensured.error) {
      return { status: 409, body: { error: ensured.error } };
    }
    const amountMatches = providerEvent.amount_jpyc_base == null
      || compareBaseUnits(String(providerEvent.amount_jpyc_base), String(invoice.amount_jpyc_base || "0")) === 0;
    let providerPaymentSession = updateProviderPaymentSessionState(ensured.providerSession.id, {
      providerTerminalId: providerEvent.terminal_id,
      providerSessionId: providerEvent.provider_session_id,
      providerPaymentId: providerEvent.provider_payment_id,
      providerStatus: providerEvent.provider_status || ensured.providerSession.provider_status,
      providerAmountBase: providerEvent.amount_jpyc_base,
      providerAuthorizedAt: providerEvent.event_type === "authorized" ? providerEvent.occurred_at : ensured.providerSession.provider_authorized_at,
      providerCapturedAt: providerEvent.event_type === "captured" ? providerEvent.occurred_at : ensured.providerSession.provider_captured_at,
      providerVoidedAt: providerEvent.event_type === "voided" ? providerEvent.occurred_at : ensured.providerSession.provider_voided_at,
      providerCancelledAt: providerEvent.event_type === "failed" ? providerEvent.occurred_at : ensured.providerSession.provider_cancelled_at,
      payloadHash,
    });
    const fulfillmentDecision = providerEventAllowsFulfillment(providerEvent.event_type, providerPaymentSession.provider_status)
      ? FULFILLMENT_DECISIONS.ALLOW_FULFILLMENT
      : (["failed", "voided"].includes(providerEvent.event_type) ? FULFILLMENT_DECISIONS.HOLD : null);
    const paymentSessionStatus = providerEvent.event_type === "failed"
      ? PAYMENT_SESSION_STATUSES.FAILED
      : (providerEvent.event_type === "voided"
        ? PAYMENT_SESSION_STATUSES.CANCELLED
        : (providerEvent.event_type === "settlement_reported"
          ? PAYMENT_SESSION_STATUSES.SETTLEMENT_PENDING
          : (providerEventAllowsFulfillment(providerEvent.event_type, providerPaymentSession.provider_status)
            ? PAYMENT_SESSION_STATUSES.ACCEPTED
            : ensured.paymentSession.status)));
    const paymentSession = updatePaymentSessionState(ensured.paymentSession.id, paymentSessionStatus, fulfillmentDecision);

    db.prepare(
      `INSERT INTO provider_payment_events
       (id, provider_code, provider_event_id, provider_payment_id, provider_session_id, event_type, provider_status, amount_jpyc_base,
        occurred_at, received_at, signature_verified, idempotency_key, payload_hash, payload_schema_version, tx_hash, batch_reference,
        provider_settlement_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'provider_event_v1', ?, ?, ?, ?)`
    ).run(
      uuid(),
      providerEvent.provider_code,
      providerEvent.provider_event_id,
      providerEvent.provider_payment_id || null,
      providerEvent.provider_session_id || null,
      providerEvent.event_type,
      providerEvent.provider_status || null,
      providerEvent.amount_jpyc_base != null ? toIntegerAmount(providerEvent.amount_jpyc_base, null) : null,
      providerEvent.occurred_at,
      nowIso(),
      idempotencyKey || null,
      payloadHash,
      providerEvent.tx_hash || null,
      providerEvent.batch_reference || null,
      providerEvent.provider_settlement_id || null,
      nowIso()
    );

    let invoiceAfter = invoice;
    if (!amountMatches) {
      const transition = applyProviderInvoiceTransition(invoice, { nextStatus: "review_required", reason: "provider_amount_mismatch" });
      invoiceAfter = transition.invoice || invoice;
      upsertReviewCase(invoiceAfter, REVIEW_REASON_CODES.OTHER, {
        txHash: providerEvent.tx_hash,
        eventAmountBase: providerEvent.amount_jpyc_base || invoice.amount_jpyc_base,
        blockTimestamp: providerEvent.occurred_at,
        detectedAt: nowIso(),
        auditRef: providerEvent.provider_event_id,
      });
      audit({
        actorType: "service",
        actorId,
        action: "provider_amount_mismatch",
        targetType: "invoice",
        targetId: invoice.id,
        requestId,
        idempotencyKey,
        beforeState: invoice,
        afterState: invoiceAfter,
        ip,
      });
    } else {
      const nextTransition = determineProviderTransition(invoice, {
        eventType: providerEvent.event_type,
        txHash: providerEvent.tx_hash,
        amountMatches,
      });
      const transition = applyProviderInvoiceTransition(invoice, nextTransition);
      if (transition.error) {
        return {
          status: 409,
          body: { error: { code: "INVALID_STATE_TRANSITION", message: "invalid provider event transition", details: transition } },
        };
      }
      invoiceAfter = transition.invoice || invoice;
    }

    if (providerEvent.tx_hash) {
      createReconciliationLink({
        invoiceId: invoice.id,
        providerPaymentId: providerPaymentSession.provider_payment_id,
        blockchainTransferId: providerEvent.tx_hash,
        linkType: "direct_tx",
        amountBase: providerEvent.amount_jpyc_base || invoice.amount_jpyc_base,
        confidenceLevel: "provider_reported",
      });
    }
    if (providerEvent.event_type === "voided") {
      createReconciliationLink({
        invoiceId: invoice.id,
        providerPaymentId: providerPaymentSession.provider_payment_id,
        linkType: "void",
        amountBase: providerEvent.amount_jpyc_base || providerPaymentSession.provider_amount_jpyc_base || invoice.amount_jpyc_base,
        confidenceLevel: "provider_reported",
      });
      audit({
        actorType: "service",
        actorId,
        action: "provider_void_recorded",
        targetType: "invoice",
        targetId: invoice.id,
        requestId,
        idempotencyKey,
        afterState: { provider_payment_id: providerPaymentSession.provider_payment_id, provider_status: providerPaymentSession.provider_status },
        ip,
      });
    }

    const refreshed = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
    providerPaymentSession = db.prepare(`SELECT * FROM provider_payment_sessions WHERE id = ?`).get(providerPaymentSession.id);
    audit({
      actorType: "service",
      actorId,
      action: "provider_event_ingested",
      targetType: "invoice",
      targetId: invoice.id,
      requestId,
      idempotencyKey,
      beforeState: invoice,
      afterState: {
        invoice_status: refreshed.status,
        payment_session_status: paymentSession.status,
        provider_status: providerPaymentSession.provider_status,
        provider_event_id: providerEvent.provider_event_id,
      },
      ip,
    });
    return {
      status: 200,
      body: {
        duplicate: false,
        invoice_id: refreshed.id,
        invoice_status: refreshed.status,
        provider_status: providerPaymentSession.provider_status,
        payment_session_status: paymentSession.status,
        fulfillment_decision: paymentSession.fulfillment_decision,
      },
    };
  })();
  sendEvent(invoice.terminal_id, "invoice.updated", {
    invoiceId: invoice.id,
    status: result.body?.invoice_status || invoice.status,
    rail: PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL,
    provider_event_type: providerEvent.event_type,
    provider_status: result.body?.provider_status || providerEvent.provider_status || null,
    provider_payment_session_status: result.body?.payment_session_status || null,
  });
  return result;
}

function ingestProviderSettlementRecord({
  settlementInput,
  payloadHash,
  requestId,
  idempotencyKey,
  actorId,
  ip,
}) {
  const result = db.transaction(() => {
    const existing = db
      .prepare(`SELECT * FROM provider_settlements WHERE provider_code = ? AND provider_settlement_id = ?`)
      .get(settlementInput.provider_code, settlementInput.provider_settlement_id);
    let internalSettlementId = existing?.id || uuid();
    if (!existing) {
      db.prepare(
        `INSERT INTO provider_settlements
         (id, provider_code, provider_settlement_id, batch_reference, settlement_status, settlement_amount_jpyc_base,
          settlement_currency, reported_at, settled_at, payload_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        internalSettlementId,
        settlementInput.provider_code,
        settlementInput.provider_settlement_id,
        settlementInput.batch_reference || null,
        settlementInput.settlement_status,
        toIntegerAmount(settlementInput.settlement_amount_jpyc_base, 0),
        settlementInput.settlement_currency || "JPYC",
        settlementInput.reported_at || null,
        settlementInput.settled_at || null,
        payloadHash,
        nowIso(),
        nowIso()
      );
    }

    let allocationTotal = 0n;
    const affectedInvoices = new Set();
    let disputed = false;
    for (const allocation of settlementInput.allocations) {
      allocationTotal += BigInt(String(allocation.allocated_amount_jpyc_base));
      const providerSession = settlementInput.provider_code
        ? db
            .prepare(`SELECT * FROM provider_payment_sessions WHERE provider_code = ? AND provider_payment_id = ?`)
            .get(settlementInput.provider_code, allocation.provider_payment_id)
        : null;
      if (!providerSession && allocation.invoice_id) {
        disputed = true;
      }
      const invoice = allocation.invoice_id
        ? db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(allocation.invoice_id)
        : (providerSession
          ? db.prepare(`SELECT * FROM invoices WHERE id = (SELECT invoice_id FROM payment_sessions WHERE id = ?)`).get(providerSession.payment_session_id)
          : null);
      const matchedInvoiceId = allocation.invoice_id || invoice?.id || null;
      const allocationStatus = !invoice || !providerSession
        ? "disputed"
        : allocation.allocation_status;
      if (matchedInvoiceId) affectedInvoices.add(String(matchedInvoiceId));
      db.prepare(
        `INSERT INTO provider_settlement_allocations
         (id, provider_settlement_id, provider_payment_id, invoice_id, allocated_amount_jpyc_base, allocation_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        internalSettlementId,
        allocation.provider_payment_id,
        matchedInvoiceId,
        toIntegerAmount(allocation.allocated_amount_jpyc_base, 0),
        allocationStatus,
        nowIso(),
        nowIso()
      );
      createReconciliationLink({
        invoiceId: matchedInvoiceId,
        providerPaymentId: allocation.provider_payment_id,
        providerSettlementId: internalSettlementId,
        blockchainTransferId: settlementInput.tx_hash || settlementInput.batch_reference || settlementInput.provider_settlement_id,
        linkType: "batch_allocation",
        amountBase: allocation.allocated_amount_jpyc_base,
        confidenceLevel: allocationStatus === "disputed" ? "disputed" : "provider_reported",
      });
      if (providerSession) {
        updateProviderPaymentSessionState(providerSession.id, {
          providerStatus: settlementInput.settlement_status === "confirmed" ? "settled" : "settlement_pending",
          payloadHash,
        });
        updatePaymentSessionState(
          providerSession.payment_session_id,
          settlementInput.settlement_status === "confirmed" ? PAYMENT_SESSION_STATUSES.SETTLED : PAYMENT_SESSION_STATUSES.SETTLEMENT_PENDING
        );
      }
      if (invoice && allocationStatus === "disputed" && String(invoice.status) !== "review_required") {
        const transition = transitionInvoiceForPayment(invoice, "review_required", "provider_settlement_allocation_mismatch", {
          actorType: "service",
          actorId,
          requestId,
          idempotencyKey,
          ip,
          reason: "provider_settlement_allocation_mismatch",
        });
        if (transition.invoice) disputed = true;
      }
    }

    if (allocationTotal !== BigInt(String(settlementInput.settlement_amount_jpyc_base))) {
      disputed = true;
    }

    if (disputed) {
      db.prepare(`UPDATE provider_settlements SET settlement_status = 'disputed', updated_at = ? WHERE id = ?`).run(nowIso(), internalSettlementId);
    }

    audit({
      actorType: "service",
      actorId,
      action: "provider_settlement_reported",
      targetType: "provider_settlement",
      targetId: internalSettlementId,
      requestId,
      idempotencyKey,
      afterState: {
        provider_code: settlementInput.provider_code,
        provider_settlement_id: settlementInput.provider_settlement_id,
        disputed,
      },
      ip,
    });

    return {
      status: 200,
      body: {
        provider_settlement_id: settlementInput.provider_settlement_id,
        disputed,
        allocation_count: settlementInput.allocations.length,
        affected_invoice_ids: [...affectedInvoices],
      },
    };
  })();
  for (const invoiceId of result.body?.affected_invoice_ids || []) {
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId);
    if (!invoice?.terminal_id) continue;
    sendEvent(invoice.terminal_id, "invoice.updated", {
      invoiceId: invoice.id,
      status: invoice.status,
      rail: PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL,
      provider_event_type: "settlement_reported",
      provider_payment_session_status: getLatestProviderRailSessionBundle(invoice)?.paymentSession?.status || null,
    });
  }
  return result;
}

function processPaymentEvent({
  invoice,
  event,
  requestId,
  idempotencyKey,
  actorType,
  actorId,
  action,
  ip
}) {
  const parsedAmountBaseResult = event.amount_jpyc_base != null
    ? parsePositiveBaseUnitInteger(String(event.amount_jpyc_base), "amount_jpyc_base")
    : toBaseUnits(event.amount_jpyc);
  if (parsedAmountBaseResult.error) {
    return {
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid amount_jpyc for base unit conversion" } }
    };
  }
  const parsedAmountBase = parsedAmountBaseResult.value;
	  const parsedAmountDisplay = Number(formatJpyc(parsedAmountBase));
	  const parsedConfirmations = Number(event.confirmations || 0);
	  const source = String(event.source || "unknown");
	  const requiresBlockTimestamp =
	    source === "chain_monitor"
	    || (source === "manual_ingest" && event.verified_onchain === true)
	    || (IS_PRODUCTION && source !== "dev_simulation");
	  const decision = db.transaction(() => {
    const peId = uuid();
    const paymentAttemptId = uuid();
    try {
      db.prepare(
        `INSERT INTO payment_events
        (id, invoice_id, event_type, chain_id, tx_hash, log_index, block_number, confirmations, from_address, to_address, token_contract, amount_jpyc, amount_jpyc_base, observed_at, block_timestamp, detected_at, raw_payload, created_at)
        VALUES (?, ?, 'tx_detected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        peId,
        invoice.id,
        String(event.chain_id),
        String(event.tx_hash),
        event.log_index ?? null,
        event.block_number ?? null,
        parsedConfirmations,
          event.from_address || null,
          String(event.to_address),
          String(event.token_contract),
          Number.isFinite(parsedAmountDisplay) ? parsedAmountDisplay : 0,
          parsedAmountBase,
          String(event.observed_at || nowIso()),
          event.block_timestamp || null,
          nowIso(),
          JSON.stringify(event),
          nowIso()
        );
      db.prepare(
        `INSERT OR IGNORE INTO payment_attempts(id, invoice_id, chain_id, tx_hash, log_index, status, source, verified_onchain, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        paymentAttemptId,
        invoice.id,
        String(event.chain_id),
        String(event.tx_hash),
        event.log_index ?? null,
        "observed",
        String(event.source || "unknown"),
        event.verified_onchain ? 1 : 0,
        JSON.stringify(event),
        nowIso()
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        recordSuspiciousActivity({
          storeId: invoice.store_id,
          invoiceId: invoice.id,
          reason: "duplicate_payment_event",
          payload: { tx_hash: event.tx_hash, log_index: event.log_index ?? null },
        });
        const latest = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
        return {
          status: 200,
          body: {
            invoice_id: invoice.id,
            decision: "ignored_duplicate",
            status: latest.status,
            review_required: latest.status === "review_required",
            tx_hash: event.tx_hash,
            payment_attempt_id: null,
            event_id: null,
          }
        };
      }
      throw error;
    }

	    const outcome = decidePaymentStatus(invoice, event, {
	      nowMs: event?.block_timestamp ? new Date(event.block_timestamp).getTime() : undefined,
	      requireBlockTimestamp: requiresBlockTimestamp,
	      previousPaidAmountBase: invoice.paid_amount_jpyc_base,
	    });
	    if (source === "provider_external" && outcome.nextStatus === "paid") {
	      outcome.nextStatus = "review_required";
	      outcome.reasonType = REVIEW_REASON_CODES.OTHER;
	      outcome.reasonLabel = "provider_external_not_onchain_cash";
	    }
	    if (isPaymentsDisabled() && outcome.nextStatus === "paid") {
      outcome.nextStatus = "review_required";
      outcome.reasonType = "payments_disabled";
      outcome.reasonLabel = "payments_disabled";
    }
    const update = transitionInvoiceForPayment(invoice, outcome.nextStatus, outcome.reasonLabel, {
      actorType,
      actorId,
      requestId,
      idempotencyKey,
      ip,
      reason: outcome.reasonLabel || "payment_event_transition",
    });
    if (update.error) {
      return {
        status: 409,
        body: { error: { code: "INVALID_STATE_TRANSITION", message: "Invalid transition during payment processing", details: update } }
      };
    }

    if (outcome.nextStatus === "review_required") {
      upsertReviewCase(update.invoice, outcome.reasonType || REVIEW_REASON_CODES.OTHER, {
        txHash: event.tx_hash,
        eventAmountBase: parsedAmountBase,
        blockTimestamp: event.block_timestamp || null,
        detectedAt: nowIso(),
      });
      recordSuspiciousActivity({
        storeId: invoice.store_id,
        invoiceId: invoice.id,
        reason: `payment_review_${normalizeReviewReasonCode(outcome.reasonType || REVIEW_REASON_CODES.OTHER).toLowerCase()}`,
        payload: {
          tx_hash: event.tx_hash,
          amount_jpyc_base: parsedAmountBase,
          reason_code: normalizeReviewReasonCode(outcome.reasonType || REVIEW_REASON_CODES.OTHER),
        },
      });
    }

    db.prepare(`UPDATE invoices SET paid_amount_jpyc = ?, paid_amount_jpyc_base = ?, paid_tx_hash = ?, updated_at = ? WHERE id = ?`).run(
      Number.isFinite(parsedAmountDisplay) ? parsedAmountDisplay : 0,
      parsedAmountBase,
      event.tx_hash,
      nowIso(),
      invoice.id
    );
    const refreshed = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
    logCorrelationEvent("payment.processed", refreshed, {
      payment_attempt_id: paymentAttemptId,
      event_id: peId,
      tx_hash: event.tx_hash,
      log_index: event.log_index ?? null,
      status: refreshed.status,
      status_version: refreshed.updated_at,
      terminal_id: refreshed.terminal_id,
      store_id: refreshed.store_id,
      details: {
        source: event.source || "unknown",
        verified_onchain: event.verified_onchain === true,
        reason_type: outcome.reasonType || null,
        confirmations: parsedConfirmations,
      },
    });
    audit({
      actorType,
      actorId,
      action,
      targetType: "invoice",
      targetId: invoice.id,
      requestId,
      idempotencyKey,
      beforeState: invoice,
      afterState: refreshed,
      ip
    });

    return {
      status: 200,
      body: {
        invoice_id: invoice.id,
        decision: outcome.nextStatus,
        status: refreshed.status,
        review_required: outcome.nextStatus === "review_required",
        tx_hash: event.tx_hash,
        payment_attempt_id: paymentAttemptId,
        event_id: peId,
      }
    };
  })();

  if (decision.body?.status) {
    sendEvent(invoice.terminal_id, "invoice.updated", { invoiceId: invoice.id, status: decision.body.status });
  }
  return decision;
}

function buildIngestEvent(payload) {
  const txHash = parseTxHash(payload?.tx_hash);
  const amount = payload?.amount_jpyc;
  const amountBaseParsed = payload?.amount_jpyc_base != null
    ? parsePositiveBaseUnitInteger(payload?.amount_jpyc_base, "amount_jpyc_base")
    : toBaseUnits(amount);
  const confirmations = Number(payload?.confirmations || 0);
  if (!payload?.invoice_id || !txHash || !payload?.chain_id || !payload?.token_contract || !payload?.to_address) {
    return { error: "Missing required fields for ingest" };
  }
  if (amountBaseParsed.error) return { error: "amount_jpyc is invalid" };
  if (BigInt(amountBaseParsed.value) <= 0n) return { error: "amount_jpyc must be > 0" };
  if (!Number.isFinite(confirmations) || confirmations < 0) {
    return { error: "confirmations must be >= 0" };
  }
  if (confirmations < REQUIRED_CONFIRMATIONS) {
    return { error: `confirmations must be >= REQUIRED_CONFIRMATIONS (${REQUIRED_CONFIRMATIONS})` };
  }
	  const source = String(payload?.source || "unknown");
	  const verifiedOnchain = payload?.verified_onchain === true || payload?.verified_onchain === "true";
	  const requiresBlockTimestamp =
	    source === "chain_monitor"
	    || (source === "manual_ingest" && verifiedOnchain)
	    || (IS_PRODUCTION && source !== "dev_simulation");
	  if (source === "dev_simulation" && IS_PRODUCTION) {
	    return { error: "dev_simulation fallback is not allowed in production" };
	  }
	  if (requiresBlockTimestamp && !payload?.block_timestamp) {
	    return { error: "block_timestamp is required for production-equivalent on-chain ingest" };
	  }
  return {
    event: {
      invoice_id: String(payload.invoice_id),
      chain_id: String(payload.chain_id),
      tx_hash: txHash,
      log_index: payload.log_index ?? null,
      block_number: payload.block_number ?? null,
      confirmations,
      from_address: payload.from_address || null,
      to_address: String(payload.to_address),
      token_contract: String(payload.token_contract),
      amount_jpyc: amount ?? formatJpyc(amountBaseParsed.value),
      amount_jpyc_base: amountBaseParsed.value,
	      observed_at: payload.observed_at || nowIso(),
	      block_timestamp: payload.block_timestamp || null,
	      source,
	      verified_onchain: verifiedOnchain,
	    }
	  };
	}

async function buildVerifiedManualIngestEvent(invoice, payload) {
  if (rpcProviders.length === 0) {
    return { error: { code: "RPC_UNAVAILABLE", message: "manual ingest verification requires RPC_URLS" } };
  }
  const verification = await verifyTransferOnChain({
    txHash: payload?.tx_hash,
    expectedTokenContract: APPROVED_TOKEN_CONTRACT,
    expectedToAddress: invoice.recipient_address,
    expectedAmountBase: String(invoice.amount_jpyc_base || "0"),
  });

  if (!verification.ok) {
    if (verification.code === "WRONG_AMOUNT" && verification.transfer) {
      if (verification.confirmations < REQUIRED_CONFIRMATIONS) {
        return {
          pending: true,
          error: {
            code: "CONFIRMATIONS_PENDING",
            message: `transaction has ${verification.confirmations} confirmations; ${REQUIRED_CONFIRMATIONS} required`,
          },
        };
      }
      return {
        event: {
          invoice_id: invoice.id,
          chain_id: CHAIN_ID,
          tx_hash: parseTxHash(payload?.tx_hash),
          log_index: verification.transfer.logIndex,
          block_number: verification.transfer.blockNumber,
          confirmations: verification.confirmations,
          from_address: verification.transfer.from,
          to_address: verification.transfer.to,
          token_contract: APPROVED_TOKEN_CONTRACT,
          amount_jpyc: formatJpyc(verification.transfer.amountBase),
          amount_jpyc_base: verification.transfer.amountBase,
          observed_at: verification.observedAt,
          block_timestamp: verification.blockTimestamp,
          source: "manual_ingest",
          verified_onchain: true,
        },
      };
    }
    return {
      error: {
        code: verification.code || "MANUAL_INGEST_REJECTED",
        message: verification.message || "manual ingest verification failed",
      },
    };
  }

  if (verification.confirmations < REQUIRED_CONFIRMATIONS) {
    return {
      pending: true,
      error: {
        code: "CONFIRMATIONS_PENDING",
        message: `transaction has ${verification.confirmations} confirmations; ${REQUIRED_CONFIRMATIONS} required`,
      },
    };
  }

  return {
    event: {
      invoice_id: invoice.id,
      chain_id: CHAIN_ID,
      tx_hash: parseTxHash(payload?.tx_hash),
      log_index: verification.transfer.logIndex,
      block_number: verification.transfer.blockNumber,
      confirmations: verification.confirmations,
      from_address: verification.transfer.from,
      to_address: verification.transfer.to,
      token_contract: APPROVED_TOKEN_CONTRACT,
      amount_jpyc: formatJpyc(verification.transfer.amountBase),
      amount_jpyc_base: verification.transfer.amountBase,
      observed_at: verification.observedAt,
      block_timestamp: verification.blockTimestamp,
      source: "manual_ingest",
      verified_onchain: true,
    },
  };
}

function ingestPaymentForInvoice({
  storeId,
  event,
  requestId,
  idempotencyKey,
  actorType,
  actorId,
  action,
  ip
}) {
  const invoice = storeId
    ? db.prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ?`).get(event.invoice_id, storeId)
    : db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(event.invoice_id);
  if (!invoice) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
  return processPaymentEvent({
    invoice,
    event,
    requestId,
    idempotencyKey,
    actorType,
    actorId,
    action,
    ip
  });
}

function computeRefundEligibilityBase(review, invoice) {
  const paidBase = BigInt(String(invoice?.paid_amount_jpyc_base || "0"));
  const billedBase = BigInt(String(invoice?.amount_jpyc_base || "0"));
  const reasonType = normalizeReviewReasonCode(review?.reason_type || REVIEW_REASON_CODES.OTHER);

  if (reasonType === REVIEW_REASON_CODES.OVERPAYMENT) {
    return paidBase > billedBase ? (paidBase - billedBase).toString() : "0";
  }
  if (reasonType === REVIEW_REASON_CODES.DUPLICATE_PAYMENT) {
    return paidBase > 0n ? paidBase.toString() : "0";
  }
  if (reasonType === REVIEW_REASON_CODES.LATE_PAYMENT) {
    return paidBase.toString();
  }
  if (
    reasonType === REVIEW_REASON_CODES.UNKNOWN_TRANSFER
    || reasonType === REVIEW_REASON_CODES.ADDRESS_MISMATCH
    || reasonType === REVIEW_REASON_CODES.CHAIN_INCONSISTENT
  ) {
    return paidBase > 0n ? paidBase.toString() : "0";
  }
  if (reasonType === REVIEW_REASON_CODES.UNDERPAYMENT || reasonType === REVIEW_REASON_CODES.SPLIT_PAYMENT) {
    return "0";
  }
  return "0";
}

const refundExecutors = {
  manual: ({ payload }) => {
    const txHash = parseTxHash(payload?.refund_tx_hash);
    if (!txHash) {
      return {
        error: {
          code: "VALIDATION_ERROR",
          message: "refund_tx_hash is required and must be a 0x-prefixed 32-byte hash for manual executor"
        }
      };
    }
    return {
      status: "recorded",
      refundTxHash: txHash,
      executionRef: txHash,
      failureReason: null
    };
  },
  external_signer: ({ payload }) => {
    const executionRef = String(payload?.execution_ref || "").trim();
    if (!executionRef) {
      return { error: { code: "VALIDATION_ERROR", message: "execution_ref is required for external_signer" } };
    }
    return {
      status: "pending_verification",
      refundTxHash: parseTxHash(payload?.refund_tx_hash),
      executionRef,
      failureReason: null
    };
  },
  custody_provider: ({ payload }) => {
    const executionRef = String(payload?.execution_ref || "").trim();
    if (!executionRef) {
      return { error: { code: "VALIDATION_ERROR", message: "execution_ref is required for custody_provider" } };
    }
    return {
      status: "pending_verification",
      refundTxHash: parseTxHash(payload?.refund_tx_hash),
      executionRef,
      failureReason: null
    };
  }
};

async function verifyRefundExecutionOnChain(refund, txHashOverride = null) {
  const txHash = parseTxHash(txHashOverride || refund.refund_tx_hash);
  if (!txHash) {
    return { error: { code: "INVALID_TX_HASH", message: "refund_tx_hash is required for verification" } };
  }
  const verification = await verifyTransferOnChain({
    txHash,
    expectedTokenContract: APPROVED_TOKEN_CONTRACT,
    expectedToAddress: refund.refund_to_address,
    expectedFromAddress: refund.expected_from_address || null,
    expectedAmountBase: refund.refund_amount_jpyc_base,
  });
  if (!verification.ok) {
    if (verification.code === "WRONG_AMOUNT" || verification.code === "WRONG_FROM_ADDRESS" || verification.code === "WRONG_RECIPIENT") {
      return {
        status: "verification_failed",
        refundTxHash: txHash,
        refundTxLogIndex: verification.transfer?.logIndex ?? null,
        failureReason: verification.code,
        fromAddress: verification.transfer?.from || null,
        toAddress: verification.transfer?.to || refund.refund_to_address || null,
        chainId: String(refund.refund_chain_id || CHAIN_ID),
        tokenContract: String(refund.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT || ""),
        blockNumber: verification.transfer?.blockNumber ?? null,
        blockTimestamp: verification.blockTimestamp || null,
        detectedAt: nowIso(),
      };
    }
    if (verification.code === "TX_NOT_FOUND" || verification.code === "TX_REVERTED" || verification.code === "WRONG_TOKEN" || verification.code === "WRONG_CHAIN") {
      return {
        status: "verification_failed",
        refundTxHash: txHash,
        refundTxLogIndex: verification.transfer?.logIndex ?? null,
        failureReason: verification.code,
        fromAddress: verification.transfer?.from || null,
        toAddress: verification.transfer?.to || refund.refund_to_address || null,
        chainId: String(refund.refund_chain_id || CHAIN_ID),
        tokenContract: String(refund.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT || ""),
        blockNumber: verification.transfer?.blockNumber ?? null,
        blockTimestamp: verification.blockTimestamp || null,
        detectedAt: nowIso(),
      };
    }
    return { error: { code: verification.code || "REFUND_VERIFICATION_FAILED", message: verification.message || "refund verification failed" } };
  }
  if (verification.confirmations < REQUIRED_CONFIRMATIONS) {
    return {
      status: "pending_verification",
      refundTxHash: txHash,
      refundTxLogIndex: verification.transfer.logIndex,
      failureReason: `confirmations_pending:${verification.confirmations}/${REQUIRED_CONFIRMATIONS}`,
      fromAddress: verification.transfer?.from || null,
      toAddress: verification.transfer?.to || refund.refund_to_address || null,
      chainId: String(refund.refund_chain_id || CHAIN_ID),
      tokenContract: String(refund.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT || ""),
      blockNumber: verification.transfer?.blockNumber ?? null,
      blockTimestamp: verification.blockTimestamp || null,
      detectedAt: nowIso(),
    };
  }
  if (!verification.blockTimestamp) {
    return {
      status: "pending_verification",
      refundTxHash: txHash,
      refundTxLogIndex: verification.transfer.logIndex,
      failureReason: "missing_block_timestamp",
      fromAddress: verification.transfer?.from || null,
      toAddress: verification.transfer?.to || refund.refund_to_address || null,
      chainId: String(refund.refund_chain_id || CHAIN_ID),
      tokenContract: String(refund.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT || ""),
      blockNumber: verification.transfer?.blockNumber ?? null,
      blockTimestamp: null,
      detectedAt: nowIso(),
    };
  }
  return {
    status: "succeeded",
    refundTxHash: txHash,
    refundTxLogIndex: verification.transfer.logIndex,
    failureReason: null,
    verifiedAt: verification.observedAt,
    fromAddress: verification.transfer?.from || null,
    toAddress: verification.transfer?.to || refund.refund_to_address || null,
    chainId: String(refund.refund_chain_id || CHAIN_ID),
    tokenContract: String(refund.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT || ""),
    blockNumber: verification.transfer?.blockNumber ?? null,
    blockTimestamp: verification.blockTimestamp || null,
    detectedAt: nowIso(),
  };
}

function ensureSeedData() {
  const now = nowIso();
  const merchant = db.prepare(`SELECT * FROM merchants WHERE id = 'merchant-001'`).get();
  if (!merchant) {
    db.prepare(
      `INSERT INTO merchants (id, name, status, created_at, updated_at)
       VALUES ('merchant-001', 'JPYC Default Merchant', 'active', ?, ?)`
    ).run(now, now);
  } else {
    db.prepare(`UPDATE merchants SET updated_at = ? WHERE id = 'merchant-001'`).run(now);
  }

  const store = db.prepare(`SELECT * FROM stores WHERE id = 'store-001'`).get();
  if (!store) {
    db.prepare(
      `INSERT INTO stores
      (id, merchant_id, name, status, timezone, admin_contact, invoice_ttl_sec, chain_id, token_contract, settlement_unresolved_review_policy, created_at, updated_at)
      VALUES ('store-001', 'merchant-001', 'JPYC Store Alpha', 'active', 'Asia/Tokyo', '+81-3-1234-5678', 300, ?, ?, ?, ?, ?)`
    ).run(CHAIN_ID, TOKEN_CONTRACT, resolveSettlementUnresolvedReviewPolicy(null), now, now);
  } else {
    db.prepare(
      `UPDATE stores
       SET merchant_id = 'merchant-001',
           token_contract = ?,
           chain_id = ?,
           settlement_unresolved_review_policy = COALESCE(settlement_unresolved_review_policy, ?),
           updated_at = ?
       WHERE id = 'store-001'`
    ).run(TOKEN_CONTRACT, CHAIN_ID, resolveSettlementUnresolvedReviewPolicy(null), now);
  }

  if (!IS_PRODUCTION) {
    const terminal = db.prepare(`SELECT * FROM terminals WHERE id = 'terminal-001'`).get();
    if (!terminal) {
      db.prepare(
        `INSERT INTO terminals
        (id, merchant_id, store_id, terminal_code, status, created_at, updated_at)
        VALUES ('terminal-001', 'merchant-001', 'store-001', ?, 'active', ?, ?)`
      ).run(TERMINAL_CODE, now, now);
    } else if (terminal.terminal_code !== TERMINAL_CODE) {
      db.prepare(`UPDATE terminals SET merchant_id = 'merchant-001', terminal_code = ?, updated_at = ? WHERE id = 'terminal-001'`).run(
        TERMINAL_CODE,
        now
      );
    } else {
      db.prepare(`UPDATE terminals SET merchant_id = 'merchant-001', updated_at = ? WHERE id = 'terminal-001'`).run(now);
    }

    const staff = db.prepare(`SELECT * FROM staff_users WHERE id = 'staff-001'`).get();
    if (!staff) {
      db.prepare(
        `INSERT INTO staff_users
        (id, merchant_id, store_id, staff_name, role, pin_hash, status, created_at, updated_at)
        VALUES ('staff-001', 'merchant-001', 'store-001', 'Demo Staff', 'admin', ?, 'active', ?, ?)`
      ).run(hashPin(STAFF_PIN), now, now);
    } else if (!verifyPin(STAFF_PIN, staff.pin_hash)) {
      db.prepare(`UPDATE staff_users SET merchant_id = 'merchant-001', pin_hash = ?, updated_at = ? WHERE id = 'staff-001'`).run(
        hashPin(STAFF_PIN),
        now
      );
    } else {
      db.prepare(`UPDATE staff_users SET merchant_id = 'merchant-001', updated_at = ? WHERE id = 'staff-001'`).run(now);
    }

    if (SECOND_ADMIN_PIN) {
      const secondAdmin = db.prepare(`SELECT * FROM staff_users WHERE id = 'staff-002'`).get();
      if (!secondAdmin) {
        db.prepare(
          `INSERT INTO staff_users
          (id, merchant_id, store_id, staff_name, role, pin_hash, status, created_at, updated_at)
          VALUES ('staff-002', 'merchant-001', 'store-001', 'Demo Approver', 'admin', ?, 'active', ?, ?)`
        ).run(hashPin(SECOND_ADMIN_PIN), now, now);
      } else if (!verifyPin(SECOND_ADMIN_PIN, secondAdmin.pin_hash)) {
        db.prepare(`UPDATE staff_users SET merchant_id = 'merchant-001', pin_hash = ?, updated_at = ? WHERE id = 'staff-002'`).run(
          hashPin(SECOND_ADMIN_PIN),
          now
        );
      } else {
        db.prepare(`UPDATE staff_users SET merchant_id = 'merchant-001', updated_at = ? WHERE id = 'staff-002'`).run(now);
      }
    }
    return;
  }

  const activeAdminCount = Number(
    db.prepare(`SELECT COUNT(*) AS count FROM staff_users WHERE store_id = 'store-001' AND status = 'active' AND role = 'admin'`).get()?.count || 0
  );
  const activeTerminalCount = Number(
    db.prepare(`SELECT COUNT(*) AS count FROM terminals WHERE store_id = 'store-001' AND status = 'active'`).get()?.count || 0
  );

  if (activeAdminCount === 0 || activeTerminalCount === 0) {
    if (!BOOTSTRAP_ADMIN_PIN || !/^\d{4,8}$/.test(BOOTSTRAP_ADMIN_PIN) || BOOTSTRAP_ADMIN_PIN === "1234") {
      console.error("FATAL: production bootstrap requires non-default BOOTSTRAP_ADMIN_PIN when no active admin exists.");
      process.exit(1);
    }
    if (!BOOTSTRAP_TERMINAL_CODE || BOOTSTRAP_TERMINAL_CODE === "TERM-001") {
      console.error("FATAL: production bootstrap requires non-default BOOTSTRAP_TERMINAL_CODE when no active terminal exists.");
      process.exit(1);
    }
    db.transaction(() => {
      if (activeTerminalCount === 0) {
        db.prepare(
          `INSERT INTO terminals (id, merchant_id, store_id, terminal_code, status, created_at, updated_at)
           VALUES ('terminal-bootstrap', 'merchant-001', 'store-001', ?, 'active', ?, ?)`
        ).run(BOOTSTRAP_TERMINAL_CODE, now, now);
      }
      if (activeAdminCount === 0) {
        db.prepare(
          `INSERT INTO staff_users (id, merchant_id, store_id, staff_name, role, pin_hash, status, created_at, updated_at)
           VALUES ('staff-bootstrap', 'merchant-001', 'store-001', 'Bootstrap Admin', 'admin', ?, 'active', ?, ?)`
        ).run(hashPin(BOOTSTRAP_ADMIN_PIN), now, now);
      }
    })();
    audit({
      actorType: "system",
      actorId: "bootstrap",
      action: "production.bootstrap_seeded",
      targetType: "settings",
      targetId: "store-001",
      afterState: {
        bootstrapped_admin: activeAdminCount === 0,
        bootstrapped_terminal: activeTerminalCount === 0,
      },
    });
  }

  const adminAfter = Number(
    db.prepare(`SELECT COUNT(*) AS count FROM staff_users WHERE store_id = 'store-001' AND status = 'active' AND role = 'admin'`).get()?.count || 0
  );
  if (adminAfter < 1) {
    console.error("FATAL: production requires at least one active admin.");
    process.exit(1);
  }
}
ensureSeedData();
backfillTerminalPublicEntryTokens();
console.info(
  JSON.stringify({
    ts: nowIso(),
    level: "info",
    type: "startup.approval_summary",
    app_env: APP_ENV,
    legal_gate_approved: LEGAL_GATE_APPROVED,
    aml_policy_approved: AML_POLICY_APPROVED,
    privacy_policy_approved: PRIVACY_POLICY_APPROVED,
    appi_policy_approved: APPI_POLICY_APPROVED,
    jpyc_contract_ref_configured: !isPlaceholderLike(JPYC_CONTRACT_APPROVAL_REF),
    confirmations_policy_ref_configured: !isPlaceholderLike(CONFIRMATIONS_POLICY_APPROVAL_REF),
    backscan_policy_ref_configured: !isPlaceholderLike(BACKSCAN_POLICY_APPROVAL_REF),
  })
);

function runInvoiceExpirySweepOnce() {
  const now = nowIso();
  const candidates = db
    .prepare(
      `SELECT * FROM invoices
       WHERE status IN ('issued', 'payment_detected', 'confirming')
         AND expires_at < ?`
    )
    .all(now);
  let updated = 0;
  for (const invoice of candidates) {
    const paymentEvidence = db
      .prepare(`SELECT COUNT(*) AS count FROM payment_events WHERE invoice_id = ?`)
      .get(invoice.id);
    const hasPaymentEvidence = invoice.status !== "issued" || Number(paymentEvidence?.count || 0) > 0 || !!invoice.paid_tx_hash;
    const nextStatus = hasPaymentEvidence ? "review_required" : "expired";
    const reason = hasPaymentEvidence ? "late_arrival_after_expiry" : "expired_timeout";
    const update = hasPaymentEvidence
      ? transitionInvoiceForPayment(invoice, "review_required", reason, {
        actorType: "system",
        actorId: "invoice.expiry_sweeper",
        reason,
      })
      : updateInvoiceStatus(invoice.id, "expired", reason, {
        actorType: "system",
        actorId: "invoice.expiry_sweeper",
        reason,
      });
    if (update.error || !update.invoice || update.invoice.status === invoice.status) continue;
    if (nextStatus === "review_required") {
      upsertReviewCase(update.invoice, REVIEW_REASON_CODES.LATE_PAYMENT, {
        txHash: update.invoice.paid_tx_hash || null,
        eventAmountBase: update.invoice.paid_amount_jpyc_base || "0",
        blockTimestamp: now,
        detectedAt: now,
      });
    }
    audit({
      actorType: "system",
      actorId: "invoice.expiry_sweeper",
      action: "invoice.auto_expired",
      targetType: "invoice",
      targetId: invoice.id,
      beforeState: invoice,
      afterState: update.invoice,
    });
    sendEvent(invoice.terminal_id, "invoice.updated", { invoiceId: invoice.id, status: update.invoice.status });
    updated += 1;
  }
  return { scanned: candidates.length, updated };
}

const expirySweepTimer = setInterval(() => {
  try {
    runInvoiceExpirySweepOnce();
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: nowIso(),
        level: "error",
        type: "invoice.expiry_sweep_failed",
        message: String(error.message || error),
      })
    );
  }
}, 60_000);
expirySweepTimer.unref();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY);

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"]
      }
    }
  })
);

const allowedOrigins = new Set(CORS_ALLOW_ORIGINS);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error("CORS origin rejected"));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-Id",
      "X-Service-Id",
      "X-Service-Timestamp",
      "X-Service-Signature",
      "X-Service-JTI"
    ]
  })
);

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const requestId = requestIdFromReq(req);
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  const started = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        ts: nowIso(),
        level: "info",
        type: "http.request",
        request_id: requestId,
        method: req.method,
        path: redactUrlForLogs(req.originalUrl || req.path),
        status: res.statusCode,
        duration_ms: Date.now() - started,
        ip: req.ip
      })
    );
  });
  next();
});

app.use((req, res, next) => {
  const noStorePaths = [
    "/terminal.html",
    "/terminal-entry.html",
    "/mobile.html",
    "/pay",
    "/t/",
    "/api/v1/public/",
    "/api/v1/audit-logs/export",
    "/api/v1/terminal-sessions",
    "/api/v1/invoices",
    "/api/v1/streams/",
  ];
  if (noStorePaths.some((prefix) => String(req.path || "").startsWith(prefix))) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.use("/public", express.static(path.join(CWD, "public")));
app.use(express.static(path.join(CWD, "public")));

app.get("/prototype.html", (_req, res) => {
  res.sendFile(path.join(CWD, "index.html"));
});

app.get("/", (_req, res) => {
  res.redirect("/terminal.html");
});

app.get("/pay", (req, res) => {
  const parsed = parseSignedPayRef(req.query.ref);
  if (!parsed || !parsed.invoiceId || !parsed.exp || !parsed.nonce || !parsed.sig) {
    return jsonError(res, 400, "INVALID_PAYMENT_REF", "Invalid payment reference");
  }
  const verified = verifySig(parsed.invoiceId, parsed.exp, parsed.nonce, parsed.sig);
  if (!verified.ok) {
    return jsonError(res, 401, "UNAUTHORIZED", "Invalid payment reference signature");
  }
  return res.redirect(
    `/mobile.html?invoiceId=${encodeURIComponent(parsed.invoiceId)}&exp=${encodeURIComponent(parsed.exp)}&nonce=${encodeURIComponent(
      parsed.nonce
    )}&sig=${encodeURIComponent(parsed.sig)}`
  );
});

app.get("/t/:publicEntryToken", (req, res) => {
  const entry = buildPublicTerminalEntryState(req.params.publicEntryToken);
  if (!entry) {
    return jsonError(res, 404, "NOT_FOUND", "Terminal entry not found");
  }
  if (entry.status === "ready" && entry.pay_url) {
    return res.redirect(entry.pay_url);
  }
  return res.redirect(`/terminal-entry.html?token=${encodeURIComponent(req.params.publicEntryToken)}`);
});

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "jpyc-terminal-production",
    now: nowIso()
  });
});

function collectRuntimeMetrics() {
  const dbOk = db.prepare(`SELECT 1 AS ok`).get()?.ok === 1;
  const reviewOpenCount = db.prepare(`SELECT COUNT(*) AS count FROM review_cases WHERE status IN ('open', 'in_progress')`).get().count;
  const unconfirmedTxCount = db.prepare(`SELECT COUNT(*) AS count FROM payment_events WHERE confirmations < ?`).get(REQUIRED_CONFIRMATIONS).count;
  const unmatchedCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_unmatched_events`).get().count;
  const deadLetterCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters`).get().count;
  const deadLetterPendingCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE status = 'pending'`).get().count;
  const deadLetterAbandonedCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE status = 'abandoned'`).get().count;
  const rpcFailoverCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_rpc_failovers`).get().count;
  const addressPoolAvailableCount = db.prepare(`SELECT COUNT(*) AS count FROM receive_addresses WHERE status = 'available'`).get().count;
  const issuedInvoiceCount = db.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE status = 'issued'`).get().count;
  const expiredInvoiceCount = db.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE status = 'expired'`).get().count;
  const manualReviewCount = db.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE status = 'review_required'`).get().count;
  const workerLastCycle = db.prepare(`SELECT value, updated_at FROM chain_monitor_state WHERE key = 'worker:last_cycle_at'`).get();
  const workerLastCycleAt = workerLastCycle?.value || null;
  const workerStale =
    !!workerLastCycleAt && Date.now() - new Date(workerLastCycleAt).getTime() > WORKER_STALE_SEC * 1000;
  const auditStatus = verifyAuditChain();
  const replayGuardCount = db
    .prepare(`SELECT COUNT(*) AS count FROM service_replay_guards WHERE expires_at > ?`)
    .get(nowIso()).count;
  return {
    db_ok: dbOk,
    review_open_count: reviewOpenCount,
    unconfirmed_tx_count: unconfirmedTxCount,
    unmatched_event_count: unmatchedCount,
    dead_letter_count: deadLetterCount,
    pending_dead_letters: deadLetterPendingCount,
    abandoned_dead_letters: deadLetterAbandonedCount,
    rpc_failover_count: rpcFailoverCount,
    address_pool_available_count: addressPoolAvailableCount,
    issued_invoice_count: issuedInvoiceCount,
    expired_invoice_count: expiredInvoiceCount,
    manual_review_count: manualReviewCount,
    worker_last_cycle_at: workerLastCycleAt,
    worker_stale: workerStale,
    audit_chain: auditStatus,
    replay_guard_active_count: replayGuardCount
  };
}

function toPromBoolean(value) {
  return value ? 1 : 0;
}

function toUnixSeconds(isoValue) {
  const parsed = new Date(String(isoValue || "")).getTime();
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return 0;
  return Math.floor(parsed / 1000);
}

function requireMetricsAuth(req, res, next) {
  const auth = String(req.header("authorization") || "");
  if (!auth.startsWith("Bearer ")) {
    return jsonError(res, 401, "UNAUTHORIZED", "metrics auth required");
  }
  const token = auth.slice(7).trim();
  if (!token || token !== METRICS_SECRET) {
    return jsonError(res, 401, "UNAUTHORIZED", "invalid metrics credential");
  }
  return next();
}

function renderPrometheusMetrics(metrics) {
  const lines = [
    "# HELP jpyc_terminal_db_ok Database connectivity health (1=ok).",
    "# TYPE jpyc_terminal_db_ok gauge",
    `jpyc_terminal_db_ok ${toPromBoolean(metrics.db_ok)}`,
    "# HELP jpyc_terminal_review_open_count Open and in-progress review cases.",
    "# TYPE jpyc_terminal_review_open_count gauge",
    `jpyc_terminal_review_open_count ${Number(metrics.review_open_count || 0)}`,
    "# HELP jpyc_terminal_unconfirmed_tx_count Payment events below required confirmations.",
    "# TYPE jpyc_terminal_unconfirmed_tx_count gauge",
    `jpyc_terminal_unconfirmed_tx_count ${Number(metrics.unconfirmed_tx_count || 0)}`,
    "# HELP jpyc_terminal_unmatched_event_count Chain transfer events not matched to invoices.",
    "# TYPE jpyc_terminal_unmatched_event_count gauge",
    `jpyc_terminal_unmatched_event_count ${Number(metrics.unmatched_event_count || 0)}`,
    "# HELP jpyc_terminal_dead_letter_count Dead-lettered ingest events.",
    "# TYPE jpyc_terminal_dead_letter_count gauge",
    `jpyc_terminal_dead_letter_count ${Number(metrics.dead_letter_count || 0)}`,
    "# HELP jpyc_terminal_pending_dead_letters Pending dead letters.",
    "# TYPE jpyc_terminal_pending_dead_letters gauge",
    `jpyc_terminal_pending_dead_letters ${Number(metrics.pending_dead_letters || 0)}`,
    "# HELP jpyc_terminal_abandoned_dead_letters Abandoned dead letters.",
    "# TYPE jpyc_terminal_abandoned_dead_letters gauge",
    `jpyc_terminal_abandoned_dead_letters ${Number(metrics.abandoned_dead_letters || 0)}`,
    "# HELP jpyc_terminal_rpc_failover_count Recorded RPC failover events.",
    "# TYPE jpyc_terminal_rpc_failover_count gauge",
    `jpyc_terminal_rpc_failover_count ${Number(metrics.rpc_failover_count || 0)}`,
    "# HELP jpyc_terminal_address_pool_available_count Available receive addresses.",
    "# TYPE jpyc_terminal_address_pool_available_count gauge",
    `jpyc_terminal_address_pool_available_count ${Number(metrics.address_pool_available_count || 0)}`,
    "# HELP jpyc_terminal_manual_review_count Invoices currently in review_required state.",
    "# TYPE jpyc_terminal_manual_review_count gauge",
    `jpyc_terminal_manual_review_count ${Number(metrics.manual_review_count || 0)}`,
    "# HELP jpyc_terminal_expired_invoice_count Invoices currently in expired state.",
    "# TYPE jpyc_terminal_expired_invoice_count gauge",
    `jpyc_terminal_expired_invoice_count ${Number(metrics.expired_invoice_count || 0)}`,
    "# HELP jpyc_terminal_worker_stale Chain monitor stale indicator (1=stale).",
    "# TYPE jpyc_terminal_worker_stale gauge",
    `jpyc_terminal_worker_stale ${toPromBoolean(metrics.worker_stale)}`,
    "# HELP jpyc_terminal_worker_last_cycle_at_seconds Last chain monitor cycle timestamp.",
    "# TYPE jpyc_terminal_worker_last_cycle_at_seconds gauge",
    `jpyc_terminal_worker_last_cycle_at_seconds ${toUnixSeconds(metrics.worker_last_cycle_at)}`,
    "# HELP jpyc_terminal_audit_chain_ok Audit hash-chain verification status (1=ok).",
    "# TYPE jpyc_terminal_audit_chain_ok gauge",
    `jpyc_terminal_audit_chain_ok ${toPromBoolean(metrics.audit_chain?.ok)}`,
    "# HELP jpyc_terminal_audit_chain_total Audit log rows checked by hash-chain verification.",
    "# TYPE jpyc_terminal_audit_chain_total gauge",
    `jpyc_terminal_audit_chain_total ${Number(metrics.audit_chain?.total || 0)}`,
    "# HELP jpyc_terminal_replay_guard_active_count Active service replay guard rows.",
    "# TYPE jpyc_terminal_replay_guard_active_count gauge",
    `jpyc_terminal_replay_guard_active_count ${Number(metrics.replay_guard_active_count || 0)}`,
  ];
  return lines.join("\n") + "\n";
}

app.get("/readyz", requireMetricsAuth, (_req, res) => {
  const metrics = collectRuntimeMetrics();
  const baseReady = metrics.db_ok && metrics.audit_chain.ok && !!metrics.worker_last_cycle_at && !metrics.worker_stale;
  const commercial = evaluateCommercialRuntimeGate(metrics);
  const commercialReady = !commercial.commercial_go_mode || commercial.blockers.length === 0;
  const ready = baseReady && commercialReady;
  return res.status(ready ? 200 : 503).json({
    ok: ready,
    now: nowIso(),
    app_env: APP_ENV,
    payments_disabled: commercial.payments_disabled,
    commercial_go_mode: commercial.commercial_go_mode,
    legal_gate: commercial.legal_gate,
    aml_gate: commercial.aml_gate,
    privacy_gate: commercial.privacy_gate,
    appi_gate: commercial.appi_gate,
    jpyc_contract_gate: commercial.jpyc_contract_gate,
    confirmation_policy_gate: commercial.confirmation_policy_gate,
    backscan_policy_gate: commercial.backscan_policy_gate,
    wallet_evidence_gate: commercial.wallet_evidence_gate,
    real_payment_evidence_gate: commercial.real_payment_evidence_gate,
    tls_evidence_gate: commercial.tls_evidence_gate,
    store_ops_drill_gate: commercial.store_ops_drill_gate,
    audit_chain_gate: commercial.audit_chain_gate,
    settlement_policy_gate: commercial.settlement_policy_gate,
    refund_policy_gate: commercial.refund_policy_gate,
    dangerous_flags_gate: commercial.dangerous_flags_gate,
    commercial_verdict: commercial.commercial_verdict,
    blockers: commercial.blockers,
    checks: metrics,
    external_evidence: commercial.external_evidence,
    approvals: {
      legal_gate_approved: LEGAL_GATE_APPROVED,
      aml_policy_approved: AML_POLICY_APPROVED,
      privacy_policy_approved: PRIVACY_POLICY_APPROVED,
      appi_policy_approved: APPI_POLICY_APPROVED,
      jpyc_contract_ref_configured: !isPlaceholderLike(JPYC_CONTRACT_APPROVAL_REF),
      confirmations_policy_ref_configured: !isPlaceholderLike(CONFIRMATIONS_POLICY_APPROVAL_REF),
      backscan_policy_ref_configured: !isPlaceholderLike(BACKSCAN_POLICY_APPROVAL_REF),
    },
  });
});

app.get("/metrics", requireMetricsAuth, (_req, res) => {
  const metrics = collectRuntimeMetrics();
  const format = String(_req.query.format || "").toLowerCase();
  const accept = String(_req.header("accept") || "").toLowerCase();
  const wantsJson = format === "json" || accept.includes("application/json");
  if (wantsJson) {
    return res.json({
      service: "jpyc-terminal-production",
      now: nowIso(),
      metrics
    });
  }
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  return res.send(renderPrometheusMetrics(metrics));
});

app.post("/api/v1/terminal-sessions", (req, res) => {
  const requestId = requestIdFromReq(req);
  const { terminalCode, staffPin, staffName } = req.body || {};
  if (!terminalCode || !staffPin) {
    return jsonError(res, 400, "VALIDATION_ERROR", "terminalCode and staffPin are required");
  }
  if (!/^\d{4,8}$/.test(String(staffPin))) {
    return jsonError(res, 400, "VALIDATION_ERROR", "staffPin must be 4-8 digits");
  }
  if (isLoginRateLimited(`login:${req.ip}:${String(terminalCode)}`)) {
    return jsonError(res, 429, "RATE_LIMITED", "Too many login attempts. Please retry later.");
  }
  const lockout = getTerminalLockout(terminalCode);
  if (lockout?.locked_until && new Date(lockout.locked_until).getTime() > Date.now()) {
    return jsonError(res, 423, "PIN_LOCKED", "PIN lockout active", {
      terminal_code: String(terminalCode),
      locked_until: lockout.locked_until,
      failed_attempts: Number(lockout.failed_attempts || 0)
    });
  }

  const terminal = db.prepare(`SELECT * FROM terminals WHERE terminal_code = ? AND status = 'active'`).get(terminalCode);
  if (!terminal) return jsonError(res, 401, "UNAUTHORIZED", "Invalid terminal code");
  const candidateRows = staffName
    ? db.prepare(`SELECT * FROM staff_users WHERE store_id = ? AND status = 'active' AND staff_name = ?`).all(terminal.store_id, String(staffName))
    : db.prepare(`SELECT * FROM staff_users WHERE store_id = ? AND status = 'active'`).all(terminal.store_id);
  const staff = candidateRows.find((row) => verifyPin(String(staffPin), row.pin_hash));
  if (!staff) {
    const failure = registerPinFailure(terminalCode);
    return jsonError(res, 401, "UNAUTHORIZED", "Invalid staff PIN", {
      failed_attempts: failure.failedAttempts,
      locked_until: failure.lockedUntil
    });
  }
  clearPinFailures(terminalCode);
  if (!staff.pin_hash.startsWith("$2")) {
    db.prepare(`UPDATE staff_users SET pin_hash = ?, updated_at = ? WHERE id = ?`).run(hashPin(staffPin), nowIso(), staff.id);
  }

  const rawToken = `${uuid()}-${uuid()}`;
  const tokenHash = sha256(rawToken);
  const sid = uuid();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO terminal_sessions (id, terminal_id, staff_user_id, token_hash, started_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sid, terminal.id, staff.id, tokenHash, ts);
  const terminalWithPublicEntry = ensureTerminalPublicEntryToken(terminal.id);
  const currentInvoiceContext = resolveTerminalCurrentInvoiceContext(terminal.id, {
    repairPointer: true,
    actorType: "staff",
    actorId: staff.id,
    requestId,
    ip: req.ip,
  });
  const publicEntry = buildTerminalPublicEntryMeta(terminalWithPublicEntry || terminal);

  audit({
    actorType: "staff",
    actorId: staff.id,
    action: "session.started",
    targetType: "session",
    targetId: sid,
    requestId,
    ip: req.ip
  });

  return res.status(201).json({
    sessionId: sid,
    token: rawToken,
    terminalId: terminal.id,
    storeId: terminal.store_id,
    role: staff.role,
    ...publicEntry,
    current_invoice: summarizeInvoiceForTerminalState(currentInvoiceContext.currentInvoice),
    terminal_invariant_broken: currentInvoiceContext.invariantBroken === true,
    supported_wallets: getSupportedWallets(ENV),
    started_at: ts,
    session_ttl_sec: SESSION_TTL_SEC,
    diagnostic_mode_enabled: DIAGNOSTIC_MODE_ENABLED,
  });
});

app.post("/api/v1/internal/payments/events:ingest", requireServiceSignature, (req, res) => {
  const actorId = `svc:${req.serviceAuth.serviceId}`;
  return idempotent(req, res, "POST:/api/v1/internal/payments/events:ingest", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const parsed = buildIngestEvent(req.body || {});
    if (parsed.error) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: parsed.error } } };
    }
    return ingestPaymentForInvoice({
      storeId: null,
      event: parsed.event,
      requestId,
      idempotencyKey: idemKey,
      actorType: "service",
      actorId,
      action: "payment.ingested.internal",
      ip: req.ip
    });
  });
});

app.post("/api/v1/provider-rail/mock/events:ingest", requireServiceSignature, (req, res) => {
  if (!ENABLE_PROVIDER_RAIL_MOCK) {
    return jsonError(res, 403, "PROVIDER_RAIL_MOCK_DISABLED", "provider rail mock is disabled");
  }
  const actorId = `svc:${req.serviceAuth.serviceId}`;
  return idempotent(req, res, "POST:/api/v1/provider-rail/mock/events:ingest", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const parsed = parseProviderMockEventPayload(req.body || {});
    if (parsed.error) {
      if (parsed.error.code === "PRIVATE_PROVIDER_FIELD_NOT_ALLOWED") {
        audit({
          actorType: "service",
          actorId,
          action: "private_provider_payload_rejected",
          targetType: "provider_event",
          targetId: String(req.body?.provider_event_id || "unknown"),
          requestId,
          idempotencyKey: idemKey,
          afterState: { provider_code: req.body?.provider_code || PROVIDER_CODES.MOCK_PROVIDER, field: parsed.error.details?.field || null },
          ip: req.ip,
        });
      }
      return { status: 400, body: { error: parsed.error } };
    }
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(parsed.event.invoice_id);
    if (!invoice) {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
    }
    return ingestProviderEventRecord({
      invoice,
      providerEvent: parsed.event,
      payloadHash: parsed.payloadHash,
      requestId,
      idempotencyKey: idemKey,
      actorId,
      ip: req.ip,
    });
  });
});

app.post("/api/v1/provider-rail/mock/settlements:ingest", requireServiceSignature, (req, res) => {
  if (!ENABLE_PROVIDER_RAIL_MOCK) {
    return jsonError(res, 403, "PROVIDER_RAIL_MOCK_DISABLED", "provider rail mock is disabled");
  }
  const actorId = `svc:${req.serviceAuth.serviceId}`;
  return idempotent(req, res, "POST:/api/v1/provider-rail/mock/settlements:ingest", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const parsed = parseProviderMockSettlementPayload(req.body || {});
    if (parsed.error) {
      if (parsed.error.code === "PRIVATE_PROVIDER_FIELD_NOT_ALLOWED") {
        audit({
          actorType: "service",
          actorId,
          action: "private_provider_payload_rejected",
          targetType: "provider_settlement",
          targetId: String(req.body?.provider_settlement_id || "unknown"),
          requestId,
          idempotencyKey: idemKey,
          afterState: { provider_code: req.body?.provider_code || PROVIDER_CODES.MOCK_PROVIDER, field: parsed.error.details?.field || null },
          ip: req.ip,
        });
      }
      return { status: 400, body: { error: parsed.error } };
    }
    return ingestProviderSettlementRecord({
      settlementInput: parsed.settlement,
      payloadHash: parsed.payloadHash,
      requestId,
      idempotencyKey: idemKey,
      actorId,
      ip: req.ip,
    });
  });
});

app.use("/api/v1", requireSession);

app.get("/api/v1/staff", requirePermission("staff.manage"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, staff_name, role, status, permissions_override, created_at, updated_at
       FROM staff_users
       WHERE store_id = ?
       ORDER BY created_at DESC`
    )
    .all(req.session.store_id);
  return res.json({ staff: rows });
});

app.post("/api/v1/staff", requirePermission("staff.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/staff", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const staffName = String(req.body?.staff_name || "").trim();
    const role = String(req.body?.role || "staff");
    const pin = String(req.body?.pin || "");
    const status = String(req.body?.status || "active");
    const permissionsOverride = Array.isArray(req.body?.permissions_override) ? req.body.permissions_override : null;
    if (!staffName || !["staff", "operator", "manager", "accounting", "admin"].includes(role) || !/^\d{4,8}$/.test(pin) || !["active", "inactive"].includes(status)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Invalid staff payload" } } };
    }
    const id = uuid();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO staff_users(id, store_id, staff_name, role, pin_hash, status, permissions_override, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.session.store_id,
      staffName,
      role,
      hashPin(pin),
      status,
      permissionsOverride ? JSON.stringify(permissionsOverride.map((value) => String(value))) : null,
      ts,
      ts
    );
    const created = db.prepare(`SELECT id, staff_name, role, status, permissions_override, created_at, updated_at FROM staff_users WHERE id = ?`).get(id);
    audit({
      actorType: "admin",
      actorId,
      action: "staff.created",
      targetType: "staff",
      targetId: id,
      requestId,
      idempotencyKey: idemKey,
      afterState: created,
      ip: req.ip
    });
    return { status: 201, body: { staff: created } };
  });
});

app.patch("/api/v1/staff/:staffId", requirePermission("staff.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "PATCH:/api/v1/staff/:id", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const before = db
      .prepare(`SELECT * FROM staff_users WHERE id = ? AND store_id = ?`)
      .get(req.params.staffId, req.session.store_id);
    if (!before) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Staff not found" } } };

    const nextName = req.body?.staff_name != null ? String(req.body.staff_name).trim() : before.staff_name;
    const nextRole = req.body?.role != null ? String(req.body.role) : before.role;
    const nextStatus = req.body?.status != null ? String(req.body.status) : before.status;
    const nextOverride = Array.isArray(req.body?.permissions_override)
      ? JSON.stringify(req.body.permissions_override.map((value) => String(value)))
      : before.permissions_override;
    if (!nextName || !["staff", "operator", "manager", "accounting", "admin"].includes(nextRole) || !["active", "inactive"].includes(nextStatus)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Invalid staff update payload" } } };
    }
    db.prepare(
      `UPDATE staff_users
       SET staff_name = ?, role = ?, status = ?, permissions_override = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextName, nextRole, nextStatus, nextOverride, nowIso(), before.id);
    const after = db.prepare(`SELECT * FROM staff_users WHERE id = ?`).get(before.id);
    audit({
      actorType: "admin",
      actorId,
      action: "staff.updated",
      targetType: "staff",
      targetId: before.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip
    });
    return { status: 200, body: { staff: after } };
  });
});

app.post("/api/v1/staff/:staffId/pin:rotate", requirePermission("staff.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/staff/:id/pin:rotate", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const pin = String(req.body?.new_pin || "");
    if (!/^\d{4,8}$/.test(pin)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "new_pin must be 4-8 digits" } } };
    }
    const before = db
      .prepare(`SELECT * FROM staff_users WHERE id = ? AND store_id = ?`)
      .get(req.params.staffId, req.session.store_id);
    if (!before) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Staff not found" } } };
    db.prepare(`UPDATE staff_users SET pin_hash = ?, updated_at = ? WHERE id = ?`).run(hashPin(pin), nowIso(), before.id);
    const after = db.prepare(`SELECT * FROM staff_users WHERE id = ?`).get(before.id);
    audit({
      actorType: "admin",
      actorId,
      action: "staff.pin_rotated",
      targetType: "staff",
      targetId: before.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: { id: before.id, updated_at: before.updated_at },
      afterState: { id: after.id, updated_at: after.updated_at },
      ip: req.ip
    });
    return { status: 200, body: { staff_id: before.id, pin_rotated: true } };
  });
});

app.get("/api/v1/terminals", requirePermission("terminal.manage"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM terminal_sessions s WHERE s.terminal_id = t.id AND s.revoked_at IS NULL AND s.ended_at IS NULL) AS active_session_count
       FROM terminals t
       WHERE t.store_id = ?
       ORDER BY t.created_at DESC`
    )
    .all(req.session.store_id);
  return res.json({
    terminals: rows.map((row) => ({
      ...row,
      ...buildTerminalPublicEntryMeta(row),
    })),
  });
});

app.post("/api/v1/terminals", requirePermission("terminal.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/terminals", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const terminalCode = String(req.body?.terminal_code || "").trim();
    const status = String(req.body?.status || "active");
    if (!terminalCode || !["active", "inactive"].includes(status)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "terminal_code and valid status are required" } } };
    }
    const terminalId = uuid();
    const ts = nowIso();
    const publicEntryToken = generateTerminalPublicEntryToken();
    db.prepare(
      `INSERT INTO terminals(id, store_id, terminal_code, public_entry_token, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(terminalId, req.session.store_id, terminalCode, publicEntryToken, status, ts, ts);
    const created = db.prepare(`SELECT * FROM terminals WHERE id = ?`).get(terminalId);
    audit({
      actorType: "admin",
      actorId,
      action: "terminal.created",
      targetType: "terminal",
      targetId: terminalId,
      requestId,
      idempotencyKey: idemKey,
      afterState: created,
      ip: req.ip
    });
    return {
      status: 201,
      body: {
        terminal: {
          ...created,
          ...buildTerminalPublicEntryMeta(created),
        },
      },
    };
  });
});

app.patch("/api/v1/terminals/:terminalId", requirePermission("terminal.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "PATCH:/api/v1/terminals/:id", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const before = db
      .prepare(`SELECT * FROM terminals WHERE id = ? AND store_id = ?`)
      .get(req.params.terminalId, req.session.store_id);
    if (!before) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Terminal not found" } } };
    const nextCode = req.body?.terminal_code != null ? String(req.body.terminal_code).trim() : before.terminal_code;
    const nextStatus = req.body?.status != null ? String(req.body.status) : before.status;
    if (!nextCode || !["active", "inactive"].includes(nextStatus)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Invalid terminal update payload" } } };
    }
    db.prepare(`UPDATE terminals SET terminal_code = ?, status = ?, updated_at = ? WHERE id = ?`).run(
      nextCode,
      nextStatus,
      nowIso(),
      before.id
    );
    const after = db.prepare(`SELECT * FROM terminals WHERE id = ?`).get(before.id);
    audit({
      actorType: "admin",
      actorId,
      action: "terminal.updated",
      targetType: "terminal",
      targetId: before.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip
    });
    return {
      status: 200,
      body: {
        terminal: {
          ...after,
          ...buildTerminalPublicEntryMeta(after),
        },
      },
    };
  });
});

app.get("/api/v1/terminals/:terminalId/bindings", requirePermission("terminal.manage"), (req, res) => {
  const terminal = db.prepare(`SELECT * FROM terminals WHERE id = ? AND store_id = ?`).get(req.params.terminalId, req.session.store_id);
  if (!terminal) return jsonError(res, 404, "NOT_FOUND", "Terminal not found");
  const sessions = db
    .prepare(
      `SELECT s.id, s.started_at, s.ended_at, s.revoked_at, s.ended_reason, u.id AS staff_user_id, u.staff_name, u.role
       FROM terminal_sessions s
       JOIN staff_users u ON u.id = s.staff_user_id
       WHERE s.terminal_id = ?
       ORDER BY s.started_at DESC
       LIMIT 100`
    )
    .all(terminal.id);
  const currentInvoiceContext = resolveTerminalCurrentInvoiceContext(terminal.id, { repairPointer: true, actorType: "system", actorId: "terminal.bindings" });
  return res.json({
    terminal: {
      ...currentInvoiceContext.terminal,
      ...buildTerminalPublicEntryMeta(currentInvoiceContext.terminal),
      current_invoice: summarizeInvoiceForTerminalState(currentInvoiceContext.currentInvoice),
      terminal_invariant_broken: currentInvoiceContext.invariantBroken === true,
    },
    sessions,
  });
});

app.get("/api/v1/terminal-sessions", requirePermission("session.read"), (req, res) => {
  const terminalId = req.query.terminal_id ? String(req.query.terminal_id) : null;
  const staffUserId = req.query.staff_user_id ? String(req.query.staff_user_id) : null;
  const includeEnded = String(req.query.include_ended || "true") === "true";
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const where = ["t.store_id = ?"];
  const args = [req.session.store_id];
  if (terminalId) {
    where.push("s.terminal_id = ?");
    args.push(terminalId);
  }
  if (staffUserId) {
    where.push("s.staff_user_id = ?");
    args.push(staffUserId);
  }
  if (!includeEnded) {
    where.push("s.revoked_at IS NULL AND s.ended_at IS NULL");
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.terminal_id, t.terminal_code, s.staff_user_id, u.staff_name, u.role, s.started_at, s.ended_at, s.revoked_at, s.ended_reason
       FROM terminal_sessions s
       JOIN terminals t ON t.id = s.terminal_id
       JOIN staff_users u ON u.id = s.staff_user_id
       WHERE ${where.join(" AND ")}
       ORDER BY s.started_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);
  return res.json({ sessions: rows, page: { limit, offset, returned: rows.length } });
});

app.post("/api/v1/terminal-sessions/:sessionId/revoke", requirePermission("session.revoke"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/terminal-sessions/:id/revoke", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const before = db
      .prepare(
        `SELECT s.*, t.store_id
         FROM terminal_sessions s
         JOIN terminals t ON t.id = s.terminal_id
         WHERE s.id = ?`
      )
      .get(req.params.sessionId);
    if (!before || before.store_id !== req.session.store_id) {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "Session not found" } } };
    }
    const ts = nowIso();
    db.prepare(
      `UPDATE terminal_sessions
       SET revoked_at = COALESCE(revoked_at, ?),
           ended_at = COALESCE(ended_at, ?),
           ended_reason = COALESCE(ended_reason, 'forced_revocation')
       WHERE id = ?`
    ).run(ts, ts, before.id);
    const after = db.prepare(`SELECT * FROM terminal_sessions WHERE id = ?`).get(before.id);
    audit({
      actorType: "admin",
      actorId,
      action: "session.revoked",
      targetType: "session",
      targetId: before.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip
    });
    return { status: 200, body: { session_id: before.id, revoked: true } };
  });
});

app.delete("/api/v1/terminal-sessions/current", (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "DELETE:/api/v1/terminal-sessions/current", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const ts = nowIso();
    const before = db.prepare(`SELECT * FROM terminal_sessions WHERE id = ?`).get(req.session.session_id);
    db.prepare(`UPDATE terminal_sessions SET revoked_at = ?, ended_at = COALESCE(ended_at, ?), ended_reason = 'logout' WHERE id = ?`).run(
      ts,
      ts,
      req.session.session_id
    );
    const after = db.prepare(`SELECT * FROM terminal_sessions WHERE id = ?`).get(req.session.session_id);
    audit({
      actorType: "staff",
      actorId,
      action: "session.ended",
      targetType: "session",
      targetId: req.session.session_id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip
    });
    return { status: 200, body: { session_id: req.session.session_id, revoked: true } };
  });
});

app.post("/api/v1/admin/payments/disable", requirePermission("payments.control"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/admin/payments/disable", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const reason = String(req.body?.reason || "").trim() || "manual_disable";
    const before = { payments_disabled: isPaymentsDisabled(), env_forced: PAYMENTS_DISABLED_ENV };
    setAppConfig("payments.disabled", "true", actorId);
    const after = { payments_disabled: isPaymentsDisabled(), env_forced: PAYMENTS_DISABLED_ENV, reason };
    audit({
      actorType: "admin",
      actorId,
      action: "payments.disabled",
      targetType: "settings",
      targetId: "payments.disabled",
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip,
    });
    return { status: 200, body: after };
  });
});

app.post("/api/v1/admin/payments/enable", requirePermission("payments.control"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/admin/payments/enable", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const reason = String(req.body?.reason || "").trim() || "manual_enable";
    const before = { payments_disabled: isPaymentsDisabled(), env_forced: PAYMENTS_DISABLED_ENV };
    setAppConfig("payments.disabled", "false", actorId);
    const after = { payments_disabled: isPaymentsDisabled(), env_forced: PAYMENTS_DISABLED_ENV, reason };
    audit({
      actorType: "admin",
      actorId,
      action: "payments.enabled",
      targetType: "settings",
      targetId: "payments.disabled",
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip,
    });
    return { status: 200, body: after };
  });
});

app.post("/api/v1/admin/stores/:storeId/payments/disable", requirePermission("payments.control"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/admin/stores/:id/payments/disable", actorId, () => {
    if (req.params.storeId !== req.session.store_id) {
      return { status: 403, body: { error: { code: "FORBIDDEN", message: "Store mismatch" } } };
    }
    const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.params.storeId);
    if (!store) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Store not found" } } };
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const reason = String(req.body?.reason || "").trim() || "store_manual_disable";
    const key = paymentDisableConfigKey("store", store.id);
    const before = getPaymentsDisableState({ storeId: store.id });
    setAppConfig(key, "true", actorId);
    const after = {
      ...getPaymentsDisableState({ storeId: store.id }),
      scope: "store",
      store_id: store.id,
      reason,
    };
    audit({
      actorType: "admin",
      actorId,
      action: "payments.store_disabled",
      targetType: "store",
      targetId: store.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip,
    });
    return { status: 200, body: after };
  });
});

app.post("/api/v1/admin/stores/:storeId/payments/enable", requirePermission("payments.control"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/admin/stores/:id/payments/enable", actorId, () => {
    if (req.params.storeId !== req.session.store_id) {
      return { status: 403, body: { error: { code: "FORBIDDEN", message: "Store mismatch" } } };
    }
    const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.params.storeId);
    if (!store) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Store not found" } } };
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const reason = String(req.body?.reason || "").trim() || "store_manual_enable";
    const key = paymentDisableConfigKey("store", store.id);
    const before = getPaymentsDisableState({ storeId: store.id });
    setAppConfig(key, "false", actorId);
    const after = {
      ...getPaymentsDisableState({ storeId: store.id }),
      scope: "store",
      store_id: store.id,
      reason,
    };
    audit({
      actorType: "admin",
      actorId,
      action: "payments.store_enabled",
      targetType: "store",
      targetId: store.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip,
    });
    return { status: 200, body: after };
  });
});

app.post("/api/v1/admin/terminals/:terminalId/payments/disable", requirePermission("payments.control"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/admin/terminals/:id/payments/disable", actorId, () => {
    const terminal = db
      .prepare(`SELECT * FROM terminals WHERE id = ? AND store_id = ?`)
      .get(req.params.terminalId, req.session.store_id);
    if (!terminal) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Terminal not found" } } };
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const reason = String(req.body?.reason || "").trim() || "terminal_manual_disable";
    const key = paymentDisableConfigKey("terminal", terminal.id);
    const before = getPaymentsDisableState({ storeId: terminal.store_id, terminalId: terminal.id });
    setAppConfig(key, "true", actorId);
    const after = {
      ...getPaymentsDisableState({ storeId: terminal.store_id, terminalId: terminal.id }),
      scope: "terminal",
      store_id: terminal.store_id,
      terminal_id: terminal.id,
      reason,
    };
    audit({
      actorType: "admin",
      actorId,
      action: "payments.terminal_disabled",
      targetType: "terminal",
      targetId: terminal.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip,
    });
    return { status: 200, body: after };
  });
});

app.post("/api/v1/admin/terminals/:terminalId/payments/enable", requirePermission("payments.control"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/admin/terminals/:id/payments/enable", actorId, () => {
    const terminal = db
      .prepare(`SELECT * FROM terminals WHERE id = ? AND store_id = ?`)
      .get(req.params.terminalId, req.session.store_id);
    if (!terminal) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Terminal not found" } } };
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const reason = String(req.body?.reason || "").trim() || "terminal_manual_enable";
    const key = paymentDisableConfigKey("terminal", terminal.id);
    const before = getPaymentsDisableState({ storeId: terminal.store_id, terminalId: terminal.id });
    setAppConfig(key, "false", actorId);
    const after = {
      ...getPaymentsDisableState({ storeId: terminal.store_id, terminalId: terminal.id }),
      scope: "terminal",
      store_id: terminal.store_id,
      terminal_id: terminal.id,
      reason,
    };
    audit({
      actorType: "admin",
      actorId,
      action: "payments.terminal_enabled",
      targetType: "terminal",
      targetId: terminal.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: after,
      ip: req.ip,
    });
    return { status: 200, body: after };
  });
});

app.get("/api/v1/admin/receive-addresses", requirePermission("address_pool.manage"), (req, res) => {
  const rows = listReceiveAddresses(req.session.store_id);
  return res.json({
    receive_addresses: rows.map((row) => ({
      id: row.id,
      address: row.address,
	      status: row.status,
	      network: row.network,
	      token_contract: row.token_contract,
	      allocated_invoice_id: row.allocated_invoice_id,
	      source_label: row.source_label,
	      control_proof_type: row.control_proof_type,
	      control_proof_payload_hash: row.control_proof_payload_hash,
	      verified_by: row.verified_by,
	      verified_at: row.verified_at,
	      approval_ref: row.approval_ref,
	      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  });
});

app.post("/api/v1/admin/receive-addresses:import", requirePermission("address_pool.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/admin/receive-addresses:import", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    const sourceLabel = String(req.body?.source_label || "ops_import").trim();
    const imported = importReceiveAddresses({
      storeId: req.session.store_id,
      actorId,
      addresses,
      sourceLabel,
      requestId,
      idempotencyKey: idemKey,
      ip: req.ip,
    });
	    if (imported.error) {
	      const code = ["PRIVATE_KEY_MATERIAL_REJECTED", "INVALID_CONTROL_PROOF", "VALIDATION_ERROR"].includes(imported.error.code) ? 400 : 409;
      return { status: code, body: { error: imported.error } };
    }
    return {
      status: 201,
      body: {
        imported_count: imported.rows.length,
        receive_addresses: imported.rows.map((row) => ({
          id: row.id,
	          address: row.address,
	          status: row.status,
	          source_label: row.source_label,
	          control_proof_type: row.control_proof_type,
	          control_proof_payload_hash: row.control_proof_payload_hash,
	          verified_at: row.verified_at,
	          approval_ref: row.approval_ref,
	        })),
      },
    };
  });
});

app.post("/api/v1/admin/receive-addresses/:receiveAddressId/disable", requirePermission("address_pool.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/admin/receive-addresses/:id/disable", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const result = disableReceiveAddress({
      storeId: req.session.store_id,
      receiveAddressId: req.params.receiveAddressId,
      actorId,
      reason: String(req.body?.reason || "disabled_by_admin").trim(),
      requestId,
      idempotencyKey: idemKey,
      ip: req.ip,
    });
    if (result.error) {
      const status = result.error.code === "NOT_FOUND" ? 404 : 409;
      return { status, body: { error: result.error } };
    }
    return { status: 200, body: { receive_address: result.row } };
  });
});

app.post("/api/v1/invoices", (req, res) => {
  if (!hasPermission(req.session, "invoice.create")) {
    return jsonError(res, 403, "FORBIDDEN", "Permission denied: invoice.create");
  }
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/invoices", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.session.store_id);
    const commercialBlocked = getCommercialGateBlockedError();
    if (commercialBlocked) {
      return { status: 503, body: { error: commercialBlocked } };
    }
    const issuanceBlocked = getInvoiceIssuanceBlockReason({ store, session: req.session });
    if (issuanceBlocked) {
      const status = issuanceBlocked.code === "NOT_FOUND" || issuanceBlocked.code === "TERMINAL_NOT_FOUND" ? 404 : 503;
      return { status, body: { error: issuanceBlocked } };
    }
    const forbiddenField = findForbiddenInvoiceField(req.body || {});
    if (forbiddenField) {
      return {
        status: 400,
        body: {
          error: {
            code: "FIELD_NOT_ALLOWED",
            message: "chain/token/recipient are server-controlled",
            details: { field: forbiddenField },
          },
        },
      };
    }
    const amountJpy = Number(req.body?.amount_jpy);
    if (!Number.isInteger(amountJpy) || amountJpy <= 0 || amountJpy > MAX_INVOICE_AMOUNT_JPY) {
      return {
        status: 400,
        body: {
          error: { code: "VALIDATION_ERROR", message: `amount_jpy must be a positive integer <= ${MAX_INVOICE_AMOUNT_JPY}` },
        },
      };
    }
    if (!AML_POLICY_APPROVED && amountJpy >= AML_HIGH_VALUE_THRESHOLD_JPY) {
      return {
        status: 503,
        body: {
          error: {
            code: "AML_POLICY_NOT_APPROVED",
            message: "High-value invoice creation is disabled until AML policy approval",
          },
        },
      };
    }
    const businessDate = DateTime.now().setZone(store.timezone || "Asia/Tokyo").toISODate();
    const dailyTotals = computeDailyStoreTotals(req.session.store_id, businessDate, store.timezone || "Asia/Tokyo");
    if (dailyTotals.error) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "failed to evaluate daily cap", details: dailyTotals.details } } };
    }
    if (dailyTotals.invoice_count >= DAILY_STORE_INVOICE_CAP) {
      return {
        status: 409,
        body: {
          error: {
            code: "DAILY_STORE_INVOICE_CAP_EXCEEDED",
            message: "daily invoice cap exceeded",
          },
        },
      };
    }
    if (dailyTotals.amount_jpy + amountJpy > DAILY_STORE_AMOUNT_CAP_JPY) {
      return {
        status: 409,
        body: {
          error: {
            code: "DAILY_STORE_AMOUNT_CAP_EXCEEDED",
            message: "daily store amount cap exceeded",
          },
        },
      };
    }
    const issued = issueInvoiceRecord({
      store,
      session: req.session,
      amountJpy,
      actorType: "staff",
      actorId,
      requestId,
      idempotencyKey: idemKey,
      ip: req.ip,
    });
    if (issued.error) {
      return { status: 409, body: { error: issued.error } };
    }
    const created = issued.invoice;
    const terminal = ensureTerminalPublicEntryToken(req.session.terminal_id);
    const publicEntry = buildTerminalPublicEntryMeta(terminal);
    const sseToken = createSseToken({
      invoiceId: created.id,
      terminalId: req.session.terminal_id,
      storeId: req.session.store_id,
      sessionId: req.session.session_id,
      expiresAtIso: created.expires_at,
    });
    audit({
      actorType: "staff",
      actorId,
      action: "invoice.created",
      targetType: "invoice",
      targetId: created.id,
      requestId,
      idempotencyKey: idemKey,
      afterState: created,
      ip: req.ip
    });
    if (issued.allocatedAddress) {
      audit({
        actorType: "staff",
        actorId,
        action: "receive_address.allocated",
        targetType: "receive_address",
        targetId: issued.allocatedAddress.id,
        requestId,
        idempotencyKey: idemKey,
        beforeState: {
          status: "available",
          address: issued.allocatedAddress.address,
        },
        afterState: issued.allocatedAddress,
        ip: req.ip,
      });
    }
    if (amountJpy >= AML_HIGH_VALUE_THRESHOLD_JPY) {
      recordSuspiciousActivity({
        storeId: req.session.store_id,
        invoiceId: created.id,
        reason: "high_amount_invoice_created",
        payload: { amount_jpy: amountJpy, threshold_jpy: AML_HIGH_VALUE_THRESHOLD_JPY },
      });
    }
    sendEvent(req.session.terminal_id, "invoice.updated", { invoiceId: created.id, status: created.status });
    logCorrelationEvent("invoice.created", created, {
      status: created.status,
      status_version: created.updated_at,
      terminal_id: req.session.terminal_id,
      store_id: req.session.store_id,
      details: {
        amount_jpy: created.amount_jpy,
        receive_address: created.recipient_address,
      },
    });
    const walletPayload = buildInvoiceWalletPayload(created, store);

    return {
      status: 201,
      body: {
        invoice_id: created.id,
        invoice_no: created.invoice_no,
        status: created.status,
        expires_at: created.expires_at,
        payment_url: created.payment_url,
        pay_url: created.payment_url,
        qr_payload: created.payment_url,
        fixed_qr_url: publicEntry.fixed_qr_url,
        fixed_qr_payload: publicEntry.fixed_qr_url,
        terminal_public_entry_token: publicEntry.public_entry_token,
        receive_address: created.recipient_address,
        checkout_session_id: created.checkout_session_id,
        ...walletPayload,
        sse: {
          token: sseToken,
          invoice_id: created.id,
        },
      }
    };
  });
});

app.get("/api/v1/invoices/:invoiceId", (req, res) => {
  if (!hasPermission(req.session, "invoice.read")) {
    return jsonError(res, 403, "FORBIDDEN", "Permission denied: invoice.read");
  }
  const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ?`).get(req.params.invoiceId, req.session.store_id);
  if (!invoice) return jsonError(res, 404, "NOT_FOUND", "Invoice not found");
  const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.session.store_id);
  const review = db.prepare(`SELECT * FROM review_cases WHERE invoice_id = ?`).get(invoice.id);
  const events = db
    .prepare(`SELECT event_type, chain_id, tx_hash, confirmations, amount_jpyc, observed_at FROM payment_events WHERE invoice_id = ? ORDER BY created_at DESC`)
    .all(invoice.id);
  const lineage = db
    .prepare(
      `SELECT id, checkout_session_id, from_invoice_id, to_invoice_id, created_by, created_at
       FROM invoice_lineage
       WHERE from_invoice_id = ? OR to_invoice_id = ?
       ORDER BY created_at DESC`
    )
    .all(invoice.id, invoice.id);
  const walletPayload = buildInvoiceWalletPayload(invoice, store);
  const providerSummary = buildProviderSummary(invoice);
  return res.json({
    invoice_id: invoice.id,
    invoice_no: invoice.invoice_no,
    status: invoice.status,
    status_reason: invoice.status_reason,
    amounts: {
      amount_jpy: invoice.amount_jpy,
      amount_jpyc: invoice.amount_jpyc,
      paid_amount_jpyc: invoice.paid_amount_jpyc,
      amount_jpyc_base: invoice.amount_jpyc_base,
      paid_amount_jpyc_base: invoice.paid_amount_jpyc_base,
      amount_jpyc_display: formatJpyc(invoice.amount_jpyc_base),
      paid_amount_jpyc_display: formatJpyc(invoice.paid_amount_jpyc_base)
    },
    chain: {
      chain_id: invoice.chain_id,
      token_contract: invoice.token_contract,
      recipient_address: invoice.recipient_address
    },
    expires_at: invoice.expires_at,
    payment_url: invoice.payment_url,
    pay_url: invoice.payment_url,
    ...walletPayload,
    provider_summary: providerSummary,
    customer_payment_mode: providerSummary.customer_payment_mode,
    review_case_id: review?.id || null,
    events,
    lineage,
    ...(DIAGNOSTIC_MODE_ENABLED ? { diagnostics: buildInvoiceDiagnostics(invoice, store, review) } : {}),
  });
});

app.post("/api/v1/invoices/:invoiceId/provider-sessions\\:present", requirePermission("invoice.create"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/invoices/:id/provider-sessions:present", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const providerCodeRaw = String(req.body?.provider_code || defaultProviderCodeForPresentation()).trim();
    const providerCode = isKnownProviderCode(providerCodeRaw) ? providerCodeRaw : null;
    if (!providerCode) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "provider_code is invalid" } } };
    }

    const result = db.transaction(() => {
      const invoice = db
        .prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ? AND terminal_id = ?`)
        .get(req.params.invoiceId, req.session.store_id, req.session.terminal_id);
      if (!invoice) {
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
      }
      if (String(invoice.status) !== "issued") {
        return {
          status: 409,
          body: {
            error: {
              code: "PROVIDER_PRESENTATION_NOT_ALLOWED",
              message: "provider presentation is only allowed while invoice is issued",
              details: { invoice_status: invoice.status },
            },
          },
        };
      }

      const terminalContext = resolveTerminalCurrentInvoiceContext(req.session.terminal_id, {
        repairPointer: true,
        actorType: "staff",
        actorId,
        requestId,
        idempotencyKey: idemKey,
        ip: req.ip,
      });
      if (terminalContext.invariantBroken) {
        return { status: 409, body: { error: buildTerminalActiveInvoiceError(terminalContext) } };
      }
      if (String(terminalContext.currentInvoice?.id || "") !== String(invoice.id)) {
        return {
          status: 409,
          body: {
            error: {
              code: "TERMINAL_CURRENT_INVOICE_MISMATCH",
              message: "invoice is not the terminal current invoice",
              details: {
                terminal_id: req.session.terminal_id,
                current_invoice: summarizeInvoiceForTerminalState(terminalContext.currentInvoice),
              },
            },
          },
        };
      }

      const providerSummary = buildProviderSummary(invoice);
      if (providerSummary.available && providerSummary.qr_available === false && providerSummary.can_present !== true) {
        return {
          status: 200,
          body: {
            invoice_id: invoice.id,
            invoice_status: invoice.status,
            provider_summary: providerSummary,
            customer_payment_mode: providerSummary.customer_payment_mode,
            duplicate: true,
          },
        };
      }

      createProviderPresentedSession({
        invoice,
        providerCode,
        actorType: "staff",
        actorId,
        requestId,
        idempotencyKey: idemKey,
        ip: req.ip,
      });
      const refreshedInvoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
      const refreshedSummary = buildProviderSummary(refreshedInvoice);
      return {
        status: 200,
        body: {
          invoice_id: refreshedInvoice.id,
          invoice_status: refreshedInvoice.status,
          provider_summary: refreshedSummary,
          customer_payment_mode: refreshedSummary.customer_payment_mode,
          duplicate: false,
        },
      };
    })();
    if (result.status === 200) {
      sendEvent(req.session.terminal_id, "invoice.updated", {
        invoiceId: req.params.invoiceId,
        status: result.body?.invoice_status,
        rail: PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL,
        provider_payment_session_status: result.body?.provider_summary?.payment_session_status || null,
      });
    }
    return result;
  });
});

app.post("/api/v1/invoices/:invoiceId/provider-sessions\\:cancel", requirePermission("invoice.create"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/invoices/:id/provider-sessions:cancel", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const result = db.transaction(() => {
      const invoice = db
        .prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ? AND terminal_id = ?`)
        .get(req.params.invoiceId, req.session.store_id, req.session.terminal_id);
      if (!invoice) {
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
      }
      const cancelled = cancelProviderPresentation({
        invoice,
        actorType: "staff",
        actorId,
        requestId,
        idempotencyKey: idemKey,
        ip: req.ip,
      });
      if (cancelled.error) {
        return { status: 409, body: { error: cancelled.error } };
      }
      const refreshedSummary = buildProviderSummary(invoice);
      return {
        status: 200,
        body: {
          invoice_id: invoice.id,
          invoice_status: invoice.status,
          provider_summary: refreshedSummary,
          customer_payment_mode: refreshedSummary.customer_payment_mode,
        },
      };
    })();
    if (result.status === 200) {
      sendEvent(req.session.terminal_id, "invoice.updated", {
        invoiceId: req.params.invoiceId,
        status: result.body?.invoice_status,
        rail: PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL,
        provider_payment_session_status: result.body?.provider_summary?.payment_session_status || null,
      });
    }
    return result;
  });
});

app.post("/api/v1/invoices/:invoiceId/sse-token", requirePermission("invoice.read"), (req, res) => {
  const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ?`).get(req.params.invoiceId, req.session.store_id);
  if (!invoice) return jsonError(res, 404, "NOT_FOUND", "Invoice not found");
  if (String(invoice.terminal_id) !== String(req.session.terminal_id)) {
    return jsonError(res, 403, "FORBIDDEN", "Invoice terminal mismatch");
  }
  const token = createSseToken({
    invoiceId: invoice.id,
    terminalId: req.session.terminal_id,
    storeId: req.session.store_id,
    sessionId: req.session.session_id,
    expiresAtIso: invoice.expires_at,
  });
  return res.json({
    invoice_id: invoice.id,
    terminal_id: req.session.terminal_id,
    token,
  });
});

app.post("/api/v1/invoices/:invoiceId/cancel", requirePermission("invoice.create"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/invoices/:id/cancel", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const result = db.transaction(() => {
      const owned = db.prepare(`SELECT id FROM invoices WHERE id = ? AND store_id = ?`).get(req.params.invoiceId, req.session.store_id);
      if (!owned) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
      const update = updateInvoiceStatus(req.params.invoiceId, "cancelled", "cancelled_by_staff", {
        actorType: "staff",
        actorId,
        requestId,
        idempotencyKey: idemKey,
        ip: req.ip,
        reason: "cancelled_by_staff",
      });
      if (update.error === "NOT_FOUND") return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
      if (update.error) {
        return {
          status: 409,
          body: { error: { code: "INVALID_STATE_TRANSITION", message: "Cannot cancel from current state", details: update } }
        };
      }
      audit({
        actorType: "staff",
        actorId,
        action: "invoice.cancelled",
        targetType: "invoice",
        targetId: req.params.invoiceId,
        requestId,
        idempotencyKey: idemKey,
        beforeState: update.before,
        afterState: update.invoice,
        ip: req.ip
      });
      return { status: 200, body: { invoice_id: update.invoice.id, status: update.invoice.status } };
    })();
    sendEvent(req.session.terminal_id, "invoice.updated", { invoiceId: req.params.invoiceId, status: result.body?.status });
    return result;
  });
});

app.post("/api/v1/invoices/:invoiceId/reissue", requirePermission("invoice.create"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/invoices/:id/reissue", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.session.store_id);
    const commercialBlocked = getCommercialGateBlockedError();
    if (commercialBlocked) {
      return { status: 503, body: { error: commercialBlocked } };
    }
    const issuanceBlocked = getInvoiceIssuanceBlockReason({ store, session: req.session });
    if (issuanceBlocked) {
      const status = issuanceBlocked.code === "NOT_FOUND" || issuanceBlocked.code === "TERMINAL_NOT_FOUND" ? 404 : 503;
      return { status, body: { error: issuanceBlocked } };
    }
    const businessDate = DateTime.now().setZone(store.timezone || "Asia/Tokyo").toISODate();
    const result = db.transaction(() => {
      const original = db.prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ?`).get(req.params.invoiceId, req.session.store_id);
      if (!original) {
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
      }
      if (String(original.status) === "paid") {
        return { status: 409, body: { error: { code: "INVALID_STATE_TRANSITION", message: "Paid invoice cannot be reissued" } } };
      }

      const dailyTotals = computeDailyStoreTotals(req.session.store_id, businessDate, store.timezone || "Asia/Tokyo");
      if (dailyTotals.error) {
        return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "failed to evaluate daily cap", details: dailyTotals.details } } };
      }
      if (dailyTotals.invoice_count >= DAILY_STORE_INVOICE_CAP) {
        return { status: 409, body: { error: { code: "DAILY_STORE_INVOICE_CAP_EXCEEDED", message: "daily invoice cap exceeded" } } };
      }
      if (dailyTotals.amount_jpy + Number(original.amount_jpy || 0) > DAILY_STORE_AMOUNT_CAP_JPY) {
        return { status: 409, body: { error: { code: "DAILY_STORE_AMOUNT_CAP_EXCEEDED", message: "daily store amount cap exceeded" } } };
      }

      let previousInvoice = original;
      if (isTerminalActiveInvoiceStatus(original.status)) {
        const nextReason = original.status === "issued" ? "reissued" : "reissued_with_payment_detected";
        const transitioned = original.status === "issued"
          ? updateInvoiceStatus(original.id, "expired", nextReason, {
            actorType: "staff",
            actorId,
            requestId,
            idempotencyKey: idemKey,
            ip: req.ip,
            reason: nextReason,
          })
          : transitionInvoiceForPayment(original, "review_required", nextReason, {
            actorType: "staff",
            actorId,
            requestId,
            idempotencyKey: idemKey,
            ip: req.ip,
            reason: nextReason,
          });
        if (transitioned.error) {
          return { status: 409, body: { error: { code: "INVALID_STATE_TRANSITION", message: "Invoice cannot be reissued from current state" } } };
        }
        previousInvoice = transitioned.invoice;
        if (previousInvoice.status === "review_required") {
          upsertReviewCase(previousInvoice, REVIEW_REASON_CODES.LATE_PAYMENT, {
            txHash: previousInvoice.paid_tx_hash || null,
            eventAmountBase: previousInvoice.paid_amount_jpyc_base || "0",
            blockTimestamp: nowIso(),
            detectedAt: nowIso(),
          });
        }
      }

      const issued = issueInvoiceRecord({
        store,
        session: req.session,
        amountJpy: Number(original.amount_jpy || 0),
        checkoutSessionId: original.checkout_session_id || null,
        reissuedFromInvoiceId: original.id,
        reissueRootInvoiceId: original.reissue_root_invoice_id || original.id,
        actorType: "staff",
        actorId,
        requestId,
        idempotencyKey: idemKey,
        ip: req.ip,
      });
      if (issued.error) {
        return { status: 409, body: { error: issued.error } };
      }
      db.prepare(
        `INSERT OR IGNORE INTO invoice_lineage (id, checkout_session_id, from_invoice_id, to_invoice_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        issued.invoice.checkout_session_id || original.checkout_session_id || null,
        original.id,
        issued.invoice.id,
        actorId,
        nowIso()
      );
      return {
        status: 201,
        body: {
          original,
          previousInvoice,
          issued,
        },
      };
    })();
    if (result.status !== 201) return result;
    const original = result.body.original;
    const previousInvoice = result.body.previousInvoice;
    const issued = result.body.issued;
    const terminal = ensureTerminalPublicEntryToken(req.session.terminal_id);
    const publicEntry = buildTerminalPublicEntryMeta(terminal);
    const sseToken = createSseToken({
      invoiceId: issued.invoice.id,
      terminalId: req.session.terminal_id,
      storeId: req.session.store_id,
      sessionId: req.session.session_id,
      expiresAtIso: issued.invoice.expires_at,
    });
    audit({
      actorType: "staff",
      actorId,
      action: "invoice.reissued",
      targetType: "invoice",
      targetId: issued.invoice.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: original,
      afterState: {
        previous_invoice: previousInvoice,
        new_invoice: issued.invoice,
      },
      ip: req.ip,
    });
    if (issued.allocatedAddress) {
      audit({
        actorType: "staff",
        actorId,
        action: "receive_address.allocated",
        targetType: "receive_address",
        targetId: issued.allocatedAddress.id,
        requestId,
        idempotencyKey: idemKey,
        beforeState: { status: "available", address: issued.allocatedAddress.address },
        afterState: issued.allocatedAddress,
        ip: req.ip,
      });
    }
    sendEvent(req.session.terminal_id, "invoice.updated", { invoiceId: original.id, status: previousInvoice.status });
    sendEvent(req.session.terminal_id, "invoice.updated", { invoiceId: issued.invoice.id, status: issued.invoice.status });
    logCorrelationEvent("invoice.reissued", issued.invoice, {
      status: issued.invoice.status,
      status_version: issued.invoice.updated_at,
      terminal_id: req.session.terminal_id,
      store_id: req.session.store_id,
      details: {
        previous_invoice_id: original.id,
        previous_receive_address: original.recipient_address,
        new_receive_address: issued.invoice.recipient_address,
      },
    });
    return {
      status: 201,
      body: {
        previous_invoice_id: original.id,
        invoice_id: issued.invoice.id,
        invoice_no: issued.invoice.invoice_no,
        checkout_session_id: issued.invoice.checkout_session_id,
        status: issued.invoice.status,
        expires_at: issued.invoice.expires_at,
        payment_url: issued.invoice.payment_url,
        fixed_qr_url: publicEntry.fixed_qr_url,
        terminal_public_entry_token: publicEntry.public_entry_token,
        receive_address: issued.invoice.recipient_address,
        sse: {
          token: sseToken,
          invoice_id: issued.invoice.id,
        },
      },
    };
  });
});

app.post("/api/v1/invoices/:invoiceId/expire", requirePermission("invoice.create"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/invoices/:id/expire", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const result = db.transaction(() => {
      const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ?`).get(req.params.invoiceId, req.session.store_id);
      if (!invoice) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
      const next = invoice.paid_tx_hash ? "review_required" : "expired";
      const reason = invoice.paid_tx_hash ? "late_arrival_after_expiry" : "expired_timeout";
      const update = invoice.paid_tx_hash
        ? transitionInvoiceForPayment(invoice, "review_required", reason, {
          actorType: "staff",
          actorId,
          requestId,
          idempotencyKey: idemKey,
          ip: req.ip,
          reason,
        })
        : updateInvoiceStatus(invoice.id, "expired", reason, {
          actorType: "staff",
          actorId,
          requestId,
          idempotencyKey: idemKey,
          ip: req.ip,
          reason,
        });
      if (update.error) {
        return {
          status: 409,
          body: { error: { code: "INVALID_STATE_TRANSITION", message: "Cannot expire from current state", details: update } }
        };
      }
      if (next === "review_required") {
        upsertReviewCase(update.invoice, REVIEW_REASON_CODES.LATE_PAYMENT, {
          txHash: update.invoice.paid_tx_hash || null,
          eventAmountBase: update.invoice.paid_amount_jpyc_base || "0",
          blockTimestamp: nowIso(),
          detectedAt: nowIso(),
        });
      }
      audit({
        actorType: "staff",
        actorId,
        action: "invoice.expired",
        targetType: "invoice",
        targetId: invoice.id,
        requestId,
        idempotencyKey: idemKey,
        beforeState: invoice,
        afterState: update.invoice,
        ip: req.ip
      });
      return { status: 200, body: { invoice_id: invoice.id, status: update.invoice.status } };
    })();
    sendEvent(req.session.terminal_id, "invoice.updated", { invoiceId: req.params.invoiceId, status: result.body?.status });
    return result;
  });
});

app.post("/api/v1/payments/events:ingest", requirePermission("payment.ingest.manual"), async (req, res) => {
  if (IS_PRODUCTION && !ALLOW_MANUAL_PAYMENT_INGEST) {
    return jsonError(res, 403, "MANUAL_INGEST_DISABLED", "manual ingest is disabled in production");
  }
  const actorId = req.session.staff_user_id;
  return idempotentAsync(req, res, "POST:/api/v1/payments/events:ingest", actorId, async () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const invoiceId = String(req.body?.invoice_id || "");
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ?`).get(invoiceId, req.session.store_id);
    if (!invoice) {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
    }
    const shouldVerifyOnChain = IS_PRODUCTION || (rpcProviders.length > 0 && parseTxHash(req.body?.tx_hash));
    const parsed = shouldVerifyOnChain
      ? await buildVerifiedManualIngestEvent(invoice, req.body || {})
      : buildIngestEvent(req.body || {});
    if (parsed.error) {
      const error = typeof parsed.error === "string"
        ? { code: "VALIDATION_ERROR", message: parsed.error }
        : parsed.error;
      const status = parsed.pending ? 409 : (error.code === "NOT_FOUND" ? 404 : 400);
      return { status, body: { error } };
    }
    return ingestPaymentForInvoice({
      storeId: req.session.store_id,
      event: parsed.event,
      requestId,
      idempotencyKey: idemKey || null,
      actorType: "admin",
      actorId,
      action: "payment.ingested.manual",
      ip: req.ip
    });
  });
});

app.get("/api/v1/reviews", requirePermission("review.read"), (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const rows = status
    ? db
        .prepare(
          `SELECT r.*,
                  r.reason_type AS reason_code,
                  i.invoice_no,
                  i.amount_jpy,
                  i.amount_jpyc_base AS billed_amount_jpyc_base,
                  i.paid_amount_jpyc,
                  i.paid_amount_jpyc_base
           FROM review_cases r JOIN invoices i ON i.id = r.invoice_id
           WHERE i.store_id = ? AND r.status = ?
           ORDER BY r.created_at DESC`
        )
        .all(req.session.store_id, status)
    : db
        .prepare(
          `SELECT r.*,
                  r.reason_type AS reason_code,
                  i.invoice_no,
                  i.amount_jpy,
                  i.amount_jpyc_base AS billed_amount_jpyc_base,
                  i.paid_amount_jpyc,
                  i.paid_amount_jpyc_base
           FROM review_cases r JOIN invoices i ON i.id = r.invoice_id
           WHERE i.store_id = ?
           ORDER BY r.created_at DESC`
        )
        .all(req.session.store_id);
  res.json({
    reviews: rows.map((row) => ({
      ...row,
      reason_type: normalizeReviewReasonCode(row.reason_type),
      reason_code: normalizeReviewReasonCode(row.reason_type),
      reason_label: reasonCodeLabelJa(row.reason_type),
      suggested_action: row.suggested_action || suggestedReviewAction(row.reason_type),
      refundable_candidate_jpyc_base:
        row.refundable_candidate_jpyc_base || computeReviewRefundableCandidateBase(row.reason_type, row.billed_amount_jpyc_base, row.paid_amount_jpyc_base),
    })),
  });
});

app.get("/api/v1/reviews/:reviewId", requirePermission("review.read"), (req, res) => {
  const review = db
    .prepare(
      `SELECT r.*,
              r.reason_type AS reason_code,
              i.invoice_no,
              i.status AS invoice_status,
              i.amount_jpy,
              i.amount_jpyc,
              i.checkout_session_id,
              i.created_at AS invoice_created_at,
              i.expires_at,
              i.updated_at AS invoice_updated_at,
              i.amount_jpyc_base AS billed_amount_jpyc_base,
              i.paid_amount_jpyc,
              i.paid_amount_jpyc_base,
              i.paid_tx_hash
       FROM review_cases r JOIN invoices i ON i.id = r.invoice_id
       WHERE r.id = ? AND i.store_id = ?`
    )
    .get(req.params.reviewId, req.session.store_id);
  if (!review) return jsonError(res, 404, "NOT_FOUND", "Review case not found");
  const events = db
    .prepare(
      `SELECT event_type, tx_hash, chain_id, token_contract, amount_jpyc, amount_jpyc_base, from_address, to_address, block_number, block_timestamp, detected_at, observed_at, created_at
       FROM payment_events
       WHERE invoice_id = ?
       ORDER BY created_at DESC`
    )
    .all(review.invoice_id);
  const auditHistory = db
    .prepare(`SELECT id, action, actor_id, created_at FROM audit_logs WHERE target_type = 'review' AND target_id = ? ORDER BY rowid DESC LIMIT 100`)
    .all(review.id);
  const reasonCode = normalizeReviewReasonCode(review.reason_type);
  const relatedInvoices = review.checkout_session_id
    ? db
        .prepare(
          `SELECT id AS invoice_id, invoice_no, status, amount_jpy, amount_jpyc, paid_amount_jpyc, created_at, expires_at, updated_at, paid_tx_hash
           FROM invoices
           WHERE store_id = ?
             AND checkout_session_id = ?
           ORDER BY created_at ASC`
        )
        .all(req.session.store_id, review.checkout_session_id)
        .map((row) => ({
          ...row,
          relation:
            row.invoice_id === review.invoice_id
              ? "current"
              : Date.parse(row.created_at) > Date.parse(review.invoice_created_at)
                ? "newer"
                : "older",
          paid_at: row.paid_tx_hash ? row.updated_at : null,
          primary_tx_hash: row.paid_tx_hash || null,
        }))
    : [];
  return res.json({
    review: {
      ...review,
      reason_type: reasonCode,
      reason_code: reasonCode,
      reason_label: reasonCodeLabelJa(reasonCode),
      suggested_action: review.suggested_action || suggestedReviewAction(reasonCode),
      refundable_candidate_jpyc_base:
        review.refundable_candidate_jpyc_base || computeReviewRefundableCandidateBase(reasonCode, review.billed_amount_jpyc_base, review.paid_amount_jpyc_base),
      audit_log: auditHistory,
    },
    events,
    related_invoices: relatedInvoices,
  });
});

app.patch("/api/v1/reviews/:reviewId", requirePermission("review.update"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "PATCH:/api/v1/reviews/:id", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const { status, resolution_note, assigned_to, admin_note, resolution_status } = req.body || {};
    const review = db
      .prepare(
        `SELECT r.* FROM review_cases r
         JOIN invoices i ON i.id = r.invoice_id
         WHERE r.id = ? AND i.store_id = ?`
      )
      .get(req.params.reviewId, req.session.store_id);
    if (!review) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Review case not found" } } };

    const nextStatus = status || review.status;
    if (!["open", "in_progress", "resolved", "rejected"].includes(nextStatus)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Invalid review status" } } };
    }
    const currentResolutionStatus = normalizeReviewResolutionStatus(review.resolution_status, "pending") || "pending";
    let nextResolutionStatus = currentResolutionStatus;
    if (resolution_status != null) {
      nextResolutionStatus = normalizeReviewResolutionStatus(resolution_status, null);
      if (!nextResolutionStatus) {
        return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Invalid resolution_status" } } };
      }
    } else if (nextStatus === "resolved" && currentResolutionStatus === "pending") {
      nextResolutionStatus = "settled";
    } else if (nextStatus === "rejected" && currentResolutionStatus === "pending") {
      nextResolutionStatus = "cancelled";
    }
    const ts = nowIso();
    const nextAdminNote = admin_note != null ? String(admin_note).trim() : (review.admin_note || null);
    const actionHistory = appendReviewActionHistory(review.action_history_json, {
      at: ts,
      action: "review.updated",
      actor_id: actorId,
      next_status: nextStatus,
      resolution_status: nextResolutionStatus || null,
      admin_note: nextAdminNote || null,
    });
    db.prepare(
      `UPDATE review_cases
       SET status = ?,
           resolution_note = ?,
           admin_note = ?,
           resolution_status = ?,
           assigned_to = ?,
           action_history_json = ?,
           updated_at = ?,
           resolved_at = ?
       WHERE id = ?`
    ).run(
      nextStatus,
      resolution_note ?? review.resolution_note ?? null,
      nextAdminNote,
      nextResolutionStatus || null,
      assigned_to ?? review.assigned_to ?? null,
      actionHistory,
      ts,
      nextStatus === "resolved" ? ts : null,
      review.id
    );
    const after = db.prepare(`SELECT * FROM review_cases WHERE id = ?`).get(review.id);
    audit({
      actorType: "admin",
      actorId,
      action: "review.updated",
      targetType: "review",
      targetId: review.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: review,
      afterState: after,
      ip: req.ip
    });
    const reasonCode = normalizeReviewReasonCode(after.reason_type);
    return {
      status: 200,
      body: {
        review: {
          ...after,
          reason_type: reasonCode,
          reason_code: reasonCode,
          reason_label: reasonCodeLabelJa(reasonCode),
        },
      },
    };
  });
});

app.post("/api/v1/refunds", requirePermission("refund.request"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/refunds", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const {
      review_case_id,
      refund_amount_jpyc,
      refund_to_address,
      refund_chain_id,
      reason,
      evidence_screenshot,
      evidence_note_path,
      customer_note,
    } = req.body || {};
    const parsedRefundBase = parsePositiveBaseUnits(refund_amount_jpyc, "refund_amount_jpyc");
    if (!review_case_id || parsedRefundBase.error || !refund_to_address || !refund_chain_id) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Missing refund fields" } } };
    }
    if (!isEvmAddress(refund_to_address)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "refund_to_address must be valid EVM address" } } };
    }
    const review = db
      .prepare(
        `SELECT r.*,
                i.store_id,
                i.id AS invoice_id,
                i.chain_id,
                i.token_contract,
                i.recipient_address,
                i.checkout_session_id,
                i.amount_jpyc_base,
                i.paid_amount_jpyc_base,
                i.paid_tx_hash
         FROM review_cases r JOIN invoices i ON i.id = r.invoice_id
         WHERE r.id = ? AND i.store_id = ?`
      )
      .get(review_case_id, req.session.store_id);
    if (!review) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Review not found" } } };
    if (String(refund_chain_id) !== String(review.chain_id)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "refund_chain_id must match invoice chain_id" } } };
    }

    const eligibleBase = computeRefundEligibilityBase(review, review);
    if (compareBaseUnits(parsedRefundBase.value, eligibleBase) > 0) {
      recordSuspiciousActivity({
        storeId: req.session.store_id,
        invoiceId: review.invoice_id,
        reason: "abnormal_refund_request_over_limit",
        payload: {
          requested_base: parsedRefundBase.value,
          eligible_base: eligibleBase,
          review_case_id,
        },
      });
      return {
        status: 400,
        body: {
          error: {
            code: "OVER_REFUND",
            message: "requested refund exceeds eligible amount",
            details: { eligible_refund_amount_jpyc_base: eligibleBase },
          },
        },
      };
    }

    const rid = uuid();
    const ts = nowIso();
    const refundDisplay = Number(refund_amount_jpyc);
    const normalizedReason = String(reason || normalizeReviewReasonCode(review.reason_type || REVIEW_REASON_CODES.OTHER)).trim();
    db.prepare(
      `INSERT INTO refund_requests
      (id, review_case_id, invoice_id, original_invoice_id, checkout_session_id, original_tx_hash, reason, requested_by, status, refund_amount_jpyc, refund_amount_jpyc_base,
       refund_eligible_jpyc_base, refund_to_address, refund_chain_id, expected_from_address, to_address, chain_id, token_contract, evidence_screenshot, evidence_note_path, customer_note, detected_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rid,
      review_case_id,
      review.invoice_id,
      review.invoice_id,
      review.checkout_session_id || null,
      review.paid_tx_hash || null,
      normalizedReason || null,
      actorId,
      Number.isFinite(refundDisplay) ? refundDisplay : 0,
      parsedRefundBase.value,
      eligibleBase,
      String(refund_to_address),
      String(refund_chain_id),
      normalizeAddress(review.recipient_address),
      String(refund_to_address),
      String(refund_chain_id),
      String(review.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT || ""),
      String(evidence_screenshot || "").trim() || null,
      String(evidence_note_path || "").trim() || null,
      String(customer_note || "").trim() || null,
      ts,
      ts,
      ts
    );

    const created = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(rid);
    audit({
      actorType: "admin",
      actorId,
      action: "refund.requested",
      targetType: "refund",
      targetId: rid,
      requestId,
      idempotencyKey: idemKey,
      afterState: created,
      ip: req.ip
    });
    const afterAudit = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(rid);
    return { status: 201, body: buildRefundEvidenceResponse(afterAudit) };
  });
});

app.post("/api/v1/refunds/:refundId/approve", requirePermission("refund.approve"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/refunds/:id/approve", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const refund = db
      .prepare(
        `SELECT rr.* FROM refund_requests rr
         JOIN invoices i ON i.id = rr.invoice_id
         WHERE rr.id = ? AND i.store_id = ?`
      )
      .get(req.params.refundId, req.session.store_id);
    if (!refund) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Refund request not found" } } };
    if (refund.status !== "requested") {
      return { status: 409, body: { error: { code: "INVALID_STATE_TRANSITION", message: "Only requested refunds can be approved" } } };
    }
    if (String(refund.requested_by) === String(actorId)) {
      return {
        status: 409,
        body: { error: { code: "TWO_PERSON_REQUIRED", message: "Requested by and approved by must be different staff" } }
      };
    }
    const ts = nowIso();
    db.prepare(`UPDATE refund_requests SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ?`).run(actorId, ts, refund.id);
    const after = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
    audit({
      actorType: "admin",
      actorId,
      action: "refund.approved",
      targetType: "refund",
      targetId: refund.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: refund,
      afterState: after,
      ip: req.ip
    });
    return { status: 200, body: buildRefundEvidenceResponse(after) };
  });
});

app.get("/api/v1/refunds/:refundId", requirePermission("refund.view"), (req, res) => {
  const refund = db
    .prepare(
      `SELECT rr.* FROM refund_requests rr
       JOIN invoices i ON i.id = rr.invoice_id
       WHERE rr.id = ? AND i.store_id = ?`
    )
    .get(req.params.refundId, req.session.store_id);
  if (!refund) return jsonError(res, 404, "NOT_FOUND", "Refund request not found");
  return res.json(buildRefundEvidenceResponse(refund));
});

app.post("/api/v1/refunds/:refundId/execute", requirePermission("refund.execute"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/refunds/:id/execute", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const executorType = String(req.body?.executor_type || "manual");
    const executor = refundExecutors[executorType];
    if (!executor) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Unsupported executor_type" } } };
    }
    if (["external_signer", "custody_provider"].includes(executorType) && !LEGAL_GATE_APPROVED) {
      return {
        status: 503,
        body: { error: { code: "LEGAL_GATE_NOT_APPROVED", message: "external signer/custody execution disabled until legal gate approval" } },
      };
    }
    const refund = db
      .prepare(
        `SELECT rr.* FROM refund_requests rr
         JOIN invoices i ON i.id = rr.invoice_id
         WHERE rr.id = ? AND i.store_id = ?`
      )
      .get(req.params.refundId, req.session.store_id);
    if (!refund) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Refund request not found" } } };
    if (!["approved", "failed"].includes(refund.status)) {
      return { status: 409, body: { error: { code: "INVALID_STATE_TRANSITION", message: "Refund must be approved or failed before execution" } } };
    }
    const sameActorAsApprover = refund.approved_by && String(refund.approved_by) === String(actorId);
    if (REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR && sameActorAsApprover) {
      return {
        status: 409,
        body: { error: { code: "TWO_PERSON_REQUIRED", message: "Approved by and executed by must be different staff" } }
      };
    }
    if (!REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR && sameActorAsApprover) {
      console.warn(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "refund.two_person_rule_bypassed",
          refund_id: refund.id,
          approver_id: refund.approved_by,
          executor_id: actorId,
        })
      );
      audit({
        actorType: "admin",
        actorId,
        action: "refund.two_person_rule_bypassed",
        targetType: "refund",
        targetId: refund.id,
        requestId,
        idempotencyKey: idemKey,
        beforeState: { approved_by: refund.approved_by, requires_distinct_actor: false },
        afterState: { executor_id: actorId, bypassed: true },
        ip: req.ip,
      });
    }

    const execResult = executor({ refund, payload: req.body || {}, actorId });
    if (execResult.error) {
      return { status: 400, body: { error: execResult.error } };
    }
    if (execResult.refundTxHash) {
      const existingHash = db
        .prepare(
          `SELECT id
           FROM refund_requests
           WHERE refund_tx_hash = ?
             AND COALESCE(refund_tx_log_index, -1) = COALESCE(?, -1)
             AND id != ?`
        )
        .get(execResult.refundTxHash, execResult.refundTxLogIndex ?? null, refund.id);
      if (existingHash) {
        return { status: 409, body: { error: { code: "DUPLICATE_REFUND_TX_HASH", message: "refund_tx_hash/log_index already used by another request" } } };
      }
    }

    const ts = nowIso();
    db.prepare(
      `UPDATE refund_requests
       SET status = ?,
           refund_tx_hash = ?,
           refund_tx_log_index = ?,
           failure_reason = ?,
           executed_by = ?,
           executor_type = ?,
           execution_ref = ?,
           executed_wallet = COALESCE(?, executed_wallet),
           evidence_screenshot = COALESCE(?, evidence_screenshot),
           evidence_note_path = COALESCE(?, evidence_note_path),
           customer_note = COALESCE(?, customer_note),
           to_address = COALESCE(?, to_address),
           chain_id = COALESCE(?, chain_id),
           token_contract = COALESCE(?, token_contract),
           detected_at = ?,
           verified_at = ?,
           last_attempted_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      execResult.status,
      execResult.refundTxHash || null,
      execResult.refundTxLogIndex ?? null,
      execResult.failureReason || null,
      actorId,
      executorType,
      execResult.executionRef || null,
      String(req.body?.executed_wallet || "").trim() || null,
      String(req.body?.evidence_screenshot || "").trim() || null,
      String(req.body?.evidence_note_path || "").trim() || null,
      String(req.body?.customer_note || "").trim() || null,
      refund.refund_to_address || refund.to_address || null,
      refund.refund_chain_id || refund.chain_id || null,
      refund.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT || null,
      ts,
      execResult.verifiedAt || null,
      ts,
      ts,
      refund.id
    );
    const after = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
    audit({
      actorType: "service",
      actorId: `refund.executor:${actorId}`,
      action: "refund.executed",
      targetType: "refund",
      targetId: refund.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: refund,
      afterState: after,
      ip: req.ip
    });
    if (after.status === "recorded") {
      recordSuspiciousActivity({
        storeId: req.session.store_id,
        invoiceId: refund.invoice_id,
        reason: "manual_refund_recorded_unverified",
        payload: { refund_id: refund.id, refund_tx_hash: after.refund_tx_hash },
      });
    }
    const afterAudit = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
    return { status: 200, body: buildRefundEvidenceResponse(afterAudit) };
  });
});

app.post("/api/v1/refunds/:refundId/verify", requirePermission("refund.execute"), async (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotentAsync(req, res, "POST:/api/v1/refunds/:id/verify", actorId, async () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const refund = db
      .prepare(
        `SELECT rr.* FROM refund_requests rr
         JOIN invoices i ON i.id = rr.invoice_id
         WHERE rr.id = ? AND i.store_id = ?`
      )
      .get(req.params.refundId, req.session.store_id);
    if (!refund) {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "Refund request not found" } } };
    }
    if (!["recorded", "pending_verification", "verification_failed", "failed"].includes(String(refund.status))) {
      return { status: 409, body: { error: { code: "INVALID_STATE_TRANSITION", message: "Refund is not awaiting verification" } } };
    }

    const verified = await verifyRefundExecutionOnChain(refund, req.body?.refund_tx_hash || null);
    if (verified.error) {
      return { status: 400, body: { error: verified.error } };
    }

    if (verified.refundTxHash) {
      const existingHash = db
        .prepare(
          `SELECT id
           FROM refund_requests
           WHERE refund_tx_hash = ?
             AND COALESCE(refund_tx_log_index, -1) = COALESCE(?, -1)
             AND id != ?`
        )
        .get(verified.refundTxHash, verified.refundTxLogIndex ?? null, refund.id);
      if (existingHash) {
        return { status: 409, body: { error: { code: "DUPLICATE_REFUND_TX_HASH", message: "refund_tx_hash/log_index already used by another request" } } };
      }
    }

    const ts = nowIso();
    db.prepare(
      `UPDATE refund_requests
       SET status = ?,
           refund_tx_hash = ?,
           refund_tx_log_index = ?,
           failure_reason = ?,
           from_address = COALESCE(?, from_address),
           to_address = COALESCE(?, to_address),
           chain_id = COALESCE(?, chain_id),
           token_contract = COALESCE(?, token_contract),
           block_number = ?,
           block_timestamp = ?,
           detected_at = ?,
           verified_at = ?,
           last_attempted_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      verified.status,
      verified.refundTxHash || refund.refund_tx_hash || null,
      verified.refundTxLogIndex ?? refund.refund_tx_log_index ?? null,
      verified.failureReason || null,
      verified.fromAddress || null,
      verified.toAddress || null,
      verified.chainId || null,
      verified.tokenContract || null,
      verified.blockNumber ?? null,
      verified.blockTimestamp || null,
      verified.detectedAt || ts,
      verified.verifiedAt || null,
      ts,
      ts,
      refund.id
    );
    const after = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
    audit({
      actorType: "admin",
      actorId,
      action: "refund.verified_onchain",
      targetType: "refund",
      targetId: refund.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: refund,
      afterState: after,
      ip: req.ip,
    });
    const afterAudit = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
    return { status: 200, body: buildRefundEvidenceResponse(afterAudit) };
  });
});

app.get("/api/v1/stores/:storeId/settings", (req, res) => {
  if (req.params.storeId !== req.session.store_id) return jsonError(res, 403, "FORBIDDEN", "Store mismatch");
  const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.params.storeId);
  if (!store) return jsonError(res, 404, "NOT_FOUND", "Store not found");
  const payments = getPaymentsDisableState({ storeId: store.id, terminalId: req.session.terminal_id });
  return res.json({
    merchant_id: store.merchant_id || "merchant-001",
    store_id: store.id,
    store_name: store.name,
    admin_contact: store.admin_contact,
    invoice_ttl_sec: store.invoice_ttl_sec,
    chain_id: store.chain_id,
    token_contract: store.token_contract,
    settlement_unresolved_review_policy: resolveSettlementUnresolvedReviewPolicy(store),
    payments,
    supported_wallets: getSupportedWallets(ENV),
    public_payment_simulation_enabled: ENABLE_PUBLIC_PAYMENT_SIMULATION,
    wallet_adapter: WALLET_ADAPTER
  });
});

app.get("/api/v1/audit-logs", requirePermission("audit.read"), (req, res) => {
  const targetType = req.query.target_type ? String(req.query.target_type) : null;
  const targetId = req.query.target_id ? String(req.query.target_id) : null;
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  let rows;
  if (targetType && targetId) {
    rows = db
      .prepare(`SELECT * FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(targetType, targetId, limit, offset);
  } else {
    rows = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }
  res.json({ audit_logs: rows, page: { limit, offset, returned: rows.length } });
});

app.get("/api/v1/audit-logs/verify-chain", requirePermission("audit.read"), (_req, res) => {
  const result = verifyAuditChain();
  return res.status(result.ok ? 200 : 409).json(result);
});

app.get("/api/v1/audit-logs/export", requirePermission("audit.export"), (req, res) => {
  if (IS_PRODUCTION && (!PRIVACY_POLICY_APPROVED || !APPI_POLICY_APPROVED)) {
    return jsonError(res, 503, "PRIVACY_POLICY_NOT_APPROVED", "audit export is disabled until privacy and APPI approvals are enabled");
  }
  const requestId = requestIdFromReq(req);
  const format = String(req.query.format || "json").toLowerCase();
  const requestedLimit = Number(req.query.limit || 500);
  const limit = Math.min(Math.max(requestedLimit, 1), 5000);
  const totalCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM audit_logs`).get().count || 0);
  const truncated = totalCount > limit || requestedLimit > limit;
  if (truncated) {
    res.setHeader(
      "X-Audit-Export-Warning",
      `export truncated: requested=${requestedLimit}, applied_limit=${limit}, total=${totalCount}`
    );
  }
  const rows = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`).all(limit);
  audit({
    actorType: "admin",
    actorId: req.session.staff_user_id,
    action: "audit.exported",
    targetType: "audit",
    targetId: "audit_logs",
    requestId,
    afterState: {
      format,
      requested_limit: requestedLimit,
      applied_limit: limit,
      total_count: totalCount,
      truncated,
      count: rows.length,
    },
    ip: req.ip,
  });
  if (format === "csv") {
    const headers = [
      "id",
      "actor_type",
      "actor_id",
      "action",
      "target_type",
      "target_id",
      "request_id",
      "idempotency_key",
      "prev_hash",
      "entry_hash",
      "created_at"
    ];
    const sanitizeCsvCell = (value) => {
      const raw = String(value ?? "");
      const firstNonSpace = raw.match(/[^\s]/)?.[0] || "";
      if (["=", "+", "-", "@", "\t", "\r"].includes(firstNonSpace)) {
        return `'${raw}`;
      }
      return raw;
    };
    const escapeCell = (value) => `"${sanitizeCsvCell(value).replace(/"/g, '""')}"`;
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((header) => escapeCell(row[header])).join(","));
    }
    res.setHeader("content-type", "text/csv; charset=utf-8");
    return res.send(lines.join("\n"));
  }
  return res.json({
    audit_logs: rows,
    exported_at: nowIso(),
    format: "json",
    count: rows.length,
    meta: {
      requested_limit: requestedLimit,
      applied_limit: limit,
      total_count: totalCount,
      truncated,
    },
  });
});

app.get("/api/v1/chain-monitor/status", requirePermission("monitor.read"), (_req, res) => {
  const stateRows = db.prepare(`SELECT key, value, updated_at FROM chain_monitor_state ORDER BY key ASC`).all();
  const failoverCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_rpc_failovers`).get().count;
  const unmatchedCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_unmatched_events`).get().count;
  const deadLetterCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters`).get().count;
  const pendingDeadLetterCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE status = 'pending'`).get().count;
  const abandonedDeadLetterCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE status = 'abandoned'`).get().count;
  const addressPoolAvailableCount = db.prepare(`SELECT COUNT(*) AS count FROM receive_addresses WHERE status = 'available'`).get().count;
  return res.json({
    state: stateRows,
    failover_count: failoverCount,
    unmatched_event_count: unmatchedCount,
    dead_letter_count: deadLetterCount,
    pending_dead_letter_count: pendingDeadLetterCount,
    abandoned_dead_letter_count: abandonedDeadLetterCount,
    address_pool_available_count: addressPoolAvailableCount
  });
});

app.get("/api/v1/chain-monitor/unmatched", requirePermission("monitor.read"), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const rows = db
    .prepare(`SELECT * FROM chain_unmatched_events ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset);
  return res.json({ unmatched_events: rows, page: { limit, offset, returned: rows.length } });
});

app.get("/api/v1/chain-monitor/dead-letters", requirePermission("monitor.read"), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const rows = db.prepare(`SELECT * FROM chain_dead_letters ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  return res.json({ dead_letters: rows, page: { limit, offset, returned: rows.length } });
});

app.get("/api/v1/settlements/daily-status", requirePermission("settlement.close"), (req, res) => {
  const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.session.store_id);
  if (!store) return jsonError(res, 404, "NOT_FOUND", "Store not found");
  const defaultDate = DateTime.now().setZone(store.timezone || "Asia/Tokyo").toISODate();
  const businessDate = String(req.query.business_date || defaultDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return jsonError(res, 400, "VALIDATION_ERROR", "business_date must be YYYY-MM-DD");
  }
  const settlement = db.prepare(`SELECT * FROM settlements WHERE store_id = ? AND business_date = ?`).get(req.session.store_id, businessDate);
  return res.json({
    business_date: businessDate,
    closed: !!settlement,
    settlement: settlement || null
  });
});

app.post("/api/v1/settlements/daily:close", requirePermission("settlement.close"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/settlements/daily:close", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const businessDate = String(req.body?.business_date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "business_date must be YYYY-MM-DD" } } };
    }
    const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.session.store_id);
    if (!store) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Store not found" } } };
    const range = utcRangeForBusinessDate(businessDate, store.timezone);
    if (range.error) {
      return {
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: "Invalid business_date for timezone", details: range.details } }
      };
    }

    const result = db.transaction(() => {
      const existing = db.prepare(`SELECT * FROM settlements WHERE store_id = ? AND business_date = ?`).get(req.session.store_id, businessDate);
      if (existing) {
        const latestExportRun = db
          .prepare(
            `SELECT id FROM settlement_export_runs
             WHERE business_date = ? AND store_id = ?
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .get(businessDate, req.session.store_id);
        const existingSnapshotRows = latestExportRun
          ? db.prepare(`SELECT * FROM settlement_export_rows WHERE export_run_id = ? ORDER BY created_at ASC`).all(latestExportRun.id)
          : [];
        return {
          status: 200,
          body: {
            settlement_id: existing.id,
            business_date: existing.business_date,
            timezone: existing.timezone,
            totals: {
              invoice_count: existing.invoice_count,
              total_billed_jpy: existing.total_billed_jpy,
              total_paid_jpyc: existing.total_paid_jpyc,
              total_paid_jpyc_base: existing.total_paid_jpyc_base,
              review_count: existing.review_count
            },
            unresolved_review_policy: existing.unresolved_review_policy || resolveSettlementUnresolvedReviewPolicy(store),
            unresolved_review_reason: existing.unresolved_review_note || null,
            export_reference: `settlement-${businessDate}.csv`,
            export_run_id: latestExportRun?.id || null,
            accounting_summary: buildDailyAccountingSummary(existingSnapshotRows),
            already_closed: true,
            warning: Number(existing.review_count || 0) > 0 ? "UNRESOLVED_REVIEWS" : null,
            review_count: Number(existing.review_count || 0),
            review_invoice_ids: []
          }
        };
      }

      const allInvoices = db
        .prepare(
          `SELECT id, amount_jpy, paid_amount_jpyc, paid_amount_jpyc_base, status, settled_at
           FROM invoices
           WHERE store_id = ?
             AND created_at BETWEEN ? AND ?`
        )
        .all(req.session.store_id, range.fromUtc, range.toUtc);
      const targetInvoices = allInvoices.filter((row) => !row.settled_at && ["paid", "review_required"].includes(String(row.status)));
      const paidInvoices = targetInvoices.filter((row) => String(row.status) === "paid");
      const reviewInvoices = targetInvoices.filter((row) => String(row.status) === "review_required");
      const reviewInvoiceIds = reviewInvoices.map((row) => row.id);
      const unresolvedPolicy = resolveSettlementUnresolvedReviewPolicy(store);
      const unresolvedReviewReason = String(req.body?.unresolved_review_reason || "").trim();
      const adminApproval = req.body?.admin_approval === true;

      if (unresolvedPolicy === "block" && reviewInvoices.length > 0) {
        return {
          status: 409,
          body: {
            error: {
              code: "UNRESOLVED_REVIEWS",
              message: "unresolved reviews block settlement close",
              details: { review_count: reviewInvoices.length, review_invoice_ids: reviewInvoiceIds },
            },
          },
        };
      }
      if (unresolvedPolicy === "warn" && reviewInvoices.length > 0 && !adminApproval) {
        return {
          status: 409,
          body: {
            error: {
              code: "ADMIN_APPROVAL_REQUIRED",
              message: "admin_approval=true is required when unresolved reviews exist under warn policy",
              details: { review_count: reviewInvoices.length, review_invoice_ids: reviewInvoiceIds },
            },
          },
        };
      }
      if (unresolvedPolicy === "allow" && reviewInvoices.length > 0 && !unresolvedReviewReason) {
        return {
          status: 409,
          body: {
            error: {
              code: "UNRESOLVED_REVIEW_REASON_REQUIRED",
              message: "unresolved_review_reason is required when unresolved reviews exist under allow policy",
              details: { review_count: reviewInvoices.length, review_invoice_ids: reviewInvoiceIds },
            },
          },
        };
      }

      const refunds = db
        .prepare(
          `SELECT rr.id, rr.status, rr.invoice_id, rr.reason, rr.refund_amount_jpyc, rr.refund_tx_hash, rr.updated_at
           FROM refund_requests rr
           JOIN invoices i ON i.id = rr.invoice_id
           WHERE i.store_id = ?
             AND rr.created_at BETWEEN ? AND ?`
        )
        .all(req.session.store_id, range.fromUtc, range.toUtc);
      const refundCounts = {
        requested: refunds.filter((row) => String(row.status) === "requested").length,
        approved: refunds.filter((row) => String(row.status) === "approved").length,
        recorded: refunds.filter((row) => String(row.status) === "recorded").length,
        pending_verification: refunds.filter((row) => String(row.status) === "pending_verification").length,
        verification_failed: refunds.filter((row) => String(row.status) === "verification_failed").length,
        failed: refunds.filter((row) => String(row.status) === "failed").length,
        completed: refunds.filter((row) => String(row.status) === "succeeded").length,
      };
      const unresolvedRefunds = refunds.filter((row) => isUnresolvedRefundStatus(row.status));
      if (unresolvedRefunds.length > 0) {
        return {
          status: 409,
          body: {
            error: {
              code: "UNRESOLVED_REFUNDS",
              message: "締めできません。未完了の返金証跡を先に処理してください。",
              refund_counts: refundCounts,
              unresolved_refunds: unresolvedRefunds.map((row) => ({
                refund_case_id: row.id,
                invoice_id: row.invoice_id,
                status: row.status,
                reason: row.reason || null,
                refund_amount_jpyc: row.refund_amount_jpyc,
                refund_tx_hash: row.refund_tx_hash || null,
                updated_at: row.updated_at || null,
              })),
            },
          },
        };
      }
      const totalPaidBase = paidInvoices.reduce((acc, row) => acc + BigInt(String(row.paid_amount_jpyc_base || "0")), 0n);
      const invoiceStatusCounts = {
        paid: allInvoices.filter((row) => String(row.status) === "paid").length,
        settled: allInvoices.filter((row) => String(row.status) === "settled" || !!row.settled_at).length,
        review_required: allInvoices.filter((row) => String(row.status) === "review_required").length,
        cancelled: allInvoices.filter((row) => String(row.status) === "cancelled").length,
        expired: allInvoices.filter((row) => String(row.status) === "expired").length,
      };
      const totals = {
        paid_invoice_count: paidInvoices.length,
        invoice_count: targetInvoices.length,
        review_count: reviewInvoices.length,
        total_billed_jpy: targetInvoices.reduce((acc, row) => acc + Number(row.amount_jpy || 0), 0),
        total_paid_jpyc: Number(formatJpyc(totalPaidBase.toString())),
        total_paid_jpyc_base: totalPaidBase.toString(),
        review_invoice_ids: reviewInvoiceIds,
        invoice_status_counts: invoiceStatusCounts,
        refund_counts: refundCounts,
      };

      const settlementId = uuid();
      const closedAt = nowIso();
      db.prepare(
        `INSERT INTO settlements
         (id, merchant_id, store_id, business_date, timezone, period_start_utc, period_end_utc, invoice_count, total_billed_jpy, total_paid_jpyc, total_paid_jpyc_base, review_count, unresolved_review_policy, unresolved_review_note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        settlementId,
        store.merchant_id || "merchant-001",
        req.session.store_id,
        businessDate,
        store.timezone,
        range.fromUtc,
        range.toUtc,
        totals.invoice_count,
        totals.total_billed_jpy,
        totals.total_paid_jpyc,
        totals.total_paid_jpyc_base,
        totals.review_count,
        unresolvedPolicy,
        unresolvedReviewReason || null,
        actorId,
        closedAt
      );

      if (paidInvoices.length > 0) {
        const boundMarks = paidInvoices.map(() => "?").join(",");
        db.prepare(`UPDATE invoices SET settled_at = ?, settlement_id = ?, updated_at = ? WHERE id IN (${boundMarks})`).run(
          closedAt,
          settlementId,
          closedAt,
          ...paidInvoices.map((row) => row.id)
        );
      }

      audit({
        actorType: "admin",
        actorId,
        action: "settlement.closed",
        targetType: "settings",
        targetId: `${req.session.store_id}:${businessDate}`,
        requestId,
        idempotencyKey: idemKey,
        afterState: { settlement_id: settlementId, totals, timezone: store.timezone, range },
        ip: req.ip
      });
      const snapshot = createSettlementExportSnapshot({
        businessDate,
        store,
        terminalId: null,
        actorId,
        requestId,
        idempotencyKey: idemKey,
        ip: req.ip,
        range,
      });

      return {
        status: 200,
        body: {
          settlement_id: settlementId,
          business_date: businessDate,
          timezone: store.timezone,
          totals,
          unresolved_review_policy: unresolvedPolicy,
          unresolved_review_reason: unresolvedReviewReason || null,
          export_reference: `settlement-${businessDate}.csv`,
          export_run_id: snapshot.exportRunId,
          accounting_summary: snapshot.accountingSummary,
          already_closed: false,
          warning: reviewInvoices.length > 0 ? "UNRESOLVED_REVIEWS" : null,
          review_count: reviewInvoices.length,
          review_invoice_ids: reviewInvoiceIds
        }
      };
    })();

    return result;
  });
});

app.get("/api/v1/settlements/daily:export", requirePermission("settlement.export"), (req, res) => {
  const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.session.store_id);
  if (!store) return jsonError(res, 404, "NOT_FOUND", "Store not found");
  const defaultDate = DateTime.now().setZone(store.timezone || "Asia/Tokyo").toISODate();
  const businessDate = String(req.query.business_date || defaultDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return jsonError(res, 400, "VALIDATION_ERROR", "business_date must be YYYY-MM-DD");
  }
  const format = String(req.query.format || "json").trim().toLowerCase();
  if (!["json", "csv"].includes(format)) {
    return jsonError(res, 400, "VALIDATION_ERROR", "format must be json or csv");
  }

  const range = utcRangeForBusinessDate(businessDate, store.timezone || "Asia/Tokyo");
  if (range.error) {
    return jsonError(res, 400, "VALIDATION_ERROR", "Invalid business_date for timezone", range.details || {});
  }

  const rows = db
    .prepare(
	      `SELECT i.id AS invoice_id,
	              i.invoice_no,
	              i.settlement_id,
	              i.checkout_session_id,
	              i.merchant_id,
	              i.store_id,
	              i.terminal_id,
	              i.staff_user_id,
	              i.operator_id,
	              i.event_id,
	              i.booth_id,
              i.status AS invoice_status,
              i.status_reason,
              i.amount_jpy,
              i.amount_jpyc_base,
              i.paid_amount_jpyc_base,
              i.paid_tx_hash AS tx_hash,
              i.created_at,
              i.updated_at,
              i.settled_at,
	              r.id AS review_case_id,
	              r.reason_type AS reason_code,
	              r.reason_type AS review_reason_type,
	              r.status AS review_status,
	              r.block_timestamp,
	              r.detected_at,
	              r.audit_ref,
	              rr.id AS refund_request_id,
	              rr.status AS refund_status,
	              rr.refund_tx_hash,
	              rr.verified_at AS refund_verified_at
       FROM invoices i
       LEFT JOIN review_cases r ON r.invoice_id = i.id
       LEFT JOIN refund_requests rr ON rr.invoice_id = i.id
       WHERE i.store_id = ?
         AND i.created_at BETWEEN ? AND ?
       ORDER BY i.created_at ASC`
    )
    .all(req.session.store_id, range.fromUtc, range.toUtc);

  const totals = {
    invoice_count: rows.length,
    paid_count: rows.filter((row) => String(row.invoice_status) === "paid").length,
    settled_count: rows.filter((row) => String(row.invoice_status) === "settled" || !!row.settled_at).length,
    manual_review_count: rows.filter((row) => String(row.invoice_status) === "review_required").length,
    cancelled_count: rows.filter((row) => String(row.invoice_status) === "cancelled").length,
    expired_count: rows.filter((row) => String(row.invoice_status) === "expired").length,
    refund_requested_count: rows.filter((row) => String(row.refund_status) === "requested").length,
    refund_completed_count: rows.filter((row) => String(row.refund_status) === "succeeded").length,
  };
  const snapshot = db.transaction(() =>
    createSettlementExportSnapshot({
      businessDate,
      store,
      terminalId: null,
      actorId: req.session.staff_user_id,
      requestId: requestIdFromReq(req),
      idempotencyKey: null,
      ip: req.ip,
      range,
    })
  )();

	  const exportId = uuid();
	  const generatedAt = nowIso();
	  const exportPath = `api://settlements/${businessDate}/${exportId}.${format}`;
	  const exportReference = `settlement-${businessDate}.${format}`;
	  const contractRows = buildSettlementExportApiRows(snapshot.rows, {
	    exportReference,
	    exportRunId: snapshot.exportRunId,
	    businessDate,
	  });
  db.prepare(
    `INSERT INTO settlement_exports
     (id, merchant_id, store_id, business_date, format, output_path, generated_by, generated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    exportId,
    store.merchant_id || "merchant-001",
    store.id,
    businessDate,
    format,
    exportPath,
    req.session.staff_user_id,
    generatedAt,
    JSON.stringify({ totals, timezone: store.timezone, period_start_utc: range.fromUtc, period_end_utc: range.toUtc })
  );

	  if (format === "csv") {
	    res.setHeader("content-type", "text/csv; charset=utf-8");
	    return res.send(buildSettlementExportCsv(contractRows));
	  }

  return res.json({
    export_id: exportId,
    export_run_id: snapshot.exportRunId,
    business_date: businessDate,
    timezone: store.timezone || "Asia/Tokyo",
    period_start_utc: range.fromUtc,
    period_end_utc: range.toUtc,
    totals,
    accounting_summary: snapshot.accountingSummary,
	    rows: contractRows,
	  });
	});

app.get("/api/v1/settlements/monthly:export", requirePermission("settlement.export"), (req, res) => {
  const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.session.store_id);
  if (!store) return jsonError(res, 404, "NOT_FOUND", "Store not found");
  const defaultMonth = DateTime.now().setZone(store.timezone || "Asia/Tokyo").toFormat("yyyy-MM");
  const yearMonth = String(req.query.year_month || defaultMonth || "").trim();
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    return jsonError(res, 400, "VALIDATION_ERROR", "year_month must be YYYY-MM");
  }
  const format = String(req.query.format || "csv").trim().toLowerCase();
  if (!["json", "csv"].includes(format)) {
    return jsonError(res, 400, "VALIDATION_ERROR", "format must be json or csv");
  }

  const timezone = store.timezone || "Asia/Tokyo";
  const range = utcRangeForBusinessMonth(yearMonth, timezone);
  if (range.error) {
    return jsonError(res, 400, "VALIDATION_ERROR", "Invalid year_month for timezone", range.details || {});
  }

  const rows = db
    .prepare(
	      `SELECT i.id AS invoice_id,
	              i.invoice_no,
	              i.settlement_id,
	              i.checkout_session_id,
	              i.merchant_id,
	              i.store_id,
	              i.terminal_id,
	              i.staff_user_id,
	              i.operator_id,
	              i.event_id,
	              i.booth_id,
              i.status AS invoice_status,
              i.status_reason,
              i.amount_jpy,
              i.amount_jpyc_base,
              i.paid_amount_jpyc_base,
              i.paid_tx_hash AS tx_hash,
              i.created_at,
              i.updated_at,
              i.settled_at,
	              r.id AS review_case_id,
	              r.reason_type AS reason_code,
	              r.reason_type AS review_reason_type,
	              r.status AS review_status,
	              r.block_timestamp,
	              r.detected_at,
	              r.audit_ref,
	              rr.id AS refund_request_id,
	              rr.status AS refund_status,
	              rr.refund_tx_hash,
	              rr.verified_at AS refund_verified_at
       FROM invoices i
       LEFT JOIN review_cases r ON r.invoice_id = i.id
       LEFT JOIN refund_requests rr ON rr.invoice_id = i.id
       WHERE i.store_id = ?
         AND i.created_at BETWEEN ? AND ?
       ORDER BY i.created_at ASC`
    )
    .all(req.session.store_id, range.fromUtc, range.toUtc);

  const totals = {
    invoice_count: rows.length,
    paid_count: rows.filter((row) => String(row.invoice_status) === "paid").length,
    settled_count: rows.filter((row) => String(row.invoice_status) === "settled" || !!row.settled_at).length,
    manual_review_count: rows.filter((row) => String(row.invoice_status) === "review_required").length,
    cancelled_count: rows.filter((row) => String(row.invoice_status) === "cancelled").length,
    expired_count: rows.filter((row) => String(row.invoice_status) === "expired").length,
    refund_requested_count: rows.filter((row) => String(row.refund_status) === "requested").length,
    refund_completed_count: rows.filter((row) => String(row.refund_status) === "succeeded").length,
  };

	  const exportId = uuid();
	  const generatedAt = nowIso();
	  const exportPath = `api://settlements/monthly/${yearMonth}/${exportId}.${format}`;
	  const exportReference = `settlement-monthly-${yearMonth}.${format}`;
	  const exportRunId = exportId;
	  const canonicalRows = buildSettlementExportRowsForRange({ store, range, exportRunId });
	  const contractRows = buildSettlementExportApiRows(canonicalRows, {
	    exportReference,
	    exportRunId,
	  });
  db.prepare(
    `INSERT INTO settlement_exports
     (id, merchant_id, store_id, business_date, format, output_path, generated_by, generated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    exportId,
    store.merchant_id || "merchant-001",
    store.id,
    `${yearMonth}-01`,
    format,
    exportPath,
    req.session.staff_user_id,
    generatedAt,
    JSON.stringify({
      export_scope: "monthly",
      year_month: yearMonth,
      totals,
      timezone,
      period_start_utc: range.fromUtc,
      period_end_utc: range.toUtc,
    })
  );

	  if (format === "csv") {
	    res.setHeader("content-type", "text/csv; charset=utf-8");
	    res.setHeader("content-disposition", `attachment; filename="settlement-monthly-${yearMonth}.csv"`);
	    return res.send(buildSettlementExportCsv(contractRows));
	  }

  return res.json({
    export_id: exportId,
    year_month: yearMonth,
    timezone,
    period_start_utc: range.fromUtc,
    period_end_utc: range.toUtc,
    totals,
	    rows: contractRows,
	  });
	});

app.get("/api/v1/streams/terminals/:terminalId", (req, res) => {
  const terminalId = String(req.params.terminalId || "");
  const invoiceId = String(req.query.invoice_id || "");
  const sseToken = String(req.query.sse_token || "");
  const verified = verifySseToken(sseToken, { invoiceId, terminalId });
  if (!verified.ok) {
    const status = verified.code === "SSE_TOKEN_EXPIRED" ? 401 : 403;
    return jsonError(res, status, verified.code, verified.message);
  }
  const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ? AND terminal_id = ?`).get(invoiceId, terminalId);
  if (!invoice) {
    return jsonError(res, 404, "NOT_FOUND", "Invoice not found");
  }
  if (String(invoice.store_id) !== String(verified.payload.store_id || "")) {
    return jsonError(res, 403, "FORBIDDEN", "Store mismatch");
  }
  const activeSession = db
    .prepare(
      `SELECT id
       FROM terminal_sessions
       WHERE id = ?
         AND terminal_id = ?
         AND revoked_at IS NULL
         AND ended_at IS NULL`
    )
    .get(String(verified.payload.session_id || ""), terminalId);
  if (!activeSession) {
    return jsonError(res, 403, "FORBIDDEN", "Session is no longer active");
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const clients = clientsByTerminal.get(terminalId) || new Set();
  const client = { res, invoiceId };
  clients.add(client);
  clientsByTerminal.set(terminalId, clients);
  logCorrelationEvent("sse.connected", invoice, {
    status: invoice.status,
    status_version: invoice.updated_at,
    terminal_id: terminalId,
    store_id: invoice.store_id,
    details: {
      client_count: clients.size,
      last_event_id: req.header("last-event-id") || null,
    },
  });

  const writeHeartbeat = () => {
    if (res.writableEnded) return;
    try {
      res.write(`event: heartbeat\ndata: {"ts":"${nowIso()}"}\n\n`);
    } catch (error) {
      console.warn(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "sse.heartbeat_failed",
          terminal_id: terminalId,
          message: String(error.message || error),
        })
      );
    }
  };
  try {
    const snapshotPayload = {
      invoiceId: invoice.id,
      status: invoice.status,
      status_reason: invoice.status_reason,
      paid_tx_hash: invoice.paid_tx_hash,
      last_event_id: req.header("last-event-id") || null,
    };
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshotPayload)}\n\n`);
    res.write(`event: invoice.updated\ndata: ${JSON.stringify(snapshotPayload)}\n\n`);
  } catch (error) {
    return jsonError(res, 500, "SSE_SNAPSHOT_FAILED", String(error.message || error));
  }
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, 30_000);

  const cleanup = () => {
    clearInterval(heartbeatTimer);
    const set = clientsByTerminal.get(terminalId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) clientsByTerminal.delete(terminalId);
    logCorrelationEvent("sse.disconnected", invoice, {
      status: invoice.status,
      status_version: invoice.updated_at,
      terminal_id: terminalId,
      store_id: invoice.store_id,
      details: {
        remaining_client_count: set.size,
      },
    });
  };
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
});

app.get("/api/v1/public/config", (_req, res) => {
  const commercial = evaluateCommercialRuntimeGate();
  const policy = buildPolicySnapshot();
  return res.json({
    app_env: APP_ENV,
    commercial_go_mode: commercial.commercial_go_mode,
    commercial_verdict: commercial.commercial_verdict,
    demo_controls_enabled: DEMO_CONTROLS_ENABLED,
    public_payment_simulation_enabled: ENABLE_PUBLIC_PAYMENT_SIMULATION,
	    diagnostic_mode_enabled: DIAGNOSTIC_MODE_ENABLED,
	    wallet_adapter: WALLET_ADAPTER,
	    policy: policy.snapshot,
	  });
	});

app.get("/api/v1/public/terminal-entry/:publicEntryToken", (req, res) => {
  const publicEntryToken = String(req.params.publicEntryToken || "").trim();
  if (!publicEntryToken) {
    return jsonError(res, 400, "VALIDATION_ERROR", "Terminal entry token is required");
  }
  if (isPublicRateLimited(`public:terminal-entry:${req.ip}:${publicEntryToken}`)) {
    return jsonError(res, 429, "RATE_LIMITED", "Too many requests");
  }
  const entry = buildPublicTerminalEntryState(publicEntryToken);
  if (!entry) {
    return jsonError(res, 404, "NOT_FOUND", "Terminal entry not found");
  }
  return res.json(entry);
});

app.get("/api/v1/public/invoices/:invoiceId", (req, res) => {
  const invoiceId = req.params.invoiceId;
  if (isPublicRateLimited(`public:get:${req.ip}:${invoiceId}`)) {
    return jsonError(res, 429, "RATE_LIMITED", "Too many requests");
  }
  const sig = String(req.query.sig || "");
  const exp = String(req.query.exp || "");
  const nonce = String(req.query.nonce || "");
  const verified = verifySig(invoiceId, exp, nonce, sig);
  if (!verified.ok) return jsonError(res, 401, "UNAUTHORIZED", "Invalid invoice signature");
  const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId);
  if (!invoice) return jsonError(res, 404, "NOT_FOUND", "Invoice not found");
  const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(invoice.store_id);
  const walletPayload = buildInvoiceWalletPayload(invoice, store);
  const providerSummary = buildProviderSummary(invoice);
  const policy = buildPolicySnapshot();
  res.json({
    invoice_id: invoice.id,
    invoice_no: invoice.invoice_no,
    amount_jpy: invoice.amount_jpy,
    amount_jpyc: invoice.amount_jpyc,
    amount_jpyc_base: invoice.amount_jpyc_base,
    status: invoice.status,
    issued_at: invoice.created_at,
    created_at: invoice.created_at,
    expires_at: invoice.expires_at,
    chain_id: invoice.chain_id,
    token_contract: invoice.token_contract,
    recipient_address: invoice.recipient_address,
    store_name: store?.name || "JPYC Store",
    public_payment_simulation_enabled: ENABLE_PUBLIC_PAYMENT_SIMULATION,
    payment_url: invoice.payment_url,
    pay_url: invoice.payment_url,
	    customer_payment_mode: providerSummary.customer_payment_mode,
	    policy: policy.snapshot,
	    ...walletPayload,
	  });
});

app.post("/api/v1/public/invoices/:invoiceId/pay", (req, res) => {
  if (!ENABLE_PUBLIC_PAYMENT_SIMULATION) {
    return jsonError(res, 403, "SIMULATION_DISABLED", "Public payment simulation is disabled in this environment");
  }
  if (isPaymentsDisabled()) {
    return jsonError(res, 503, "PAYMENTS_DISABLED", "Payments are temporarily disabled");
  }
  const invoiceId = req.params.invoiceId;
  if (isPublicRateLimited(`public:pay:${req.ip}:${invoiceId}`)) {
    return jsonError(res, 429, "RATE_LIMITED", "Too many requests");
  }
  const sig = String(req.query.sig || "");
  const exp = String(req.query.exp || "");
  const nonce = String(req.query.nonce || "");
  const verified = verifySig(invoiceId, exp, nonce, sig);
  if (!verified.ok) return jsonError(res, 401, "UNAUTHORIZED", "Invalid invoice signature");

  const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId);
  if (!invoice) return jsonError(res, 404, "NOT_FOUND", "Invoice not found");

  const body = req.body || {};
  const txHash = parseTxHash(body.tx_hash);
  if (!txHash) {
    return jsonError(res, 400, "VALIDATION_ERROR", "tx_hash is required and must be a 0x-prefixed 32-byte hash");
  }
  const amountRaw = body.amount_jpyc ?? invoice.amount_jpyc;
  const amountBase = toBaseUnits(amountRaw);
  if (amountBase.error || BigInt(amountBase.value) <= 0n) {
    return jsonError(res, 400, "VALIDATION_ERROR", "amount_jpyc must be positive amount");
  }
  const chainId = String(body.chain_id ?? invoice.chain_id);
  const token = String(body.token_contract ?? invoice.token_contract);
  const toAddress = String(body.to_address ?? invoice.recipient_address);
  const confirmations = Number(body.confirmations ?? REQUIRED_CONFIRMATIONS);
  if (!Number.isFinite(confirmations) || confirmations < REQUIRED_CONFIRMATIONS) {
    return jsonError(
      res,
      400,
      "VALIDATION_ERROR",
      `confirmations must be >= REQUIRED_CONFIRMATIONS (${REQUIRED_CONFIRMATIONS})`
    );
  }
  const fromAddress = String(body.from_address || "0xcustomer");

  const event = {
    invoice_id: invoiceId,
    chain_id: chainId,
    tx_hash: txHash,
    token_contract: token,
    to_address: toAddress,
    from_address: fromAddress,
    confirmations,
    amount_jpyc: amountRaw,
    amount_jpyc_base: amountBase.value,
    log_index: Number(body.log_index ?? 0),
    block_number: Number(body.block_number ?? 0),
    observed_at: nowIso(),
  };

  const decision = processPaymentEvent({
    invoice,
    event,
    requestId: requestIdFromReq(req),
    idempotencyKey: null,
    actorType: "service",
    actorId: "public.payment",
    action: "payment.public_submitted",
    ip: req.ip
  });
  res.status(decision.status).json(decision.body);
});

app.post("/api/v1/public/invoices/:invoiceId/consent", (req, res) => {
  const invoiceId = req.params.invoiceId;
  if (isPublicRateLimited(`public:consent:${req.ip}:${invoiceId}`)) {
    return jsonError(res, 429, "RATE_LIMITED", "Too many requests");
  }
  const sig = String(req.query.sig || "");
  const exp = String(req.query.exp || "");
  const nonce = String(req.query.nonce || "");
  const verified = verifySig(invoiceId, exp, nonce, sig);
  if (!verified.ok) return jsonError(res, 401, "UNAUTHORIZED", "Invalid invoice signature");
		  const invoice = db.prepare(`SELECT id, status FROM invoices WHERE id = ?`).get(invoiceId);
		  if (!invoice) return jsonError(res, 404, "NOT_FOUND", "Invoice not found");
		  const body = req.body || {};
		  const allowedConsentKeys = new Set(["checked", "displayed_policy_hash", "client_rendered_at"]);
		  const unexpectedKeys = Object.keys(body).filter((key) => !allowedConsentKeys.has(key));
		  if (unexpectedKeys.length > 0) {
		    return jsonError(res, 400, "VALIDATION_ERROR", "client policy fields are not accepted", { unexpected_keys: unexpectedKeys });
		  }
		  if (body.checked !== true) {
		    return jsonError(res, 400, "CONSENT_REQUIRED", "checked=true is required");
		  }
		  const policy = buildPolicySnapshot();
		  const policySnapshot = policy.snapshot;
		  if (!policy.ok) {
		    return jsonError(res, 503, "POLICY_CONFIG_REQUIRED", "public policy URLs are not configured");
		  }
		  const policySnapshotHash = hashJson(policySnapshot);
		  const displayedPolicyHash = String(body.displayed_policy_hash || "").trim();
		  if (!displayedPolicyHash || displayedPolicyHash !== policySnapshotHash) {
		    return jsonError(res, 409, "POLICY_MISMATCH", "displayed policy snapshot does not match server policy", {
		      expected_policy_hash: policySnapshotHash,
		    });
		  }
		  const consentedAt = nowIso();
		  const consentRecordId = `consent_${sha256(`${invoiceId}:${policySnapshotHash}:${consentedAt}:${nonce}`).slice(0, 32)}`;
		  audit({
	    actorType: "customer_anonymous",
	    actorId: invoiceId,
    action: "customer_policy_consent",
    targetType: "invoice",
    targetId: invoiceId,
    requestId: null,
    idempotencyKey: null,
    beforeState: null,
		    afterState: {
		      consent_record_id: consentRecordId,
		      invoice_id: invoiceId,
		      policy_snapshot_hash: policySnapshotHash,
		      ...policySnapshot,
		      consented_at: consentedAt,
		      client_rendered_at: body.client_rendered_at || null,
		      actor_context: { ip_present: Boolean(req.ip), user_agent_present: Boolean(req.get("user-agent")) },
		    },
		    ip: req.ip,
		  });
		  return res.json({ ok: true, consent_record_id: consentRecordId, consent_token: consentRecordId, policy_snapshot_hash: policySnapshotHash, recorded_at: consentedAt });
		});

app.use((error, req, res, next) => {
  if (!error) return next();
  if (error.type === "entity.parse.failed") {
    return jsonError(res, 400, "INVALID_JSON", "Request body must be valid JSON");
  }
  if (String(error.message || "").includes("CORS origin rejected")) {
    return jsonError(res, 403, "CORS_FORBIDDEN", "Origin is not allowed");
  }
  console.error(
    JSON.stringify({
      ts: nowIso(),
      level: "error",
      type: "http.error",
      request_id: requestIdFromReq(req),
      path: req.originalUrl || req.path,
      method: req.method,
      message: String(error.message || error)
    })
  );
  return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error");
});

let serverInstance = null;
let shutdownStarted = false;
export function startServer() {
  if (serverInstance) return serverInstance;
  serverInstance = app.listen(PORT, () => {
    console.log(`JPYC production server started on ${APP_HOST} (port ${PORT})`);
    console.log(`DB path: ${DB_PATH}`);
  });
  return serverInstance;
}

export { app, runInvoiceExpirySweepOnce };

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
async function shutdown(signal = "shutdown") {
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearInterval(expirySweepTimer);
  try {
    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(() => resolve()));
    }
  } catch (_error) {
    // no-op
  }
  try {
    db.close();
  } catch (_error) {
    // no-op
  }
  console.log(JSON.stringify({ ts: nowIso(), level: "info", type: "app.shutdown", signal }));
  process.exit(0);
}

if (isMainModule) {
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  startServer();
}
