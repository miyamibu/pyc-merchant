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
  normalizeLegacySettlementRows,
} from "./settlement-export.mjs";
import { planRefundFundingAllocation } from "./refund-funding-allocation.mjs";
import {
  evaluatePolicyPublicationSource,
  isPublishedPolicyHash,
  isPublishedPolicyUrl,
  isPublishedPolicyVersion,
  POLICY_CONTENT_HASH_CANONICALIZATION,
  unavailablePolicyPublication,
  validatePolicyVersionSubmission,
  verifyPolicyContentHashes,
} from "./policy-publication.mjs";
import {
  JPYC_CONTRACT_REFERENCE,
  JPYC_PREPAID_DENYLIST_CONTRACTS,
  OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER,
  getSupportedPaymentChain,
  listEnabledPaymentChains,
  networkLabelForChainId,
  normalizeJpycPolicyAddress,
  parseEnabledPaymentChainIds,
  paymentChainForInvoiceRequest,
  publicPaymentChain,
  validateOfficialJpycContract,
} from "./jpyc-contract-policy.mjs";
import { validateCommercialEvidence } from "../scripts/production-validation/validate-commercial-evidence.mjs";
import { APPROVED_LEDGER_BASE_UNIT_SCALE, APPROVED_TOKEN_DECIMALS } from "./token-metadata.mjs";

const CWD = process.cwd();
const DEFAULTS = {
  APP_ENV: "development",
  NODE_ENV: "",
  APP_PORT: "4173",
  PORT: "",
  APP_HOST: "http://localhost:4173",
  APP_BIND_HOST: "",
  INTERNAL_APP_ORIGIN: "",
  PAY_BASE_URL: "",
  PUBLIC_BASE_URL: "",
  APP_SECRET: "__REPLACE_WITH_LONG_RANDOM_SECRET__",
  DB_PATH: "./data/app.db",
  CHAIN_ID: "137",
  ENABLED_PAYMENT_CHAIN_IDS: "137",
  TOKEN_DECIMALS: "18",
  TOKEN_SYMBOL: "JPYC",
  APPROVED_TOKEN_NAME: "",
  APPROVED_TOKEN_CODE_HASH: "",
  APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH: "",
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
  PUBLIC_LINK_GRACE_SEC: "86400",
  PUBLIC_RATE_LIMIT_WINDOW_MS: "60000",
  PUBLIC_RATE_LIMIT_MAX: "120",
  LOGIN_RATE_LIMIT_WINDOW_MS: "600000",
  LOGIN_RATE_LIMIT_MAX: "10",
  TRUST_PROXY: "true",
  TRUST_PROXY_HOPS: "",
  TRUST_PROXY_CIDRS: "",
  WALLET_ADAPTER_TYPE: "mock",
  ENABLE_REOWN: "false",
  REOWN_PROJECT_ID: "",
  WALLET_HELP_URL: "",
  WALLET_DEEPLINK_TEMPLATE: "",
  HASHPORT_WALLET_DEEPLINK_TEMPLATE: "",
  WALLET_ADAPTER_ID: "",
  WALLET_ADAPTER_REGISTRY_JSON: "",
  SUPPORTED_WALLETS: "HashPort Wallet,WalletConnect,Injected Wallet",
  DIAGNOSTIC_MODE_ENABLED: "false",
  DIAGNOSTIC_MODE_APPROVAL_REF: "",
  ENABLE_PUBLIC_PAYMENT_SIMULATION: "false",
  DEMO_CONTROLS_ENABLED: "false",
  ALLOW_MANUAL_PAYMENT_INGEST: "false",
  ENABLE_PROVIDER_RAIL_MOCK: "false",
  MANUAL_INGEST_APPROVAL_REF: "",
  COMMERCIAL_GO_MODE: "false",
  DEPLOYMENT_STAGE: "",
  COMMERCIAL_EVIDENCE_ROOT: "./docs/production/evidence",
  COMMERCIAL_EVIDENCE_DIR: "",
  RELEASE_ID: "",
  RELEASE_MANIFEST: "",
  RELEASE_TRUSTED_PUBLIC_KEY_PATHS: "",
  RELEASE_REVOKED_KEY_IDS: "",
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
  REFUND_TREASURY_ADDRESS: "",
  REFUND_TREASURY_APPROVAL_REF: "",
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
  RPC_URLS_1: "",
  RPC_URLS_43114: "",
  RPC_URLS_137: "",
  MONITOR_BACKSCAN_BLOCKS: "12",
  MIN_MONITOR_BACKSCAN_BLOCKS: "12",
  MONITOR_LOG_CHUNK_SIZE: "1000",
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
const APP_BIND_HOST = String(ENV.APP_BIND_HOST || DEFAULTS.APP_BIND_HOST || "").trim();
const INTERNAL_APP_ORIGIN = String(ENV.INTERNAL_APP_ORIGIN || DEFAULTS.INTERNAL_APP_ORIGIN || "").trim();
const APP_SECRET = ENV.APP_SECRET || DEFAULTS.APP_SECRET;
const DB_PATH = path.resolve(CWD, ENV.DB_PATH || DEFAULTS.DB_PATH);
const CHAIN_ID = String(ENV.CHAIN_ID || DEFAULTS.CHAIN_ID).trim();
const ENABLED_PAYMENT_CHAIN_IDS = parseEnabledPaymentChainIds(
  ENV.ENABLED_PAYMENT_CHAIN_IDS || DEFAULTS.ENABLED_PAYMENT_CHAIN_IDS
);
const TOKEN_DECIMALS = Number(ENV.TOKEN_DECIMALS || DEFAULTS.TOKEN_DECIMALS);
const TOKEN_SYMBOL = String(ENV.TOKEN_SYMBOL || DEFAULTS.TOKEN_SYMBOL || "JPYC").trim() || "JPYC";
const APPROVED_TOKEN_NAME = String(ENV.APPROVED_TOKEN_NAME || DEFAULTS.APPROVED_TOKEN_NAME || "").trim();
const APPROVED_TOKEN_CODE_HASH = String(ENV.APPROVED_TOKEN_CODE_HASH || DEFAULTS.APPROVED_TOKEN_CODE_HASH || "").trim().toLowerCase();
const APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH = String(
  ENV.APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH || DEFAULTS.APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH || ""
).trim().toLowerCase();
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
const PUBLIC_RATE_LIMIT_WINDOW_MS = Number(ENV.PUBLIC_RATE_LIMIT_WINDOW_MS || DEFAULTS.PUBLIC_RATE_LIMIT_WINDOW_MS);
const PUBLIC_RATE_LIMIT_MAX = Number(ENV.PUBLIC_RATE_LIMIT_MAX || DEFAULTS.PUBLIC_RATE_LIMIT_MAX);
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(ENV.LOGIN_RATE_LIMIT_WINDOW_MS || DEFAULTS.LOGIN_RATE_LIMIT_WINDOW_MS);
const LOGIN_RATE_LIMIT_MAX = Number(ENV.LOGIN_RATE_LIMIT_MAX || DEFAULTS.LOGIN_RATE_LIMIT_MAX);
const TRUST_PROXY = parseFlag(ENV.TRUST_PROXY ?? DEFAULTS.TRUST_PROXY, true);
const TRUST_PROXY_HOPS_RAW = String(ENV.TRUST_PROXY_HOPS ?? DEFAULTS.TRUST_PROXY_HOPS ?? "").trim();
const TRUST_PROXY_HOPS = TRUST_PROXY_HOPS_RAW === "" ? null : Number(TRUST_PROXY_HOPS_RAW);
const TRUST_PROXY_CIDRS = String(ENV.TRUST_PROXY_CIDRS ?? DEFAULTS.TRUST_PROXY_CIDRS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const TRUST_PROXY_CONFIGURED = TRUST_PROXY && (
  (Number.isInteger(TRUST_PROXY_HOPS) && TRUST_PROXY_HOPS >= 1)
  || TRUST_PROXY_CIDRS.length > 0
);
const EXPRESS_TRUST_PROXY = !TRUST_PROXY
  ? false
  : (Number.isInteger(TRUST_PROXY_HOPS) && TRUST_PROXY_HOPS >= 1
      ? TRUST_PROXY_HOPS
      : TRUST_PROXY_CIDRS.length > 0 ? TRUST_PROXY_CIDRS : false);
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
const DEPLOYMENT_STAGE = String(
  ENV.DEPLOYMENT_STAGE || DEFAULTS.DEPLOYMENT_STAGE || (IS_PRODUCTION ? "commercial" : "development")
).trim().toLowerCase();
const PRODUCTION_LIKE_RUNTIME = IS_PRODUCTION || ["pilot", "commercial"].includes(DEPLOYMENT_STAGE) || COMMERCIAL_GO_MODE;
const COMMERCIAL_EVIDENCE_ROOT = path.resolve(CWD, ENV.COMMERCIAL_EVIDENCE_ROOT || DEFAULTS.COMMERCIAL_EVIDENCE_ROOT);
const COMMERCIAL_EVIDENCE_DIR = String(ENV.COMMERCIAL_EVIDENCE_DIR || DEFAULTS.COMMERCIAL_EVIDENCE_DIR || "").trim();
const RELEASE_ID = String(ENV.RELEASE_ID || DEFAULTS.RELEASE_ID || "").trim();
const RELEASE_MANIFEST = String(ENV.RELEASE_MANIFEST || DEFAULTS.RELEASE_MANIFEST || "").trim();
const RELEASE_TRUSTED_PUBLIC_KEY_PATHS = String(
  ENV.RELEASE_TRUSTED_PUBLIC_KEY_PATHS || DEFAULTS.RELEASE_TRUSTED_PUBLIC_KEY_PATHS || ""
).split(",").map((value) => value.trim()).filter(Boolean);
const RELEASE_REVOKED_KEY_IDS = new Set(String(
  ENV.RELEASE_REVOKED_KEY_IDS || DEFAULTS.RELEASE_REVOKED_KEY_IDS || ""
).split(",").map((value) => value.trim()).filter(Boolean));
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
const REFUND_TREASURY_ADDRESS = String(ENV.REFUND_TREASURY_ADDRESS || DEFAULTS.REFUND_TREASURY_ADDRESS || "").trim();
const REFUND_TREASURY_APPROVAL_REF = String(
  ENV.REFUND_TREASURY_APPROVAL_REF || DEFAULTS.REFUND_TREASURY_APPROVAL_REF || ""
).trim();
if (PRODUCTION_LIKE_RUNTIME && !INTERNAL_APP_ORIGIN) {
  console.error("FATAL: INTERNAL_APP_ORIGIN is required for production-like worker ingest.");
  process.exit(1);
}
if (PRODUCTION_LIKE_RUNTIME && INTERNAL_APP_ORIGIN && INTERNAL_APP_ORIGIN === APP_HOST) {
  console.error("FATAL: INTERNAL_APP_ORIGIN must not equal the public APP_HOST.");
  process.exit(1);
}
const REQUIRED_CONFIRMATIONS = Number(ENV.REQUIRED_CONFIRMATIONS || DEFAULTS.REQUIRED_CONFIRMATIONS);
const MIN_REQUIRED_CONFIRMATIONS = Number(ENV.MIN_REQUIRED_CONFIRMATIONS || DEFAULTS.MIN_REQUIRED_CONFIRMATIONS);
const MONITOR_LOG_CHUNK_SIZE = Number(ENV.MONITOR_LOG_CHUNK_SIZE || DEFAULTS.MONITOR_LOG_CHUNK_SIZE);
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
const TOKEN_CONTRACT_NORMALIZED = normalizeJpycPolicyAddress(TOKEN_CONTRACT);
const APPROVED_JPYC_TOKEN_CONTRACT_NORMALIZED = normalizeJpycPolicyAddress(APPROVED_JPYC_TOKEN_CONTRACT);
const APPROVED_TOKEN_CONTRACT = OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER;
const {
  toBaseUnits,
  decidePaymentStatus,
  decideQualifiedPaymentStatus,
} = makePaymentLogic({
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

const tokenContractValidation = validateOfficialJpycContract(TOKEN_CONTRACT, "TOKEN_CONTRACT");
if (!tokenContractValidation.ok) {
  console.error(`FATAL: ${tokenContractValidation.code}: ${tokenContractValidation.message}`);
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
  const productionWalletAdapterType = String(ENV.WALLET_ADAPTER_TYPE || "mock").trim().toLowerCase();
  if (!["wallet_deeplink", "hashport_deeplink"].includes(productionWalletAdapterType)) {
    console.error("FATAL: production requires WALLET_ADAPTER_TYPE=wallet_deeplink or hashport_deeplink.");
    process.exit(1);
  }
  if (!WALLET_ADAPTER.available || !WALLET_ADAPTER.wallet_deeplink_template_configured) {
    console.error("FATAL: production wallet deeplink adapter is not fully configured.");
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
  if (!APPROVED_TOKEN_NAME || !/^0x[0-9a-f]{64}$/.test(APPROVED_TOKEN_CODE_HASH)
    || !/^0x[0-9a-f]{64}$/.test(APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH)) {
    console.error("FATAL: production requires approved token name, code hash, and implementation code hash pins.");
    process.exit(1);
  }
  if (INSECURE_SECRETS.has(METRICS_SECRET) || METRICS_SECRET.length < 32 || isWeakSecretValue(METRICS_SECRET)) {
    console.error("FATAL: METRICS_SECRET must be configured securely in production.");
    process.exit(1);
  }
  if (CORS_ALLOW_ORIGINS.some((origin) => origin === "*" || origin.includes("*"))) {
    console.error("FATAL: CORS_ALLOW_ORIGINS wildcard is not allowed in production.");
    process.exit(1);
  }
  if (!TRUST_PROXY_CONFIGURED) {
    console.error("FATAL: production TRUST_PROXY requires TRUST_PROXY_HOPS or TRUST_PROXY_CIDRS.");
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
  if (!ENABLED_PAYMENT_CHAIN_IDS.includes(CHAIN_ID)) {
    console.error("FATAL: CHAIN_ID must be included in ENABLED_PAYMENT_CHAIN_IDS.");
    process.exit(1);
  }
  if (ENABLED_PAYMENT_CHAIN_IDS.length > 1) {
    console.error("FATAL: multi-chain production issuance requires an approved per-chain policy and credential registry.");
    process.exit(1);
  }
  if (!isEvmAddress(REFUND_TREASURY_ADDRESS)) {
    console.error("FATAL: REFUND_TREASURY_ADDRESS must be configured for production refund verification.");
    process.exit(1);
  }
  if (isPlaceholderLike(REFUND_TREASURY_APPROVAL_REF)) {
    console.error("FATAL: REFUND_TREASURY_APPROVAL_REF must identify the approved production treasury.");
    process.exit(1);
  }
  const approvedContractValidation = validateOfficialJpycContract(
    APPROVED_JPYC_TOKEN_CONTRACT,
    "APPROVED_JPYC_TOKEN_CONTRACT"
  );
  if (!approvedContractValidation.ok) {
    console.error(`FATAL: ${approvedContractValidation.code}: ${approvedContractValidation.message}`);
    process.exit(1);
  }
  if (TOKEN_CONTRACT_NORMALIZED !== APPROVED_JPYC_TOKEN_CONTRACT_NORMALIZED) {
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
  if (TOKEN_DECIMALS !== APPROVED_TOKEN_DECIMALS || JPYC_BASE_UNIT_SCALE !== APPROVED_LEDGER_BASE_UNIT_SCALE) {
    console.error("FATAL: production requires token atomic decimals=18 and ledger base scale=1000000.");
    process.exit(1);
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
  terms_url TEXT,
  privacy_url TEXT,
  refund_policy_url TEXT,
  terms_version TEXT,
  privacy_version TEXT,
  refund_policy_version TEXT,
  terms_hash TEXT,
  privacy_hash TEXT,
  refund_policy_hash TEXT,
  terms_content TEXT,
  privacy_content TEXT,
  refund_policy_content TEXT,
  refund_treasury_address TEXT,
  refund_treasury_chain_id TEXT,
  refund_treasury_approval_ref TEXT,
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
  business_date TEXT,
  status_reason TEXT,
  paid_amount_jpyc REAL NOT NULL DEFAULT 0,
  paid_amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  paid_tx_hash TEXT,
  policy_snapshot_json TEXT,
  monitor_until TEXT,
  integrity_hold INTEGER NOT NULL DEFAULT 0,
  integrity_hold_reason TEXT,
  integrity_hold_at TEXT,
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
  amount_atomic TEXT,
  chain_verified INTEGER NOT NULL DEFAULT 0,
  token_verified INTEGER NOT NULL DEFAULT 0,
  recipient_verified INTEGER NOT NULL DEFAULT 0,
  canonical_status TEXT NOT NULL DEFAULT 'unknown',
  within_expiry INTEGER NOT NULL DEFAULT 0,
  recognition_status TEXT NOT NULL DEFAULT 'pending',
  reorg_id TEXT,
  observed_at TEXT NOT NULL,
  block_hash TEXT,
  block_timestamp TEXT,
  detected_at TEXT,
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
  disposition TEXT,
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

CREATE TABLE IF NOT EXISTS refund_cases (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  related_review_case_id TEXT REFERENCES review_cases(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_cases_invoice ON refund_cases(invoice_id, created_at, id);

CREATE TABLE IF NOT EXISTS refund_requests (
  id TEXT PRIMARY KEY,
  review_case_id TEXT NOT NULL REFERENCES review_cases(id),
  refund_case_id TEXT REFERENCES refund_cases(id),
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
  customer_approval_signature TEXT,
  destination_approval_type TEXT,
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

CREATE TABLE IF NOT EXISTS refund_funding_lineage (
  id TEXT PRIMARY KEY,
  refund_request_id TEXT NOT NULL UNIQUE REFERENCES refund_requests(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  chain_id TEXT NOT NULL,
  source_address TEXT NOT NULL,
  treasury_address TEXT NOT NULL,
  sweep_tx_hash TEXT NOT NULL,
  sweep_tx_log_index INTEGER,
  sweep_amount_jpyc_base INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  evidence_note_path TEXT,
  evidence_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_refund_funding_lineage_sweep
ON refund_funding_lineage(chain_id, sweep_tx_hash, COALESCE(sweep_tx_log_index, -1));

CREATE TABLE IF NOT EXISTS refund_funding_allocations (
  id TEXT PRIMARY KEY,
  funding_lineage_id TEXT NOT NULL REFERENCES refund_funding_lineage(id),
  refund_request_id TEXT NOT NULL UNIQUE REFERENCES refund_requests(id),
  amount_jpyc_base INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_funding_allocations_lineage
ON refund_funding_allocations(funding_lineage_id, created_at ASC);

-- v2 funding evidence is sweep-primary and keeps the refund relationship
-- many-to-many. The legacy tables above remain readable for existing records,
-- but new verification uses these tables so one refund can consume several
-- independently verified sweeps without overwriting lineage.
CREATE TABLE IF NOT EXISTS refund_funding_sweeps (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  chain_id TEXT NOT NULL,
  source_address TEXT NOT NULL,
  treasury_address TEXT NOT NULL,
  sweep_tx_hash TEXT NOT NULL,
  sweep_tx_log_index INTEGER,
  sweep_amount_jpyc_base INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  evidence_note_path TEXT,
  evidence_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_refund_funding_sweeps_tx
ON refund_funding_sweeps(chain_id, sweep_tx_hash, COALESCE(sweep_tx_log_index, -1));

CREATE TABLE IF NOT EXISTS refund_funding_allocation_parts (
  id TEXT PRIMARY KEY,
  funding_sweep_id TEXT NOT NULL REFERENCES refund_funding_sweeps(id),
  refund_request_id TEXT NOT NULL REFERENCES refund_requests(id),
  amount_jpyc_base INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_funding_allocation_parts_refund
ON refund_funding_allocation_parts(refund_request_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_refund_funding_allocation_parts_sweep
ON refund_funding_allocation_parts(funding_sweep_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  store_id TEXT REFERENCES stores(id),
  audit_epoch TEXT,
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

CREATE TABLE IF NOT EXISTS audit_epochs (
  id TEXT PRIMARY KEY,
  start_rowid INTEGER NOT NULL UNIQUE,
  hash_version TEXT NOT NULL,
  previous_epoch_id TEXT,
  previous_tail_hash TEXT,
  reason TEXT NOT NULL,
  attestation_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_epochs_immutable_update
BEFORE UPDATE ON audit_epochs
BEGIN
  SELECT RAISE(ABORT, 'audit epochs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS audit_epochs_immutable_delete
BEFORE DELETE ON audit_epochs
BEGIN
  SELECT RAISE(ABORT, 'audit epochs are immutable');
END;

CREATE TABLE IF NOT EXISTS audit_log_store_attributions (
  audit_log_id TEXT PRIMARY KEY REFERENCES audit_logs(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  attribution_method TEXT NOT NULL,
  source_entry_hash TEXT NOT NULL,
  attestation_hash TEXT NOT NULL,
  attributed_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_log_store_attributions_immutable_update
BEFORE UPDATE ON audit_log_store_attributions
BEGIN
  SELECT RAISE(ABORT, 'audit store attributions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_store_attributions_immutable_delete
BEFORE DELETE ON audit_log_store_attributions
BEGIN
  SELECT RAISE(ABORT, 'audit store attributions are immutable');
END;

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

CREATE TABLE IF NOT EXISTS accounting_event_journal (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  event_type TEXT NOT NULL,
  business_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  amount_jpyc_base INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(store_id, event_type, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_accounting_event_journal_store_business_date
ON accounting_event_journal(store_id, business_date, occurred_at, id);

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
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_settlement_allocations_settlement_payment
ON provider_settlement_allocations(provider_settlement_id, provider_payment_id);

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
  observation_count INTEGER NOT NULL DEFAULT 0,
  retry_attempt_count INTEGER NOT NULL DEFAULT 0,
  consecutive_retry_failures INTEGER NOT NULL DEFAULT 0,
  last_observed_at TEXT,
  last_attempted_at TEXT,
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

CREATE TABLE IF NOT EXISTS chain_reorgs (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  from_block INTEGER,
  to_block INTEGER,
  previous_checkpoint_hash TEXT,
  observed_checkpoint_hash TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chain_reorgs_fingerprint
ON chain_reorgs(
  chain_id,
  COALESCE(from_block, -1),
  COALESCE(to_block, -1),
  COALESCE(previous_checkpoint_hash, ''),
  COALESCE(observed_checkpoint_hash, ''),
  reason
);
CREATE INDEX IF NOT EXISTS idx_chain_reorgs_status_detected_at
ON chain_reorgs(chain_id, status, detected_at DESC);

CREATE TABLE IF NOT EXISTS chain_rpc_failovers (
  id TEXT PRIMARY KEY,
  chain_id TEXT,
  provider_url TEXT NOT NULL,
  provider_url_hash TEXT,
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
addColumnIfMissing("invoices", "business_date", "business_date TEXT");
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
addColumnIfMissing("payment_events", "block_hash", "block_hash TEXT");
addColumnIfMissing("payment_events", "block_timestamp", "block_timestamp TEXT");
addColumnIfMissing("payment_events", "detected_at", "detected_at TEXT");
addColumnIfMissing("payment_attempts", "source", "source TEXT NOT NULL DEFAULT 'unknown'");
addColumnIfMissing("payment_attempts", "verified_onchain", "verified_onchain INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("refund_requests", "refund_amount_jpyc_base", "refund_amount_jpyc_base INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("refund_requests", "refund_eligible_jpyc_base", "refund_eligible_jpyc_base INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("refund_requests", "refund_tx_log_index", "refund_tx_log_index INTEGER");
addColumnIfMissing("refund_requests", "original_invoice_id", "original_invoice_id TEXT");
addColumnIfMissing("refund_requests", "checkout_session_id", "checkout_session_id TEXT");
addColumnIfMissing("refund_requests", "expected_from_address", "expected_from_address TEXT");
addColumnIfMissing("refund_requests", "refund_case_id", "refund_case_id TEXT");
addColumnIfMissing("refund_requests", "funding_lineage_id", "funding_lineage_id TEXT");
addColumnIfMissing("refund_requests", "customer_approval_signature", "customer_approval_signature TEXT");
addColumnIfMissing("refund_requests", "destination_approval_type", "destination_approval_type TEXT");
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
addColumnIfMissing("settlement_export_rows", "payload_json", "payload_json TEXT");
addColumnIfMissing("audit_logs", "prev_hash", "prev_hash TEXT");
addColumnIfMissing("audit_logs", "entry_hash", "entry_hash TEXT");
addColumnIfMissing("audit_logs", "store_id", "store_id TEXT");
addColumnIfMissing("audit_logs", "audit_epoch", "audit_epoch TEXT");
addColumnIfMissing("terminal_sessions", "ended_reason", "ended_reason TEXT");
addColumnIfMissing("staff_users", "permissions_override", "permissions_override TEXT");
addColumnIfMissing("staff_users", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("stores", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("stores", "settlement_unresolved_review_policy", "settlement_unresolved_review_policy TEXT");
addColumnIfMissing("stores", "terms_url", "terms_url TEXT");
addColumnIfMissing("stores", "privacy_url", "privacy_url TEXT");
addColumnIfMissing("stores", "refund_policy_url", "refund_policy_url TEXT");
addColumnIfMissing("stores", "terms_version", "terms_version TEXT");
addColumnIfMissing("stores", "privacy_version", "privacy_version TEXT");
addColumnIfMissing("stores", "refund_policy_version", "refund_policy_version TEXT");
addColumnIfMissing("stores", "terms_hash", "terms_hash TEXT");
addColumnIfMissing("stores", "privacy_hash", "privacy_hash TEXT");
addColumnIfMissing("stores", "refund_policy_hash", "refund_policy_hash TEXT");
addColumnIfMissing("stores", "terms_content", "terms_content TEXT");
addColumnIfMissing("stores", "privacy_content", "privacy_content TEXT");
addColumnIfMissing("stores", "refund_policy_content", "refund_policy_content TEXT");
addColumnIfMissing("stores", "refund_treasury_address", "refund_treasury_address TEXT");
addColumnIfMissing("stores", "refund_treasury_chain_id", "refund_treasury_chain_id TEXT");
addColumnIfMissing("stores", "refund_treasury_approval_ref", "refund_treasury_approval_ref TEXT");
addColumnIfMissing("invoices", "policy_snapshot_json", "policy_snapshot_json TEXT");
addColumnIfMissing("invoices", "monitor_until", "monitor_until TEXT");
addColumnIfMissing("invoices", "last_reconciled_block", "last_reconciled_block INTEGER");
addColumnIfMissing("invoices", "integrity_hold", "integrity_hold INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("invoices", "integrity_hold_reason", "integrity_hold_reason TEXT");
addColumnIfMissing("invoices", "integrity_hold_at", "integrity_hold_at TEXT");
addColumnIfMissing("payment_events", "amount_atomic", "amount_atomic TEXT");
addColumnIfMissing("payment_events", "chain_verified", "chain_verified INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("payment_events", "token_verified", "token_verified INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("payment_events", "recipient_verified", "recipient_verified INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("payment_events", "canonical_status", "canonical_status TEXT NOT NULL DEFAULT 'unknown'");
addColumnIfMissing("payment_events", "within_expiry", "within_expiry INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("payment_events", "recognition_status", "recognition_status TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing("payment_events", "reorg_id", "reorg_id TEXT");
addColumnIfMissing("terminals", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("terminals", "public_entry_token", "public_entry_token TEXT");
addColumnIfMissing("terminals", "current_invoice_id", "current_invoice_id TEXT");
addColumnIfMissing("terminals", "current_invoice_assigned_at", "current_invoice_assigned_at TEXT");
addColumnIfMissing("checkout_sessions", "merchant_id", "merchant_id TEXT");
addColumnIfMissing("idempotency_records", "expires_at", "expires_at TEXT");
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
addColumnIfMissing("chain_reorgs", "status", "status TEXT NOT NULL DEFAULT 'unresolved'");
addColumnIfMissing("chain_reorgs", "resolved_at", "resolved_at TEXT");
addColumnIfMissing("chain_reorgs", "resolution_note", "resolution_note TEXT");
addColumnIfMissing("review_cases", "tx_hash", "tx_hash TEXT");
addColumnIfMissing("review_cases", "billed_amount_jpyc_base", "billed_amount_jpyc_base TEXT");
addColumnIfMissing("review_cases", "paid_amount_jpyc_base", "paid_amount_jpyc_base TEXT");
addColumnIfMissing("review_cases", "diff_jpyc_base", "diff_jpyc_base TEXT");
addColumnIfMissing("review_cases", "suggested_action", "suggested_action TEXT");
addColumnIfMissing("review_cases", "refundable_candidate_jpyc_base", "refundable_candidate_jpyc_base TEXT");
addColumnIfMissing("review_cases", "admin_note", "admin_note TEXT");

db.exec(`
CREATE VIEW IF NOT EXISTS audit_logs_scoped AS
SELECT a.id,
       COALESCE(attribution.store_id, a.store_id) AS store_id,
       CASE
         WHEN attribution.store_id IS NOT NULL THEN 'attested'
         WHEN a.store_id IS NOT NULL THEN 'embedded'
         ELSE 'unattributed'
       END AS store_id_source,
       a.audit_epoch,
       a.actor_type,
       a.actor_id,
       a.action,
       a.target_type,
       a.target_id,
       a.request_id,
       a.idempotency_key,
       a.before_state,
       a.after_state,
       a.prev_hash,
       a.entry_hash,
       a.ip_address,
       a.created_at
FROM audit_logs a
LEFT JOIN audit_log_store_attributions attribution ON attribution.audit_log_id = a.id;
`);

function assertNoDeniedJpycContractsInDb() {
  const denylist = JPYC_PREPAID_DENYLIST_CONTRACTS;
  if (denylist.length === 0) return;
  const placeholders = denylist.map(() => "?").join(",");
  const directChecks = [
    { table: "stores", sql: `SELECT id FROM stores WHERE lower(token_contract) IN (${placeholders}) LIMIT 1` },
    { table: "invoices", sql: `SELECT id FROM invoices WHERE lower(token_contract) IN (${placeholders}) LIMIT 1` },
    { table: "receive_addresses", sql: `SELECT id FROM receive_addresses WHERE lower(token_contract) IN (${placeholders}) LIMIT 1` },
    { table: "payment_events", sql: `SELECT id FROM payment_events WHERE lower(token_contract) IN (${placeholders}) LIMIT 1` },
    { table: "chain_unmatched_events", sql: `SELECT id FROM chain_unmatched_events WHERE lower(token_contract) IN (${placeholders}) LIMIT 1` },
    { table: "refund_requests", sql: `SELECT id FROM refund_requests WHERE lower(token_contract) IN (${placeholders}) LIMIT 1` },
  ];
  for (const check of directChecks) {
    const row = db.prepare(check.sql).get(...denylist);
    if (row) {
      console.error(`FATAL: denylisted JPYC Prepaid contract found in ${check.table}: ${row.id || "unknown"}`);
      process.exit(1);
    }
  }
  const payloadChecks = [
    { table: "payment_attempts", sql: "SELECT id FROM payment_attempts WHERE lower(payload_json) LIKE ? LIMIT 1" },
    { table: "chain_dead_letters", sql: "SELECT id FROM chain_dead_letters WHERE lower(payload_json) LIKE ? LIMIT 1" },
    { table: "suspicious_activity_logs", sql: "SELECT id FROM suspicious_activity_logs WHERE lower(payload_json) LIKE ? LIMIT 1" },
    { table: "settlement_export_rows", sql: "SELECT id FROM settlement_export_rows WHERE lower(payload_json) LIKE ? LIMIT 1" },
  ];
  for (const denied of denylist) {
    for (const check of payloadChecks) {
      const row = db.prepare(check.sql).get(`%${denied}%`);
      if (row) {
        console.error(`FATAL: denylisted JPYC Prepaid contract found in ${check.table} payload: ${row.id || "unknown"}`);
        process.exit(1);
      }
    }
  }
}

assertNoDeniedJpycContractsInDb();
addColumnIfMissing("review_cases", "action_history_json", "action_history_json TEXT");
addColumnIfMissing("review_cases", "resolution_status", "resolution_status TEXT");
addColumnIfMissing("review_cases", "disposition", "disposition TEXT");
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_store_created_at ON audit_logs(store_id, created_at DESC)`);
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
const uuid = () => crypto.randomUUID();

const legacyInvoiceBusinessDates = db
  .prepare(
    `SELECT i.id, i.created_at, i.updated_at, s.timezone
     FROM invoices i
     LEFT JOIN stores s ON s.id = i.store_id
     WHERE i.business_date IS NULL`
  )
  .all();
if (legacyInvoiceBusinessDates.length > 0) {
  const updateLegacyInvoiceBusinessDate = db.prepare(`UPDATE invoices SET business_date = ?, updated_at = COALESCE(updated_at, ?) WHERE id = ?`);
  for (const row of legacyInvoiceBusinessDates) {
    const businessDate = DateTime.fromISO(String(row.created_at || ""))
      .setZone(row.timezone || "Asia/Tokyo")
      .toISODate();
    if (businessDate) updateLegacyInvoiceBusinessDate.run(businessDate, String(row.updated_at || row.created_at || nowIso()), row.id);
  }
}

function recordAccountingEvent({
  storeId,
  invoiceId,
  eventType,
  businessDate = null,
  occurredAt = null,
  amountBase = "0",
  status = "recorded",
  sourceRef,
  payload = {},
}) {
  const occurred = String(occurredAt || nowIso());
  const store = db.prepare(`SELECT timezone FROM stores WHERE id = ?`).get(storeId);
  const resolvedBusinessDate = businessDate
    || DateTime.fromISO(occurred).setZone(store?.timezone || "Asia/Tokyo").toISODate();
  const normalizedAmount = String(amountBase ?? "0").trim();
  if (!/^[0-9]+$/.test(normalizedAmount)) throw new Error("accounting_event_amount_invalid");
  const reference = String(sourceRef || "").trim();
  if (!storeId || !invoiceId || !eventType || !resolvedBusinessDate || !reference) {
    throw new Error("accounting_event_lineage_missing");
  }
  db.prepare(
    `INSERT OR IGNORE INTO accounting_event_journal
     (id, store_id, invoice_id, event_type, business_date, occurred_at, amount_jpyc_base, status, source_ref, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    String(storeId),
    String(invoiceId),
    String(eventType),
    String(resolvedBusinessDate),
    occurred,
    normalizedAmount,
    String(status || "recorded"),
    reference,
    JSON.stringify(payload || {}),
    nowIso(),
  );
  return db.prepare(`SELECT * FROM accounting_event_journal WHERE store_id = ? AND event_type = ? AND source_ref = ?`).get(
    String(storeId),
    String(eventType),
    reference,
  );
}

function recordFinalRefundAccountingEvent(refund, storeId = null) {
  if (!refund || !["succeeded", "verified"].includes(String(refund.status))) return null;
  const resolvedStoreId = storeId || db.prepare(`SELECT store_id FROM invoices WHERE id = ?`).get(refund.invoice_id)?.store_id;
  return recordAccountingEvent({
    storeId: resolvedStoreId,
    invoiceId: refund.invoice_id,
    eventType: "refund_succeeded",
    occurredAt: refund.verified_at || refund.detected_at || refund.updated_at || nowIso(),
    amountBase: String(refund.refund_amount_jpyc_base || "0"),
    status: String(refund.status),
    sourceRef: `refund:${refund.id}`,
    payload: {
      refund_id: refund.id,
      refund_case_id: refund.refund_case_id || null,
      review_case_id: refund.review_case_id || null,
      funding_lineage_id: refund.funding_lineage_id || null,
      refund_tx_hash: refund.refund_tx_hash || null,
      refund_tx_log_index: refund.refund_tx_log_index ?? null,
      verified_at: refund.verified_at || null,
    },
  });
}

const TERMINAL_ACTIVE_INVOICE_STATUSES = new Set(["issued", "payment_detected", "confirming"]);

function isTerminalActiveInvoiceStatus(status) {
  return TERMINAL_ACTIVE_INVOICE_STATUSES.has(String(status || ""));
}

function hasProviderSettlementPath(invoiceId) {
  const row = db
    .prepare(
      `SELECT ps.status AS payment_session_status, pps.provider_status
       FROM payment_sessions ps
       LEFT JOIN provider_payment_sessions pps ON pps.payment_session_id = ps.id
       WHERE ps.invoice_id = ? AND ps.rail_type = ?
       ORDER BY ps.updated_at DESC, ps.created_at DESC
       LIMIT 1`
    )
    .get(invoiceId, PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL);
  if (!row) return false;
  return ["settlement_pending", "settled"].includes(String(row.payment_session_status || ""))
    || ["failed", "voided", "refund_accepted", "settlement_pending", "settled", "reported", "confirmed"].includes(String(row.provider_status || ""));
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
    monitor_until: invoice.monitor_until || null,
    last_reconciled_block: invoice.last_reconciled_block ?? null,
    integrity_hold: Number(invoice.integrity_hold || 0) === 1,
    integrity_hold_reason: invoice.integrity_hold_reason || null,
    fulfillment_hold: Number(invoice.integrity_hold || 0) === 1 || invoice.status === "review_required",
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
  return networkLabelForChainId(chainId);
}

function computeInvoiceExpectedAmountAtomic(invoice) {
  const invoiceBase = String(invoice?.amount_jpyc_base || safeDecimalToBase(invoice?.amount_jpyc, "invoice.wallet_payload.amount"));
  const converted = convertLedgerBaseToTokenAtomicExact(invoiceBase);
  return converted.error ? null : converted.value;
}

function convertLedgerBaseToTokenAtomicExact(amountBase) {
  try {
    const converted = convertBaseUnitsBetweenDecimals(String(amountBase), JPYC_SCALE_DECIMALS, TOKEN_DECIMALS);
    if (!converted.exact) {
      return { error: "ledger amount cannot be represented exactly in token atomic units" };
    }
    return { value: converted.value };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

function convertTokenAtomicToLedgerBase(amountAtomic) {
  try {
    return convertBaseUnitsBetweenDecimals(String(amountAtomic), TOKEN_DECIMALS, JPYC_SCALE_DECIMALS);
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

function computeTtlRemainingSec(expiresAt, nowMs = Date.now()) {
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return null;
  return Math.floor((expiryMs - nowMs) / 1000);
}

function findInvoicePaymentEvidenceTimestamps(invoice) {
  const unavailable = { confirmedAt: null, chainRecordedAt: null };
  if (!invoice?.paid_tx_hash || !["paid", "settled"].includes(String(invoice.status || ""))) return unavailable;
  const event = db
    .prepare(
      `SELECT created_at, block_timestamp
       FROM payment_events
       WHERE invoice_id = ?
         AND lower(tx_hash) = lower(?)
         AND confirmations >= ?
         AND chain_id = ?
         AND lower(token_contract) = lower(?)
         AND lower(COALESCE(to_address, '')) = lower(?)
       ORDER BY confirmations DESC, block_number DESC, created_at DESC
       LIMIT 1`
    )
    .get(
      invoice.id,
      invoice.paid_tx_hash,
      REQUIRED_CONFIRMATIONS,
      String(invoice.chain_id || ""),
      String(invoice.token_contract || ""),
      String(invoice.recipient_address || "")
    );
  const confirmedAt = event?.created_at && Number.isFinite(new Date(event.created_at).getTime())
    ? event.created_at
    : null;
  const chainRecordedAt = event?.block_timestamp && Number.isFinite(new Date(event.block_timestamp).getTime())
    ? event.block_timestamp
    : null;
  return { confirmedAt, chainRecordedAt };
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
  const payload = buildWalletLaunchPayload({
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
  // Preserve the public API's historical wallet_url field as a copyable
  // EIP-681 payment URI when no reviewed deeplink is available. The mobile
  // client only launches when wallet_adapter.status === "ready".
  return {
    ...payload,
    wallet_url: payload.wallet_url || payload.payment_uri || null,
  };
}

function buildInvoiceDiagnostics(invoice, store = null, reviewCase = null) {
  const walletPayload = buildInvoiceWalletPayload(invoice, store);
  return {
    enabled: true,
    generated_at: nowIso(),
    invoice_status: invoice.status,
    status_reason: invoice.status_reason || null,
    monitor_until: invoice.monitor_until || null,
    integrity_hold: Number(invoice.integrity_hold || 0) === 1,
    integrity_hold_reason: invoice.integrity_hold_reason || null,
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

runMigration("20260724_002_refund_aggregate_lineage", () => {
  const rows = db
    .prepare(
      `SELECT rr.id, rr.refund_case_id, rr.invoice_id, rr.review_case_id, rr.reason,
              rr.requested_by, rr.created_at, rr.updated_at, i.store_id
       FROM refund_requests rr
       JOIN invoices i ON i.id = rr.invoice_id
       ORDER BY rr.created_at ASC, rr.id ASC`
    )
    .all();
  const insertCase = db.prepare(
    `INSERT OR IGNORE INTO refund_cases
     (id, invoice_id, store_id, related_review_case_id, reason, status, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateRequest = db.prepare(`UPDATE refund_requests SET refund_case_id = ? WHERE id = ? AND (refund_case_id IS NULL OR refund_case_id = '')`);
  for (const row of rows) {
    const refundCaseId = String(row.refund_case_id || `refund-case:${row.id}`);
    const timestamp = String(row.created_at || nowIso());
    insertCase.run(
      refundCaseId,
      row.invoice_id,
      row.store_id,
      row.review_case_id || null,
      row.reason || null,
      row.status || "requested",
      row.requested_by || "migration",
      timestamp,
      String(row.updated_at || timestamp),
    );
    updateRequest.run(refundCaseId, row.id);
  }
});

const AUDIT_HASH_VERSION_LEGACY_V1 = "audit_hash_v1";
const AUDIT_HASH_VERSION_STORE_V2 = "audit_hash_store_v2";
const AUDIT_HASH_VERSION_EPOCH_V3 = "audit_hash_epoch_v3";
const AUDIT_HASH_VERSIONS = new Set([
  AUDIT_HASH_VERSION_LEGACY_V1,
  AUDIT_HASH_VERSION_STORE_V2,
  AUDIT_HASH_VERSION_EPOCH_V3,
]);

function computeAuditEntryHash(prevHash, entryData, hashVersion = AUDIT_HASH_VERSION_EPOCH_V3) {
  if (!AUDIT_HASH_VERSIONS.has(hashVersion)) {
    throw new Error(`Unsupported audit hash version: ${String(hashVersion || "")}`);
  }
  const common = {
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
    created_at: entryData.createdAt,
  };
  let payload;
  if (hashVersion === AUDIT_HASH_VERSION_LEGACY_V1) {
    payload = JSON.stringify({ prev_hash: prevHash || null, ...common });
  } else if (hashVersion === AUDIT_HASH_VERSION_STORE_V2) {
    payload = JSON.stringify({
      prev_hash: prevHash || null,
      store_id: entryData.storeId || null,
      ...common,
    });
  } else {
    payload = JSON.stringify({
      prev_hash: prevHash || null,
      audit_epoch: entryData.auditEpoch || null,
      store_id: entryData.storeId || null,
      ...common,
    });
  }
  return sha256(payload);
}

runMigration("20260419_002_audit_hash_backfill", () => {
  const rows = db.prepare(`SELECT rowid, * FROM audit_logs ORDER BY rowid ASC`).all();
  const hashedRows = rows.filter((row) => row.entry_hash != null && String(row.entry_hash).trim() !== "");
  if (hashedRows.length > 0) {
    if (hashedRows.length !== rows.length || !auditRowsMatchHashVersion(rows, AUDIT_HASH_VERSION_LEGACY_V1)) {
      throw new Error("Refusing to overwrite a partial or invalid pre-existing audit hash chain");
    }
    return;
  }
  if (rows.some((row) => row.prev_hash != null && String(row.prev_hash).trim() !== "")) {
    throw new Error("Refusing to backfill audit rows with unexpected pre-existing prev_hash values");
  }
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
    }, AUDIT_HASH_VERSION_LEGACY_V1);
    db.prepare(`UPDATE audit_logs SET prev_hash = ?, entry_hash = ? WHERE id = ?`).run(prevHash, entryHash, row.id);
    prevHash = entryHash;
  }
});

runMigration("20260419_003_audit_hash_rechain_rowid", () => {
  const rows = db.prepare(`SELECT rowid, * FROM audit_logs ORDER BY rowid ASC`).all();
  if (!auditRowsMatchHashVersion(rows, AUDIT_HASH_VERSION_LEGACY_V1)) {
    throw new Error("Audit rowid chain verification failed; immutable audit rows were not rewritten");
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

function findStoreIdInAuditState(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (value.store_id) return String(value.store_id);
  if (value.storeId) return String(value.storeId);
  for (const nested of Object.values(value)) {
    const found = findStoreIdInAuditState(nested, seen);
    if (found) return found;
  }
  return null;
}

function resolveAuditStoreId({ storeId = null, targetType = null, targetId = null, beforeState = null, afterState = null } = {}) {
  if (storeId) return String(storeId);
  const fromState = findStoreIdInAuditState(afterState) || findStoreIdInAuditState(beforeState);
  if (fromState) return fromState;
  const id = String(targetId || "");
  if (!id) return null;
  if (targetType === "store") return db.prepare(`SELECT id FROM stores WHERE id = ?`).get(id)?.id || null;
  if (targetType === "receive_address_pool") return db.prepare(`SELECT id FROM stores WHERE id = ?`).get(id)?.id || null;
  if (targetType === "invoice") return db.prepare(`SELECT store_id FROM invoices WHERE id = ?`).get(id)?.store_id || null;
  if (targetType === "review") return db.prepare(`SELECT i.store_id FROM review_cases r JOIN invoices i ON i.id = r.invoice_id WHERE r.id = ?`).get(id)?.store_id || null;
  if (targetType === "refund") return db.prepare(`SELECT i.store_id FROM refund_requests r JOIN invoices i ON i.id = r.invoice_id WHERE r.id = ?`).get(id)?.store_id || null;
  if (targetType === "terminal") return db.prepare(`SELECT store_id FROM terminals WHERE id = ?`).get(id)?.store_id || null;
  return null;
}

function computeAuditEpochAttestation(epoch) {
  return sha256(JSON.stringify({
    epoch_id: epoch.id,
    start_rowid: Number(epoch.startRowid),
    hash_version: epoch.hashVersion,
    previous_epoch_id: epoch.previousEpochId || null,
    previous_tail_hash: epoch.previousTailHash || null,
    reason: epoch.reason,
    created_at: epoch.createdAt,
  }));
}

function insertAuditEpoch({
  id = uuid(),
  startRowid,
  hashVersion,
  previousEpochId = null,
  previousTailHash = null,
  reason,
  createdAt = nowIso(),
}) {
  if (!AUDIT_HASH_VERSIONS.has(hashVersion)) {
    throw new Error(`Unsupported audit epoch hash version: ${String(hashVersion || "")}`);
  }
  const epoch = {
    id,
    startRowid: Number(startRowid),
    hashVersion,
    previousEpochId,
    previousTailHash,
    reason,
    createdAt,
  };
  const attestationHash = computeAuditEpochAttestation(epoch);
  db.prepare(
    `INSERT INTO audit_epochs
     (id, start_rowid, hash_version, previous_epoch_id, previous_tail_hash, reason, attestation_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    epoch.id,
    epoch.startRowid,
    epoch.hashVersion,
    epoch.previousEpochId,
    epoch.previousTailHash,
    epoch.reason,
    attestationHash,
    epoch.createdAt,
  );
  return { ...epoch, attestationHash };
}

function auditEntryDataFromRow(row, context = "audit_epoch") {
  return {
    auditEpoch: row.audit_epoch || null,
    storeId: row.store_id || null,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    beforeState: parseJsonWithWarning(row.before_state, `${context}.before_state`, null),
    afterState: parseJsonWithWarning(row.after_state, `${context}.after_state`, null),
    ip: row.ip_address,
    createdAt: row.created_at,
  };
}

function auditRowsMatchHashVersion(rows, hashVersion) {
  let prevHash = null;
  for (const row of rows) {
    const expected = computeAuditEntryHash(
      prevHash,
      auditEntryDataFromRow(row, `audit_epoch_detect.${hashVersion}`),
      hashVersion,
    );
    if (row.prev_hash !== prevHash || row.entry_hash !== expected) return false;
    prevHash = row.entry_hash;
  }
  return true;
}

function computeAuditStoreAttributionAttestation({ auditLogId, storeId, method, sourceEntryHash, attributedAt }) {
  return sha256(JSON.stringify({
    audit_log_id: auditLogId,
    store_id: storeId,
    attribution_method: method,
    source_entry_hash: sourceEntryHash,
    attributed_at: attributedAt,
  }));
}

runMigration("20260724_001_audit_store_scope", () => {
  const rows = db.prepare(`SELECT rowid, * FROM audit_logs WHERE store_id IS NULL ORDER BY rowid ASC`).all();
  for (const row of rows) {
    const beforeState = parseJsonWithWarning(row.before_state, "audit_store_scope.before_state", null);
    const afterState = parseJsonWithWarning(row.after_state, "audit_store_scope.after_state", null);
    const storeId = resolveAuditStoreId({
      targetType: row.target_type,
      targetId: row.target_id,
      beforeState,
      afterState,
    });
    if (!storeId || !db.prepare(`SELECT 1 AS ok FROM stores WHERE id = ?`).get(storeId)?.ok) continue;
    const method = "derived_from_ledger_and_audit_state_v1";
    const attributedAt = nowIso();
    const sourceEntryHash = String(row.entry_hash || "");
    const attestationHash = computeAuditStoreAttributionAttestation({
      auditLogId: row.id,
      storeId,
      method,
      sourceEntryHash,
      attributedAt,
    });
    db.prepare(
      `INSERT OR IGNORE INTO audit_log_store_attributions
       (audit_log_id, store_id, attribution_method, source_entry_hash, attestation_hash, attributed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.id, storeId, method, sourceEntryHash, attestationHash, attributedAt);
  }
});

runMigration("20260725_001_audit_epoch_bridge", () => {
  const existingEpoch = db.prepare(`SELECT id FROM audit_epochs ORDER BY start_rowid ASC LIMIT 1`).get();
  if (existingEpoch) return;

  const rows = db.prepare(`SELECT rowid, * FROM audit_logs ORDER BY rowid ASC`).all();
  if (rows.length === 0) {
    insertAuditEpoch({
      startRowid: 1,
      hashVersion: AUDIT_HASH_VERSION_EPOCH_V3,
      reason: "epoch_aware_store_scoped_chain_initialized",
    });
    return;
  }

  let existingHashVersion = null;
  if (auditRowsMatchHashVersion(rows, AUDIT_HASH_VERSION_LEGACY_V1)) {
    existingHashVersion = AUDIT_HASH_VERSION_LEGACY_V1;
  } else if (auditRowsMatchHashVersion(rows, AUDIT_HASH_VERSION_STORE_V2)) {
    existingHashVersion = AUDIT_HASH_VERSION_STORE_V2;
  }
  if (!existingHashVersion) {
    throw new Error("Existing audit chain does not match a supported immutable hash version");
  }

  const existingEpochRecord = insertAuditEpoch({
    startRowid: Number(rows[0].rowid),
    hashVersion: existingHashVersion,
    reason: existingHashVersion === AUDIT_HASH_VERSION_LEGACY_V1
      ? "legacy_chain_attested_without_history_rewrite"
      : "previously_store_scoped_chain_attested_without_further_rewrite",
  });
  const tail = rows[rows.length - 1];
  insertAuditEpoch({
    startRowid: Number(tail.rowid) + 1,
    hashVersion: AUDIT_HASH_VERSION_EPOCH_V3,
    previousEpochId: existingEpochRecord.id,
    previousTailHash: tail.entry_hash,
    reason: "immutable_epoch_bridge_to_store_scoped_hashes",
  });
});

runMigration("20260725_002_audit_scope_attested_precedence", () => {
  // Recreate only the derived view so an attested immutable attribution cannot
  // be shadowed by a mutable legacy audit_logs.store_id column. Audit rows and
  // attribution evidence themselves are never removed or rewritten.
  db.exec(`DROP VIEW IF EXISTS audit_logs_scoped`);
  db.exec(`
    CREATE VIEW audit_logs_scoped AS
    SELECT a.id,
           COALESCE(attribution.store_id, a.store_id) AS store_id,
           CASE
             WHEN attribution.store_id IS NOT NULL THEN 'attested'
             WHEN a.store_id IS NOT NULL THEN 'embedded'
             ELSE 'unattributed'
           END AS store_id_source,
           a.audit_epoch,
           a.actor_type,
           a.actor_id,
           a.action,
           a.target_type,
           a.target_id,
           a.request_id,
           a.idempotency_key,
           a.before_state,
           a.after_state,
           a.prev_hash,
           a.entry_hash,
           a.ip_address,
           a.created_at
    FROM audit_logs a
    LEFT JOIN audit_log_store_attributions attribution ON attribution.audit_log_id = a.id;
  `);
});

runMigration("20260725_003_audit_legacy_embedded_store_attestation", () => {
  // Legacy V1/V2 hashes do not cover audit_logs.store_id. Preserve the
  // historical embedded value in the immutable sidecar so scoped reads cannot
  // be redirected by a later mutation of the legacy column. New epoch-aware
  // rows already bind store_id into their hash and do not need a sidecar.
  const rows = db.prepare(
    `SELECT id, store_id, entry_hash
     FROM audit_logs
     WHERE audit_epoch IS NULL
       AND store_id IS NOT NULL
       AND trim(store_id) <> ''
       AND entry_hash IS NOT NULL
       AND trim(entry_hash) <> ''
     ORDER BY rowid ASC`
  ).all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO audit_log_store_attributions
     (audit_log_id, store_id, attribution_method, source_entry_hash, attestation_hash, attributed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    if (!db.prepare(`SELECT 1 AS ok FROM stores WHERE id = ?`).get(row.store_id)?.ok) continue;
    const method = "embedded_legacy_store_id_v1";
    const attributedAt = nowIso();
    const sourceEntryHash = String(row.entry_hash);
    const attestationHash = computeAuditStoreAttributionAttestation({
      auditLogId: row.id,
      storeId: row.store_id,
      method,
      sourceEntryHash,
      attributedAt,
    });
    insert.run(row.id, row.store_id, method, sourceEntryHash, attestationHash, attributedAt);
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
    fromUtc: start.toUTC().toISO({ suppressMilliseconds: false }),
    toUtc: end.toUTC().toISO({ suppressMilliseconds: false })
  };
}

const SETTLEMENT_EXPORT_HEADERS = [
  "invoice_id",
  "invoice_no",
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
  "reason_code",
  "review_status",
  "block_timestamp",
  "detected_at",
  "audit_ref",
  "refund_request_id",
  "refund_case_id",
  "refund_status",
  "refund_amount_jpyc_base",
  "refund_tx_hash",
  "refund_verified_at",
  "legacy_invoice_attribution",
  "legacy_refund_attribution",
  "legacy_refund_reference_count",
  "legacy_refund_references_json",
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

function buildSettlementExportCsv(rows) {
  const lines = [SETTLEMENT_EXPORT_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      SETTLEMENT_EXPORT_HEADERS.map((header) => {
        if (header === "reason_code") {
          return escapeCsvCell(normalizeReviewReasonCode(row.reason_code || REVIEW_REASON_CODES.OTHER));
        }
        if (header === "legacy_refund_references_json") {
          return escapeCsvCell(JSON.stringify(Array.isArray(row.legacy_refund_references) ? row.legacy_refund_references : []));
        }
        return escapeCsvCell(row[header]);
      }).join(",")
    );
  }
  return lines.join("\n");
}

const SETTLEMENT_EXPORT_CONTRACT_V1 = "settlement_export_v1";
const SETTLEMENT_EXPORT_CONTRACT_V2 = "settlement_export_v2";

const SETTLEMENT_EXPORT_V1_SNAPSHOT_HEADERS = [
  "export_run_id",
  "export_version",
  "business_date",
  "store_id",
  "terminal_id",
  "operator_id",
  "invoice_id",
  "checkout_session_id",
  "payment_session_id",
  "rail_type",
  "provider_code",
  "invoice_amount_jpyc_base",
  "invoice_status",
  "accounting_status",
  "cash_recognition_status",
  "receivable_status",
  "onchain_cash_amount_jpyc_base",
  "provider_receivable_amount_jpyc_base",
  "exception_amount_jpyc_base",
  "refund_amount_jpyc_base",
  "void_amount_jpyc_base",
  "provider_payment_ref",
  "provider_settlement_ref",
  "onchain_transfer_ref",
  "evidence_hash",
  "payload_schema_version",
  "export_excluded_private_data",
  "created_at",
];

const SETTLEMENT_EXPORT_V2_SNAPSHOT_HEADERS = [
  "export_reference",
  "settlement_id",
  "settlement_export_run_id",
  "settlement_export_row_id",
  "export_run_id",
  "export_version",
  "business_date",
  "store_id",
  "terminal_id",
  "operator_id",
  "invoice_id",
  "invoice_no",
  "checkout_session_id",
  "payment_session_id",
  "rail_type",
  "provider_code",
  "chain_id",
  "network",
  "token_contract",
  "recipient_address",
  "payment_attempt_ids_json",
  "primary_tx_hash",
  "primary_tx_log_index",
  "review_case_id",
  "review_reason_type",
  "review_status",
  "refund_request_id",
  "refund_tx_hash",
  "audit_log_refs_json",
  "external_sync_refs_json",
  "accounting_event_refs_json",
  "source_ledger_snapshot_hash",
  "invoice_amount_jpyc_base",
  "invoice_status",
  "accounting_status",
  "cash_recognition_status",
  "receivable_status",
  "onchain_cash_amount_jpyc_base",
  "provider_receivable_amount_jpyc_base",
  "exception_amount_jpyc_base",
  "refund_amount_jpyc_base",
  "refund_attribution",
  "refund_reference_status",
  "refund_reference_count",
  "refund_requested_amount_jpyc_base",
  "refund_reserved_amount_jpyc_base",
  "refund_succeeded_amount_jpyc_base",
  "refund_references_json",
  "void_amount_jpyc_base",
  "provider_payment_ref",
  "provider_settlement_ref",
  "onchain_transfer_ref",
  "evidence_hash",
  "payload_schema_version",
  "export_excluded_private_data",
  "created_at",
];

function buildSettlementExportV1SnapshotCsv(rows, { bom = false } = {}) {
  const lines = [SETTLEMENT_EXPORT_V1_SNAPSHOT_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(SETTLEMENT_EXPORT_V1_SNAPSHOT_HEADERS.map((header) => escapeCsvCell(row[header])).join(","));
  }
  const csv = lines.join("\n");
  return bom ? `\uFEFF${csv}` : csv;
}

function buildSettlementExportV2SnapshotCsv(rows, { bom = false } = {}) {
  const lines = [SETTLEMENT_EXPORT_V2_SNAPSHOT_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      SETTLEMENT_EXPORT_V2_SNAPSHOT_HEADERS.map((header) => {
        if (header === "refund_references_json") {
          return escapeCsvCell(JSON.stringify(Array.isArray(row.refund_references) ? row.refund_references : []));
        }
        if (header.endsWith("_json")) {
          const field = header.slice(0, -5);
          return escapeCsvCell(JSON.stringify(Array.isArray(row[field]) ? row[field] : []));
        }
        return escapeCsvCell(row[header]);
      }).join(",")
    );
  }
  const csv = lines.join("\n");
  return bom ? `\uFEFF${csv}` : csv;
}

function buildSettlementExportV1SnapshotJsonPayload({ exportRow, metadata, rows }) {
  return {
    export_id: exportRow.id,
    export_run_id: metadata?.export_run_id || null,
    export_version: "v1",
    business_date: exportRow.business_date,
    format: exportRow.format,
    generated_at: exportRow.generated_at,
    output_path: exportRow.output_path,
    metadata,
    rows,
  };
}

const SETTLEMENT_EXPORT_V2_CANONICAL_HASH_SCOPE = "settlement_export_v2_canonical_payload_without_content_hashes";
const SETTLEMENT_EXPORT_V2_REFUND_ANNOTATION_FIELDS = [
  "refund_attribution",
  "refund_reference_status",
  "refund_reference_count",
  "refund_requested_amount_jpyc_base",
  "refund_reserved_amount_jpyc_base",
  "refund_succeeded_amount_jpyc_base",
  "refund_references",
];
const SETTLEMENT_EXPORT_V2_CANONICAL_JSON_ROW_FIELDS = [
  "id",
  "export_reference",
  "settlement_id",
  "settlement_export_run_id",
  "settlement_export_row_id",
  "export_run_id",
  "export_version",
  "business_date",
  "store_id",
  "terminal_id",
  "operator_id",
  "invoice_id",
  "invoice_no",
  "checkout_session_id",
  "payment_session_id",
  "rail_type",
  "provider_code",
  "chain_id",
  "network",
  "token_contract",
  "recipient_address",
  "payment_attempt_ids",
  "primary_tx_hash",
  "primary_tx_log_index",
  "review_case_id",
  "review_reason_type",
  "review_status",
  "refund_request_id",
  "refund_tx_hash",
  "audit_log_refs",
  "external_sync_refs",
  "accounting_event_refs",
  "source_ledger_snapshot_hash",
  "invoice_amount_jpyc_base",
  "invoice_status",
  "accounting_status",
  "cash_recognition_status",
  "receivable_status",
  "onchain_cash_amount_jpyc_base",
  "provider_receivable_amount_jpyc_base",
  "exception_amount_jpyc_base",
  "refund_amount_jpyc_base",
  "refund_attribution",
  "refund_reference_status",
  "refund_reference_count",
  "refund_requested_amount_jpyc_base",
  "refund_reserved_amount_jpyc_base",
  "refund_succeeded_amount_jpyc_base",
  "refund_references",
  "void_amount_jpyc_base",
  "provider_payment_ref",
  "provider_settlement_ref",
  "onchain_transfer_ref",
  "evidence_hash",
  "payload_schema_version",
  "export_excluded_private_data",
  "created_at",
];

function buildSettlementExportV2RowAnnotations(rows) {
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      Object.fromEntries(SETTLEMENT_EXPORT_V2_REFUND_ANNOTATION_FIELDS.map((field) => [field, row[field]])),
    ])
  );
}

function applySettlementExportV2RowAnnotations(rows, metadata) {
  const annotations = metadata?._row_annotations && typeof metadata._row_annotations === "object"
    ? metadata._row_annotations
    : {};
  return rows.map((row) => {
    const annotation = annotations[row.id];
    if (!annotation || typeof annotation !== "object") {
      const error = new Error(`Settlement Export v2 row annotation is missing for ${row.id}`);
      error.code = "SETTLEMENT_EXPORT_V2_INTEGRITY_ERROR";
      throw error;
    }
    return { ...row, ...annotation };
  });
}

function publicSettlementExportV2Metadata(metadata) {
  const {
    _row_annotations: _annotations,
    _refund_manifest: _refundManifest,
    _refund_totals: _refundTotals,
    ...publicMetadata
  } = metadata || {};
  return publicMetadata;
}

function canonicalSettlementExportV2Metadata(metadata) {
  const {
    content_hash: _contentHash,
    content_hashes: _contentHashes,
    ...canonicalMetadata
  } = publicSettlementExportV2Metadata(metadata);
  return canonicalMetadata;
}

function canonicalSettlementExportV2Rows(rows) {
  return rows.map((row) => Object.fromEntries(
    SETTLEMENT_EXPORT_V2_CANONICAL_JSON_ROW_FIELDS.map((field) => [field, row[field] ?? null])
  ));
}

function buildSettlementExportV2SnapshotJsonPayload({ exportRow, metadata, rows }) {
  return {
    export_id: exportRow.id,
    export_run_id: metadata?.export_run_id || null,
    contract_version: SETTLEMENT_EXPORT_CONTRACT_V2,
    export_version: "v2",
    business_date: exportRow.business_date,
    format: exportRow.format,
    generated_at: exportRow.generated_at,
    output_path: exportRow.output_path,
    refund_manifest: Array.isArray(metadata?._refund_manifest) ? metadata._refund_manifest : [],
    refund_totals: metadata?._refund_totals || null,
    metadata: canonicalSettlementExportV2Metadata(metadata),
    rows: canonicalSettlementExportV2Rows(rows),
  };
}

function resolveSettlementExportContractVersion(metadata) {
  const explicit = String(metadata?.contract_version || "").trim();
  const exportVersion = String(metadata?.export_version || "").trim();
  if (!explicit && (!exportVersion || exportVersion === "v1")) return SETTLEMENT_EXPORT_CONTRACT_V1;
  if (explicit === SETTLEMENT_EXPORT_CONTRACT_V1 && (!exportVersion || exportVersion === "v1")) {
    return SETTLEMENT_EXPORT_CONTRACT_V1;
  }
  if (explicit === SETTLEMENT_EXPORT_CONTRACT_V2 && exportVersion === "v2") {
    return SETTLEMENT_EXPORT_CONTRACT_V2;
  }
  return null;
}

function compareSettlementExportV2Rows(left, right) {
  for (const field of ["invoice_id", "payment_session_id", "rail_type", "provider_code", "id"]) {
    const leftValue = String(left?.[field] || "");
    const rightValue = String(right?.[field] || "");
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function loadSettlementExportRows(exportRunId, contractVersion) {
  if (!exportRunId) return [];
  const restoreFrozenPayload = (row) => {
    if (!row?.payload_json) return row;
    try {
      const payload = JSON.parse(row.payload_json);
      return payload && typeof payload === "object" ? payload : row;
    } catch {
      const error = new Error(`Settlement export row payload is invalid for ${row.id}`);
      error.code = "SETTLEMENT_EXPORT_INTEGRITY_ERROR";
      throw error;
    }
  };
  if (contractVersion === SETTLEMENT_EXPORT_CONTRACT_V1) {
    return db.prepare(`SELECT * FROM settlement_export_rows WHERE export_run_id = ? ORDER BY created_at ASC`).all(exportRunId).map(restoreFrozenPayload);
  }
  if (contractVersion === SETTLEMENT_EXPORT_CONTRACT_V2) {
    return db
      .prepare(
        `SELECT * FROM settlement_export_rows
         WHERE export_run_id = ?
         ORDER BY COALESCE(invoice_id, '') ASC,
                  COALESCE(payment_session_id, '') ASC,
                  rail_type ASC,
                  provider_code ASC,
                  id ASC`
      )
      .all(exportRunId)
      .map(restoreFrozenPayload);
  }
  return [];
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

function countRecipientActiveInvoices(storeId, recipientAddress, chainId, tokenContract) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM invoices i
       LEFT JOIN review_cases r ON r.invoice_id = i.id
       WHERE i.store_id = ?
         AND lower(i.recipient_address) = lower(?)
         AND i.chain_id = ?
         AND lower(i.token_contract) = lower(?)
         AND (
           i.status IN ('issued', 'payment_detected', 'confirming')
           OR (i.status = 'review_required' AND COALESCE(r.status, 'open') IN ('open', 'in_progress'))
         )`
    )
    .get(storeId, recipientAddress, String(chainId), String(tokenContract || ""));
  return Number(row?.count || 0);
}

function computeDailyStoreTotals(storeId, businessDate, timezone) {
  const range = utcRangeForBusinessDate(businessDate, timezone);
  if (range.error) return { error: range.error, details: range.details };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS invoice_count, COALESCE(SUM(amount_jpy), 0) AS amount_jpy
       FROM invoices
       WHERE store_id = ?
         AND (business_date = ? OR (business_date IS NULL AND created_at BETWEEN ? AND ?))`
    )
    .get(storeId, businessDate, range.fromUtc, range.toUtc);
  return {
    invoice_count: Number(row?.invoice_count || 0),
    amount_jpy: Number(row?.amount_jpy || 0),
  };
}

function issueInvoiceRecord({
  store,
  session,
  amountJpy,
  paymentChain,
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
    const issuanceBlocked = getInvoiceIssuanceBlockReason({ store, session });
    if (issuanceBlocked) return { error: issuanceBlocked };
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
    const businessDate = DateTime.fromISO(ts).setZone(store.timezone || "Asia/Tokyo").toISODate();
    const selectedChain = paymentChain || getSupportedPaymentChain(store.chain_id) || getSupportedPaymentChain(CHAIN_ID);
    if (!selectedChain) {
      return { error: { code: "UNSUPPORTED_PAYMENT_CHAIN", message: "unsupported payment chain" } };
    }
    const chainId = String(selectedChain.chain_id);
    const tokenContract = String(selectedChain.token_contract).toLowerCase();
    const policySnapshot = buildPolicySnapshot(store);
    const poolConfigured = hasConfiguredReceiveAddressPool(session.store_id, chainId);
    const allocatedAddress = poolConfigured
      ? allocateReceiveAddress({ storeId: session.store_id, invoiceId: id, chainId })
      : null;
    const recipient = allocatedAddress?.address || (!poolConfigured && !IS_PRODUCTION ? String(RECIPIENT_ADDRESS || "") : "");

    if (!recipient) {
      return {
        error: {
          code: "ADDRESS_POOL_EXHAUSTED",
          message: "no approved receive address is available for invoice issuance",
        },
      };
    }

    const activeRecipientInvoiceCount = countRecipientActiveInvoices(
      session.store_id,
      recipient,
      chainId,
      tokenContract
    );
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
       chain_id, token_contract, recipient_address, payment_url, expires_at, status, business_date, created_at, updated_at,
       reissued_from_invoice_id, reissue_root_invoice_id, policy_snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?)`
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
      businessDate,
      ts,
      ts,
      reissuedFromInvoiceId,
      reissueRootInvoiceId || reissuedFromInvoiceId || null,
      policySnapshot ? JSON.stringify(policySnapshot) : null
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
    reported_at: picked.reported_at ? String(picked.reported_at) : null,
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
  const businessDate = DateTime.now().setZone(store.timezone || "Asia/Tokyo").toISODate();
  const closedSettlement = db
    .prepare(`SELECT id FROM settlements WHERE store_id = ? AND business_date = ?`)
    .get(store.id, businessDate);
  if (closedSettlement) {
    return {
      code: "DAILY_SETTLEMENT_CLOSED",
      message: "The current business date is already closed",
      details: { store_id: store.id, business_date: businessDate, settlement_id: closedSettlement.id },
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
  const releaseGateRequired = IS_PRODUCTION || ["pilot", "commercial"].includes(DEPLOYMENT_STAGE) || COMMERCIAL_GO_MODE;
  if (releaseGateRequired) {
    const commercialGate = evaluateCommercialRuntimeGate();
    const storePolicyGate = evaluatePolicyUrlsGate({ store });
    if (!storePolicyGate.ok) {
      return {
        code: "POLICY_PUBLICATION_REQUIRED",
        message: "Published customer policies are required before invoice issuance",
        details: {
          policy_urls_gate: false,
          missing_keys: storePolicyGate.missing_keys,
          missing_version_keys: storePolicyGate.missing_version_keys,
          missing_hash_keys: storePolicyGate.missing_hash_keys,
        },
      };
    }
    if (IS_PRODUCTION && !commercialGate.commercial_go_mode) {
      return {
        code: "COMMERCIAL_GO_MODE_REQUIRED",
        message: "Production invoice issuance requires the commercial release gate",
        details: { commercial_verdict: commercialGate.commercial_verdict, blockers: commercialGate.blockers },
      };
    }
    if (!commercialGate.release_selection_gate || !commercialGate.release_manifest_gate) {
      return {
        code: "RELEASE_EVIDENCE_REQUIRED",
        message: "An explicitly selected release manifest and evidence directory are required",
        details: {
          release_selection_gate: commercialGate.release_selection_gate,
          release_manifest_gate: commercialGate.release_manifest_gate,
        },
      };
    }
  }
  if (releaseGateRequired) {
    const refundTreasury = getRefundTreasuryConfig({ storeId: store.id, chainId: store.chain_id || CHAIN_ID });
    if (!refundTreasury || isPlaceholderLike(refundTreasury.approval_ref)) {
      return {
        code: "REFUND_TREASURY_NOT_READY",
        message: "store/chain refund treasury approval is required before invoice issuance",
        details: { store_id: store.id, chain_id: String(store.chain_id || CHAIN_ID) },
      };
    }
    const chainId = String(store.chain_id || CHAIN_ID);
    const worker = db.prepare(`SELECT value FROM chain_monitor_state WHERE key = ?`).get(`worker:${chainId}:last_cycle_at`);
    const workerRpc = db.prepare(`SELECT value FROM chain_monitor_state WHERE key = ?`).get(`worker:${chainId}:rpc_count`);
    const workerCheckpoint = db.prepare(`SELECT value FROM chain_monitor_state WHERE key = ?`).get(`worker:${chainId}:last_checkpoint`);
    const workerAt = worker?.value ? new Date(worker.value).getTime() : NaN;
    if (
      !Number.isFinite(workerAt)
      || Date.now() - workerAt > WORKER_STALE_SEC * 1000
      || !Number.isFinite(Number(workerRpc?.value))
      || Number(workerRpc.value) < 1
      || !workerCheckpoint?.value
    ) {
      return {
        code: "CHAIN_MONITOR_NOT_READY",
        message: "The selected chain monitor is missing or stale",
        details: {
          chain_id: chainId,
          worker_last_cycle_at: worker?.value || null,
          worker_rpc_count: Number.isFinite(Number(workerRpc?.value)) ? Number(workerRpc.value) : null,
          worker_last_checkpoint: workerCheckpoint?.value || null,
          stale_after_sec: WORKER_STALE_SEC,
        },
      };
    }
    const unresolvedReorg = db
      .prepare(`SELECT id, from_block, to_block, reason, detected_at FROM chain_reorgs WHERE chain_id = ? AND status = 'unresolved' ORDER BY detected_at DESC LIMIT 1`)
      .get(chainId);
    if (unresolvedReorg) {
      return {
        code: "CHAIN_REORG_RECONCILIATION_REQUIRED",
        message: "Chain reorganization evidence requires platform reconciliation before new invoices can be issued",
        details: { chain_id: chainId, reorg: unresolvedReorg },
      };
    }
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

function evaluateStorePolicyGate(store) {
  const values = {
    terms: String(store?.terms_url || "").trim(),
    privacy: String(store?.privacy_url || "").trim(),
    refund: String(store?.refund_policy_url || "").trim(),
  };
  const versions = {
    terms_version: String(store?.terms_version || "").trim(),
    privacy_version: String(store?.privacy_version || "").trim(),
    refund_policy_version: String(store?.refund_policy_version || "").trim(),
  };
  const hashes = {
    terms_hash: String(store?.terms_hash || "").trim().toLowerCase(),
    privacy_hash: String(store?.privacy_hash || "").trim().toLowerCase(),
    refund_policy_hash: String(store?.refund_policy_hash || "").trim().toLowerCase(),
  };
  const contentVerification = verifyPolicyContentHashes(
    {
      terms: store?.terms_content,
      privacy: store?.privacy_content,
      refund: store?.refund_policy_content,
    },
    hashes
  );
  const missingKeys = Object.keys(values).filter((key) => !isPublishedPolicyUrl(values[key]));
  const missingVersionKeys = Object.keys(versions).filter((key) => !isPublishedPolicyVersion(versions[key]));
  const missingHashKeys = Object.keys(hashes).filter((key) => !isPublishedPolicyHash(hashes[key]));
  return {
    ok: missingKeys.length === 0
      && missingVersionKeys.length === 0
      && missingHashKeys.length === 0
      && contentVerification.ok,
    source_path: `store:${store?.id || "unknown"}`,
    values,
    versions,
    hashes,
    content_verification: contentVerification,
    missing_keys: missingKeys,
    missing_version_keys: missingVersionKeys,
    missing_hash_keys: missingHashKeys,
    content_verification_ok: contentVerification.ok,
    errors: [
      ...missingKeys.map((key) => `store policy ${key} must be a production https URL`),
      ...missingVersionKeys.map((key) => `store policy ${key} must be a published version`),
      ...missingHashKeys.map((key) => `store policy ${key} must be a SHA-256 content hash`),
      ...contentVerification.missing_content_keys.map((key) => `store policy ${key} content is required for server-side hash verification`),
      ...contentVerification.mismatch_hash_keys.map((key) => `store policy ${key} does not match the server-computed content hash`),
    ],
  };
}

function buildPolicySnapshot(store) {
  const storeGate = evaluateStorePolicyGate(store);
  if (!storeGate.ok) return null;
  return {
    urls: storeGate.values,
    versions: storeGate.versions,
    hashes: storeGate.hashes,
    content_verification: storeGate.content_verification,
    published_at: nowIso(),
    source: "store",
  };
}

function evaluatePolicySnapshot(snapshot) {
  const values = snapshot?.urls && typeof snapshot.urls === "object" ? snapshot.urls : {};
  const versions = snapshot?.versions && typeof snapshot.versions === "object" ? snapshot.versions : {};
  const hashes = snapshot?.hashes && typeof snapshot.hashes === "object" ? snapshot.hashes : {};
  const contentVerification = snapshot?.content_verification && typeof snapshot.content_verification === "object"
    ? snapshot.content_verification
    : {};
  const missingKeys = ["terms", "privacy", "refund"].filter((key) => !isPublishedPolicyUrl(values[key]));
  const missingVersionKeys = ["terms_version", "privacy_version", "refund_policy_version"]
    .filter((key) => !isPublishedPolicyVersion(versions[key]));
  const missingHashKeys = ["terms_hash", "privacy_hash", "refund_policy_hash"]
    .filter((key) => !isPublishedPolicyHash(hashes[key]));
  const contentVerificationOk = contentVerification.ok === true
    && contentVerification.canonicalization === POLICY_CONTENT_HASH_CANONICALIZATION
    && ["terms_hash", "privacy_hash", "refund_policy_hash"].every(
      (key) => String(contentVerification.computed_hashes?.[key] || "").toLowerCase() === String(hashes[key] || "").toLowerCase()
    );
  return {
    ok: missingKeys.length === 0
      && missingVersionKeys.length === 0
      && missingHashKeys.length === 0
      && contentVerificationOk,
    values,
    versions,
    hashes,
    content_verification: contentVerification,
    missing_keys: missingKeys,
    missing_version_keys: missingVersionKeys,
    missing_hash_keys: missingHashKeys,
    content_verification_ok: contentVerificationOk,
    errors: [
      ...missingKeys,
      ...missingVersionKeys,
      ...missingHashKeys,
      ...(contentVerificationOk ? [] : ["content_verification"]),
    ],
  };
}

function evaluatePolicyUrlsGate({ sourcePath = path.join(CWD, "public/mobile.js"), store = null } = {}) {
  if (store) return evaluateStorePolicyGate(store);
  try {
    const content = fs.readFileSync(sourcePath, "utf8");
    const sourceGate = evaluatePolicyPublicationSource(content, { sourcePath });
    let stores = [];
    try {
      stores = db.prepare(`SELECT * FROM stores WHERE status = 'active'`).all();
    } catch (_error) {
      stores = [];
    }
    const storeGates = stores.map((candidate) => evaluateStorePolicyGate(candidate));
    if (storeGates.length > 0 && storeGates.every((gate) => gate.ok)) {
      return { ...storeGates[0], source_path: "active_stores" };
    }
    if (storeGates.length > 0) {
      return {
        ok: false,
        source_path: "active_stores",
        values: {},
        versions: {},
        hashes: {},
        missing_keys: [...new Set(storeGates.flatMap((gate) => gate.missing_keys || []))],
        missing_version_keys: [...new Set(storeGates.flatMap((gate) => gate.missing_version_keys || []))],
        missing_hash_keys: [...new Set(storeGates.flatMap((gate) => gate.missing_hash_keys || []))],
        errors: storeGates.flatMap((gate) => gate.errors || []),
      };
    }
    return sourceGate;
  } catch (error) {
    return unavailablePolicyPublication({
      sourcePath,
      message: error?.message || "policy url source could not be read",
    });
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function releaseManifestSigningPayload(manifest) {
  const unsigned = { ...(manifest || {}) };
  delete unsigned.signatures;
  delete unsigned.signature;
  return Buffer.from(stableJson(unsigned), "utf8");
}

function resolveReleaseArtifactPath(rawPath) {
  const candidate = String(rawPath || "").trim();
  if (!candidate) return null;
  const resolved = path.resolve(CWD, candidate);
  const relative = path.relative(CWD, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

function verifyReleaseManifestArtifacts(manifest) {
  const rawEntries = manifest?.artifact_hashes ?? manifest?.artifacts ?? manifest?.files;
  const entries = [];
  if (Array.isArray(rawEntries)) {
    for (const entry of rawEntries) {
      if (!entry || typeof entry !== "object") continue;
      entries.push({
        field: String(entry.field || entry.name || "").trim(),
        path: String(entry.path || entry.file || entry.relative_path || "").trim(),
        expected: String(entry.sha256 || entry.hash || "").trim().toLowerCase(),
      });
    }
  } else if (rawEntries && typeof rawEntries === "object") {
    for (const [field, entry] of Object.entries(rawEntries)) {
      if (typeof entry === "string") {
        entries.push({ field: String(field), path: String(field), expected: entry.trim().toLowerCase() });
      } else if (entry && typeof entry === "object") {
        entries.push({
          field: String(entry.field || field).trim(),
          path: String(entry.path || entry.file || entry.relative_path || "").trim(),
          expected: String(entry.sha256 || entry.hash || "").trim().toLowerCase(),
        });
      }
    }
  }

  const blockers = [];
  const verifiedFields = [];
  const requiredFields = ["source_hash", "lockfile_hash", "migration_hash", "env_hash", "db_snapshot_hash", "backup_hash"];
  for (const field of requiredFields) {
    const entry = entries.find((candidate) => candidate.field === field);
    const declared = String(manifest?.[field] || "").trim().toLowerCase();
    if (!entry || !entry.path || !entry.expected || !declared) {
      blockers.push(`manifest_hash_unverifiable_${field}`);
      continue;
    }
    if (entry.expected !== declared) {
      blockers.push(`manifest_hash_declaration_mismatch_${field}`);
      continue;
    }
    const artifactPath = resolveReleaseArtifactPath(entry.path);
    if (!artifactPath || !fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      blockers.push(`manifest_artifact_missing_${field}`);
      continue;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
    if (actual !== declared) {
      blockers.push(`manifest_artifact_hash_mismatch_${field}`);
      continue;
    }
    verifiedFields.push(field);
  }
  return { ok: blockers.length === 0, verified_fields: verifiedFields, blockers };
}

function verifyReleaseManifestSignatures(manifest) {
  const signatures = Array.isArray(manifest?.signatures) ? manifest.signatures : [];
  const payload = releaseManifestSigningPayload(manifest);
  const trustedKeys = new Map();
  for (const rawPath of RELEASE_TRUSTED_PUBLIC_KEY_PATHS) {
    const trustedPath = path.resolve(CWD, rawPath);
    try {
      const publicKey = fs.readFileSync(trustedPath, "utf8").trim();
      if (publicKey) trustedKeys.set(sha256(publicKey), publicKey);
    } catch (_error) {
      // Missing trusted keys are reported as a fail-closed blocker below.
    }
  }
  const validSignatures = [];
  const blockers = [];
  if (trustedKeys.size === 0) blockers.push("manifest_trusted_key_set_missing");
  for (const [index, entry] of signatures.entries()) {
    if (!entry || typeof entry !== "object") {
      blockers.push(`manifest_signature_${index}_invalid_shape`);
      continue;
    }
    const algorithm = String(entry.algorithm || "").trim().toLowerCase();
    const publicKey = entry.public_key_pem || entry.public_key;
    const encodedSignature = entry.signature_base64 || entry.signature;
    const keyId = String(entry.key_id || "").trim();
    const trustedPublicKey = trustedKeys.get(keyId);
    if (algorithm !== "ed25519" || !publicKey || !encodedSignature || !keyId) {
      blockers.push(`manifest_signature_${index}_unsupported`);
      continue;
    }
    if (!trustedPublicKey || trustedPublicKey.trim() !== String(publicKey).trim()) {
      blockers.push(`manifest_signature_${index}_untrusted_key`);
      continue;
    }
    if (RELEASE_REVOKED_KEY_IDS.has(keyId)) {
      blockers.push(`manifest_signature_${index}_revoked_key`);
      continue;
    }
    try {
      const signature = Buffer.from(String(encodedSignature), String(entry.encoding || "base64"));
      if (crypto.verify(null, payload, publicKey, signature)) validSignatures.push(index);
      else blockers.push(`manifest_signature_${index}_invalid`);
    } catch (_error) {
      blockers.push(`manifest_signature_${index}_invalid`);
    }
  }
  if (validSignatures.length === 0) blockers.push("manifest_no_valid_signature");
  return { ok: blockers.length === 0, valid_signature_indexes: validSignatures, blockers };
}

function evaluateReleaseSelectionGate() {
  const releaseIdValid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(RELEASE_ID)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(RELEASE_ID);
  const selectionOk = releaseIdValid && !!COMMERCIAL_EVIDENCE_DIR && !!RELEASE_MANIFEST;
  const blockers = [];
  if (!releaseIdValid) blockers.push("release_id_invalid_or_missing");
  if (!COMMERCIAL_EVIDENCE_DIR) blockers.push("commercial_evidence_dir_missing");
  if (!RELEASE_MANIFEST) blockers.push("release_manifest_missing");
  let manifest = null;
  if (RELEASE_MANIFEST) {
    const manifestPath = path.resolve(CWD, RELEASE_MANIFEST);
    if (!fs.existsSync(manifestPath)) {
      blockers.push("release_manifest_file_missing");
    } else {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (_error) {
        blockers.push("release_manifest_invalid_json");
      }
    }
  }
  const requiredFields = [
    "release_id",
    "commit",
    "source_hash",
    "lockfile_hash",
    "migration_hash",
    "runtime",
    "base_image_digest",
    "app_image_digest",
    "env_hash",
    "db_snapshot_hash",
    "backup_hash",
    "audit_root",
    "issued_at",
    "expires_at",
    "revocation_status",
    "signatures",
  ];
  if (manifest && typeof manifest === "object") {
    for (const field of requiredFields) {
      if (manifest[field] == null || manifest[field] === "" || (Array.isArray(manifest[field]) && manifest[field].length === 0)) {
        blockers.push(`manifest_missing_${field}`);
      }
    }
    if (String(manifest.release_id || "") !== RELEASE_ID) blockers.push("manifest_release_id_mismatch");
    if (String(manifest.revocation_status || "").toLowerCase() !== "valid") blockers.push("manifest_revocation_not_valid");
    const expiresAt = Date.parse(String(manifest.expires_at || ""));
    if (!Number.isFinite(expiresAt)) blockers.push("manifest_expires_at_invalid");
    else if (expiresAt <= Date.now()) blockers.push("manifest_expired");
  }
  const artifactVerification = manifest ? verifyReleaseManifestArtifacts(manifest) : { ok: false, verified_fields: [], blockers: ["manifest_missing"] };
  const signatureVerification = manifest ? verifyReleaseManifestSignatures(manifest) : { ok: false, valid_signature_indexes: [], blockers: ["manifest_missing"] };
  blockers.push(...artifactVerification.blockers, ...signatureVerification.blockers);
  return {
    release_selection_gate: selectionOk,
    release_manifest_gate: selectionOk && blockers.length === 0,
    release_id: RELEASE_ID || null,
    evidence_dir: COMMERCIAL_EVIDENCE_DIR || null,
    manifest_path: RELEASE_MANIFEST || null,
    blockers: [...new Set(blockers)],
    artifact_verification: artifactVerification,
    signature_verification: signatureVerification,
  };
}

function evaluateExternalEvidenceGates() {
  const report = validateCommercialEvidence({
    evidenceRoot: COMMERCIAL_EVIDENCE_ROOT,
    evidenceDir: COMMERCIAL_EVIDENCE_DIR || null,
  });
  const ext = report.ext || {};
  const poc = report.poc || {};
  const empty = (key) => ({
    ok: false,
    status: "missing",
    file: null,
    errors: [`${key} evidence is missing`],
  });
  const pocItems = Object.entries(poc);
  const pocErrors = pocItems.flatMap(([key, item]) => (item?.ok ? [] : [`${key}: ${(item?.errors || ["missing"]).join("; ")}`]));

  return {
    latest_dir: report.latest_evidence_dir || null,
    wallet_evidence_gate: ext.EXT_002 || empty("EXT-002"),
    real_payment_evidence_gate: ext.EXT_001 || empty("EXT-001"),
    tls_evidence_gate: ext.EXT_003 || empty("EXT-003"),
    store_ops_drill_gate: ext.EXT_004 || empty("EXT-004"),
    poc_package_gate: {
      ok: Boolean(report.poc_all_pass),
      status: report.poc_all_pass ? "pass" : "fail",
      items: poc,
      errors: pocErrors,
    },
    strict_report: report,
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
  const walletAdapterType = String(ENV.WALLET_ADAPTER_TYPE || "mock").trim().toLowerCase();
  if (!["wallet_deeplink", "hashport_deeplink"].includes(walletAdapterType)) {
    blockers.push("WALLET_ADAPTER_TYPE must be a configured wallet deeplink adapter");
  }
  if (!WALLET_ADAPTER.available || !WALLET_ADAPTER.wallet_deeplink_template_configured) {
    blockers.push("wallet deeplink adapter is not fully configured");
  }
  const releaseGateRequired = APP_ENV === "production"
    || ["pilot", "commercial"].includes(DEPLOYMENT_STAGE)
    || COMMERCIAL_GO_MODE;
  if (releaseGateRequired && !INTERNAL_APP_ORIGIN) {
    blockers.push("INTERNAL_APP_ORIGIN must be configured for production-like worker ingest");
  }
  if (releaseGateRequired && INTERNAL_APP_ORIGIN && INTERNAL_APP_ORIGIN === APP_HOST) {
    blockers.push("INTERNAL_APP_ORIGIN must not equal the public APP_HOST");
  }
  if (releaseGateRequired && !isEvmAddress(REFUND_TREASURY_ADDRESS)) {
    blockers.push("REFUND_TREASURY_ADDRESS must be configured for production-like refund verification");
  }
  if (releaseGateRequired) {
    const activeStores = db.prepare(`SELECT id, chain_id, refund_treasury_approval_ref FROM stores WHERE status = 'active'`).all();
    for (const store of activeStores) {
      const treasury = getRefundTreasuryConfig({ storeId: store.id, chainId: store.chain_id });
      if (!treasury || isPlaceholderLike(store.refund_treasury_approval_ref)) {
        blockers.push(`store_refund_treasury_gate_failed:${store.id}`);
      }
    }
  }
  if (releaseGateRequired && ENABLED_PAYMENT_CHAIN_IDS.length > 1) {
    blockers.push("multi-chain production-like issuance requires an approved per-chain policy and credential registry");
  }
  if (INSECURE_SECRETS.has(APP_SECRET) || APP_SECRET.length < 32) blockers.push("APP_SECRET is weak");
  if (INSECURE_SECRETS.has(SERVICE_INGEST_SECRET) || SERVICE_INGEST_SECRET.length < 32) blockers.push("SERVICE_INGEST_SECRET is weak");
  if (INSECURE_SECRETS.has(METRICS_SECRET) || METRICS_SECRET.length < 32) blockers.push("METRICS_SECRET is weak");
  if (CORS_ALLOW_ORIGINS.some((origin) => origin === "*" || origin.includes("*"))) blockers.push("CORS_ALLOW_ORIGINS wildcard is not allowed");
  if (!TRUST_PROXY) blockers.push("TRUST_PROXY must be enabled");
  if (APP_ENV === "production" && !TRUST_PROXY_CONFIGURED) {
    blockers.push("production TRUST_PROXY requires TRUST_PROXY_HOPS or TRUST_PROXY_CIDRS");
  }
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
  const policyUrlsGate = evaluatePolicyUrlsGate();
  const releaseGate = evaluateReleaseSelectionGate();
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
      && TOKEN_DECIMALS === APPROVED_TOKEN_DECIMALS
      && JPYC_BASE_UNIT_SCALE === APPROVED_LEDGER_BASE_UNIT_SCALE,
    confirmation_policy_gate:
      !isPlaceholderLike(CONFIRMATIONS_POLICY_APPROVAL_REF)
      && REQUIRED_CONFIRMATIONS >= MIN_REQUIRED_CONFIRMATIONS,
    backscan_policy_gate: !isPlaceholderLike(BACKSCAN_POLICY_APPROVAL_REF) && MONITOR_BACKSCAN_BLOCKS >= MIN_MONITOR_BACKSCAN_BLOCKS,
    policy_urls_gate: policyUrlsGate.ok,
    release_selection_gate: releaseGate.release_selection_gate,
    release_manifest_gate: releaseGate.release_manifest_gate,
    wallet_evidence_gate: externalEvidence.wallet_evidence_gate.ok,
    real_payment_evidence_gate: externalEvidence.real_payment_evidence_gate.ok,
    tls_evidence_gate: externalEvidence.tls_evidence_gate.ok,
    store_ops_drill_gate: externalEvidence.store_ops_drill_gate.ok,
    poc_package_gate: externalEvidence.poc_package_gate.ok,
    audit_chain_gate: auditChainOk,
    settlement_policy_gate: settlementPolicy === "block",
    refund_policy_gate: REFUND_EXECUTION_REQUIRES_DISTINCT_ACTOR,
    dangerous_flags_gate: dangerousFlagsGate.ok,
    chain_reorg_gate: Number(runtimeMetrics.unresolved_reorg_count || 0) === 0,
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
  const releaseGateRequired = IS_PRODUCTION || ["pilot", "commercial"].includes(DEPLOYMENT_STAGE) || gates.commercial_go_mode;
  if (releaseGateRequired) {
    if (!gates.chain_reorg_gate) blockers.push("chain_reorg_gate");
    if (!gates.release_selection_gate) blockers.push("release_selection_gate");
    if (!gates.release_manifest_gate) blockers.push("release_manifest_gate");
    if (!gates.policy_urls_gate) blockers.push("policy_urls_gate");
  }
  if (gates.commercial_go_mode) {
    if (!gates.policy_urls_gate) blockers.push("policy_urls_gate");
    if (!gates.wallet_evidence_gate) blockers.push("wallet_evidence_gate");
    if (!gates.real_payment_evidence_gate) blockers.push("real_payment_evidence_gate");
    if (!gates.tls_evidence_gate) blockers.push("tls_evidence_gate");
    if (!gates.store_ops_drill_gate) blockers.push("store_ops_drill_gate");
    if (!gates.poc_package_gate) blockers.push("poc_package_gate");
  }

  let commercialVerdict = "LIMITED_PILOT_MODE";
  if (gates.commercial_go_mode) {
    commercialVerdict = blockers.length === 0 ? "COMMERCIAL_GO_10" : "CONDITIONAL_NO_GO_FOR_COMMERCIAL";
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
    release_gate: releaseGate,
    policy_urls: policyUrlsGate,
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
      policy_urls: gate.policy_urls || null,
      poc_evidence: gate.external_evidence?.poc_package_gate || null,
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

const transferInterface = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

function parseRpcUrls(value, label) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((rawUrl) => {
      try {
        const parsed = new URL(rawUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`unsupported protocol: ${parsed.protocol}`);
        return parsed.toString();
      } catch (error) {
        console.error(`FATAL: ${label} contains invalid URL "${rawUrl}": ${String(error.message || error)}`);
        process.exit(1);
      }
    });
}

function rpcUrlsForChain(chainId) {
  const chainSpecific = parseRpcUrls(ENV[`RPC_URLS_${chainId}`], `RPC_URLS_${chainId}`);
  if (chainSpecific.length > 0) return chainSpecific;
  return String(chainId) === String(CHAIN_ID) ? parseRpcUrls(RPC_URLS.join(","), "RPC_URLS") : [];
}

const rpcProvidersByChain = new Map(
  listEnabledPaymentChains(ENABLED_PAYMENT_CHAIN_IDS).map((chain) => {
    const chainId = String(chain.chain_id);
    const numericChainId = Number(chainId);
    const providers = rpcUrlsForChain(chainId).map((url) => new JsonRpcProvider(
      url,
      Number.isFinite(numericChainId) ? numericChainId : undefined,
      { staticNetwork: true }
    ));
    return [chainId, providers];
  })
);
const rpcProviders = rpcProvidersByChain.get(String(CHAIN_ID)) || [];

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

function getReceiveAddressPoolPolicy(storeId, chainId = CHAIN_ID) {
  const store = db.prepare(`SELECT merchant_id FROM stores WHERE id = ?`).get(storeId);
  const chain = getSupportedPaymentChain(chainId);
  if (!chain) {
    return { error: { code: "UNSUPPORTED_PAYMENT_CHAIN", message: "unsupported payment chain" } };
  }
  return {
    merchantId: store?.merchant_id || "merchant-001",
    storeId,
    network: chain.chain_id,
    tokenContract: chain.token_contract,
  };
}

function listReceiveAddresses(storeId, chainId = CHAIN_ID) {
  const policy = getReceiveAddressPoolPolicy(storeId, chainId);
  if (policy.error) return [];
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

function hasConfiguredReceiveAddressPool(storeId, chainId = CHAIN_ID) {
  const policy = getReceiveAddressPoolPolicy(storeId, chainId);
  if (policy.error) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM receive_addresses
       WHERE store_id = ?
         AND network = ?
         AND lower(token_contract) = lower(?)`
    )
    .get(policy.storeId, policy.network, policy.tokenContract);
  return Number(row?.count || 0) > 0;
}

function allocateReceiveAddress({ storeId, invoiceId, chainId = CHAIN_ID }) {
  const policy = getReceiveAddressPoolPolicy(storeId, chainId);
  if (policy.error) return null;
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

function importReceiveAddresses({ storeId, actorId, addresses, sourceLabel, chainId, requestId, idempotencyKey, ip }) {
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
    normalizedEntries.push({ address, sourceLabel: source || "ops_import" });
  }

  if (normalizedEntries.length === 0) {
    return { error: { code: "VALIDATION_ERROR", message: "at least one receive address is required" } };
  }

  const policy = getReceiveAddressPoolPolicy(storeId, chainId);
  if (policy.error) return { error: policy.error };
  const imported = [];
  try {
    db.transaction(() => {
      for (const entry of normalizedEntries) {
        const id = uuid();
        const ts = nowIso();
        try {
          db.prepare(
            `INSERT INTO receive_addresses
             (id, merchant_id, store_id, network, token_contract, address, status, source_label, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`
          ).run(id, policy.merchantId, policy.storeId, policy.network, policy.tokenContract, entry.address, entry.sourceLabel, ts, ts);
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

async function withRpcProvider(label, fn, chainId = CHAIN_ID) {
  const providers = rpcProvidersByChain.get(String(chainId)) || [];
  if (providers.length === 0) {
    throw new Error("rpc_unavailable");
  }
  let lastError = null;
  for (const provider of providers) {
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

async function verifyTransferOnChain({
  txHash,
  chainId = CHAIN_ID,
  expectedTokenContract = APPROVED_TOKEN_CONTRACT,
  expectedToAddress = null,
  expectedFromAddress = null,
  expectedFromAddresses = null,
  expectedAmountAtomic = null,
}) {
  const parsedTxHash = parseTxHash(txHash);
  if (!parsedTxHash) {
    return { ok: false, code: "INVALID_TX_HASH", message: "tx_hash must be a 0x-prefixed 32-byte hash" };
  }

  return withRpcProvider("verify_transfer", async (provider) => {
    const rpcChainIdHex = String(await provider.send("eth_chainId", []));
    const rpcChainId = rpcChainIdHex.startsWith("0x") ? BigInt(rpcChainIdHex).toString() : rpcChainIdHex;
    if (String(rpcChainId) !== String(chainId)) {
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
    const block = receipt.blockNumber != null ? await provider.getBlock(Number(receipt.blockNumber)) : null;
    const observedAt = block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : nowIso();
    const receiptBlockHash = String(receipt.blockHash || "").toLowerCase();
    const canonicalBlockHash = String(block?.hash || "").toLowerCase();
    const canonicalStatus = receiptBlockHash && canonicalBlockHash && receiptBlockHash === canonicalBlockHash
      ? "canonical"
      : "unknown";

    const transferLogs = getReceiptTransferLogs(receipt, expectedTokenContract);
    if (transferLogs.length === 0) {
      return { ok: false, code: "WRONG_TOKEN", message: "approved token Transfer log not found", receipt, confirmations, observedAt, canonicalStatus };
    }

    const expectedTo = expectedToAddress ? normalizeAddress(expectedToAddress) : null;
    const toMatches = expectedTo ? transferLogs.filter((log) => log.to === expectedTo) : transferLogs;
    if (expectedTo && toMatches.length === 0) {
      return { ok: false, code: "WRONG_RECIPIENT", message: "Transfer recipient does not match", receipt, confirmations, observedAt, canonicalStatus };
    }

    const expectedFromSet = new Set(
      [expectedFromAddress, ...(Array.isArray(expectedFromAddresses) ? expectedFromAddresses : [])]
        .filter(Boolean)
        .map((value) => normalizeAddress(value))
        .filter(Boolean)
    );
    const fromMatches = expectedFromSet.size > 0
      ? toMatches.filter((log) => expectedFromSet.has(log.from))
      : toMatches;
    if (expectedFromSet.size > 0 && fromMatches.length === 0) {
      return { ok: false, code: "WRONG_FROM_ADDRESS", message: "Transfer sender does not match", receipt, confirmations, observedAt, canonicalStatus };
    }

    // A single receipt may contain several matching ERC-20 Transfer logs. Do
    // not select the first exact-looking log and silently turn a split or
    // duplicate transfer into a paid/refunded decision; preserve the evidence
    // and require review instead.
    if (fromMatches.length > 1) {
      return {
        ok: false,
        code: "MULTIPLE_TRANSFERS",
        message: "multiple approved-token transfers match the expected recipient/sender",
        receipt,
        confirmations,
        observedAt,
        canonicalStatus,
        transfers: fromMatches,
        transfer: fromMatches[0],
      };
    }

    const amountMatches = expectedAmountAtomic
      ? fromMatches.filter((log) => {
          try {
            return compareBaseUnits(log.amountBase, String(expectedAmountAtomic)) === 0;
          } catch (_error) {
            return false;
          }
        })
      : fromMatches;

    if (expectedAmountAtomic && amountMatches.length === 0) {
      const candidate = fromMatches[0] || toMatches[0] || transferLogs[0];
      return {
        ok: false,
        code: "WRONG_AMOUNT",
        message: "Transfer amount does not match",
        receipt,
        confirmations,
        observedAt,
        canonicalStatus,
        transfer: candidate,
      };
    }

    return {
      ok: true,
      confirmations,
      observedAt,
      canonicalStatus,
      receipt,
      transfer: amountMatches[0] || fromMatches[0] || toMatches[0] || transferLogs[0],
    };
  }, chainId);
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
  const redactPathTokens = (pathname) => String(pathname || "")
    .replace(/^(\/t\/)[^/?#]+/i, "$1[REDACTED]")
    .replace(/^(\/api\/v1\/public\/terminal-entry\/)[^/?#]+/i, "$1[REDACTED]");
  const sensitiveQueryKeys = new Set([
    "token",
    "sse_token",
    "ref",
    "sig",
    "signature",
    "nonce",
    "access_token",
    "refresh_token",
    "api_key",
    "secret",
  ]);
  try {
    const parsed = new URL(raw, APP_HOST);
    parsed.pathname = redactPathTokens(parsed.pathname);
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitiveQueryKeys.has(String(key).toLowerCase())) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    if (!/^[a-z]+:\/\//i.test(raw)) {
      return `${parsed.pathname}${parsed.search}`;
    }
    return parsed.toString();
  } catch (_error) {
    return redactPathTokens(raw)
      .replace(
        /([?&](?:token|sse_token|ref|sig|signature|nonce|access_token|refresh_token|api_key|secret)=)[^&#]+/gi,
        "$1[REDACTED]"
      );
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
  // Preserve the lockout record for security/audit reconstruction; clearing a
  // successful login is a state transition, not a hard delete.
  db.prepare(
    `UPDATE terminal_login_lockouts
     SET failed_attempts = 0, locked_until = NULL, updated_at = ?
     WHERE terminal_code = ?`
  ).run(nowIso(), String(terminalCode));
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
    "refund.treasury.manage",
    "payment.ingest.manual",
    "payments.control",
    "policy.manage",
    "address_pool.manage",
    "settlement.close",
    "settlement.export",
    "staff.manage",
    "terminal.manage",
    "session.read",
    "session.revoke",
    "audit.read",
    "audit.export"
  ]),
  platform_ops: new Set([
    "payments.control.global",
    "monitor.read",
    "monitor.reconcile",
    "audit.read",
    "audit.export",
    "audit.read.global",
    "audit.export.global"
  ])
};

const DIRECTLY_MANAGEABLE_STAFF_ROLES = new Set(["staff", "operator", "accounting"]);

function parseStoredPermissionsOverride(rawValue) {
  if (rawValue == null || rawValue === "") return { values: null, invalid: false };
  try {
    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    if (!Array.isArray(parsed)) return { values: null, invalid: true };
    return { values: parsed.map((value) => String(value)), invalid: false };
  } catch (_error) {
    return { values: null, invalid: true };
  }
}

function validateDirectStaffSecurityChange({ role, permissionsOverride }) {
  if (!DIRECTLY_MANAGEABLE_STAFF_ROLES.has(String(role || ""))) {
    return { ok: false, reason: "privileged_role_requires_independent_approval" };
  }
  if (permissionsOverride == null) return { ok: true };
  if (!Array.isArray(permissionsOverride)) {
    return { ok: false, reason: "permissions_override_invalid" };
  }
  const rolePermissions = ROLE_PERMISSIONS[String(role)] || new Set();
  const grantsBeyondRole = permissionsOverride.some((permission) => !rolePermissions.has(String(permission)));
  if (grantsBeyondRole) {
    return { ok: false, reason: "permissions_override_grants_beyond_role" };
  }
  return { ok: true };
}

function rejectStaffSecurityChange(req, {
  actorId,
  targetId = "new",
  attemptedAction,
  reason,
  code = "STAFF_SECURITY_APPROVAL_REQUIRED",
  message = "Privileged staff security changes require independent approval",
}) {
  audit({
    storeId: req.session.store_id,
    actorType: "admin",
    actorId,
    action: "staff.security_change_rejected",
    targetType: "staff",
    targetId,
    requestId: requestIdFromReq(req),
    idempotencyKey: req.header("Idempotency-Key"),
    afterState: {
      attempted_action: attemptedAction,
      reason,
    },
    ip: req.ip,
  });
  return { status: 403, body: { error: { code, message } } };
}

function isPlatformOperator(session) {
  return ["platform_ops", "platform_admin"].includes(String(session?.role || ""));
}

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

function projectStaffUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    staff_name: row.staff_name,
    role: row.role,
    status: row.status,
    permissions_override: row.permissions_override || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function projectTerminalSession(row) {
  if (!row) return null;
  return {
    id: row.id || row.session_id,
    terminal_id: row.terminal_id || null,
    terminal_code: row.terminal_code || null,
    staff_user_id: row.staff_user_id || null,
    staff_name: row.staff_name || null,
    role: row.role || null,
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    revoked_at: row.revoked_at || null,
    ended_reason: row.ended_reason || null,
  };
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

function requirePlatformPermission(permission) {
  return (req, res, next) => {
    if (!req.session) return jsonError(res, 401, "UNAUTHORIZED", "Session required");
    if (!isPlatformOperator(req.session) || !hasPermission(req.session, permission)) {
      return jsonError(res, 403, "FORBIDDEN", `Platform permission denied: ${permission}`);
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
    review_required: new Set(["review_required", "confirming", "paid", "cancelled"]),
    cancelled: new Set(["review_required"])
  };
  return transitions[from] && transitions[from].has(to);
}

const AUDIT_OMITTED_FIELD_NAMES = new Set([
  "authorization",
  "bearer_token",
  "access_token",
  "refresh_token",
  "session_token",
  "sse_token",
  "token",
  "token_hash",
  "pin",
  "staff_pin",
  "new_pin",
  "pin_hash",
  "public_entry_token",
  "fixed_qr_url",
  "fixed_qr_payload",
  "payment_url",
  "pay_url",
  "private_key",
  "secret_key",
  "signing_key",
  "client_secret",
  "api_key",
  "password",
  "passphrase",
  "mnemonic",
  "seed",
  "seed_phrase",
  "recovery_phrase",
  "keystore",
  "credential",
  "credentials",
]);

const AUDIT_SECRET_FIELD_NAME_PATTERNS = [
  /(?:^|_)private_key(?:$|_)/,
  /(?:^|_)secret_key(?:$|_)/,
  /(?:^|_)signing_key(?:$|_)/,
  /(?:^|_)client_secret(?:$|_)/,
  /(?:^|_)api_key(?:$|_)/,
  /(?:^|_)password(?:$|_)/,
  /(?:^|_)passphrase(?:$|_)/,
  /(?:^|_)mnemonic(?:$|_)/,
  /(?:^|_)seed(?:_phrase)?(?:$|_)/,
  /(?:^|_)recovery_phrase(?:$|_)/,
  /(?:^|_)keystore(?:$|_)/,
  /(?:^|_)credentials?(?:$|_)/,
];

function normalizeAuditFieldName(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

function isSignedPaymentReference(value) {
  const raw = String(value || "");
  return /\/pay\?[^\s"'<>]*(?:ref|sig|nonce)=/i.test(raw)
    || /\/(?:mobile\.html|api\/v1\/public\/invoices\/[^?\s"'<>]+)\?[^\s"'<>]*(?:sig|nonce)=/i.test(raw)
    || /(?:%2f)?pay%3f[^\s"'<>]*(?:ref|sig|nonce)(?:=|%3d)/i.test(raw)
    || /[?&](?:sse_token|access_token|refresh_token)=/i.test(raw)
    || /\/t\/[A-Za-z0-9_-]{12,}/.test(raw);
}

function isSecretAuditFieldName(normalizedKey) {
  return AUDIT_OMITTED_FIELD_NAMES.has(normalizedKey)
    || AUDIT_SECRET_FIELD_NAME_PATTERNS.some((pattern) => pattern.test(normalizedKey));
}

function containsExplicitSecretAssignment(value) {
  const raw = String(value || "");
  return /(?:^|[\s?&,{])(?:private[_-]?key|secret[_-]?key|signing[_-]?key|client[_-]?secret|api[_-]?key|password|passphrase|mnemonic|seed[_-]?phrase|recovery[_-]?phrase)\s*(?:=|:)\s*[^\s,;}]+/i.test(raw)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw);
}

function sanitizeAuditState(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (/\bbearer\s+[^\s,;]+/i.test(value)) return "[REDACTED_BEARER_TOKEN]";
    if (isSignedPaymentReference(value)) return "[REDACTED_SIGNED_URL]";
    if (containsExplicitSecretAssignment(value)) return "[REDACTED_SECRET]";
    return value;
  }
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED_CIRCULAR_REFERENCE]";
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.map((item) => sanitizeAuditState(item, seen));
    seen.delete(value);
    return sanitized;
  }
  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = normalizeAuditFieldName(key);
    if (isSecretAuditFieldName(normalizedKey)) continue;
    if (normalizedKey === "qr_payload" && isSignedPaymentReference(nested)) continue;
    sanitized[key] = sanitizeAuditState(nested, seen);
  }
  seen.delete(value);
  return sanitized;
}

function sanitizeAuditMetadataValue(value) {
  if (value == null || value === "") return null;
  const sanitized = sanitizeAuditState(String(value));
  return typeof sanitized === "string" ? sanitized : "[REDACTED_AUDIT_METADATA]";
}

function sanitizeStoredAuditState(value, context) {
  if (value == null || value === "") return null;
  try {
    return JSON.stringify(sanitizeAuditState(JSON.parse(value)));
  } catch (error) {
    console.warn(
      JSON.stringify({
        ts: nowIso(),
        level: "warn",
        type: "audit.response_state_parse_failed",
        context,
        message: String(error.message || error),
      })
    );
    return JSON.stringify("[REDACTED_UNPARSEABLE_AUDIT_STATE]");
  }
}

function sanitizeAuditLogRowForResponse(row) {
  if (!row) return null;
  return {
    ...row,
    target_id: sanitizeAuditMetadataValue(row.target_id),
    request_id: sanitizeAuditMetadataValue(row.request_id),
    idempotency_key: sanitizeAuditMetadataValue(row.idempotency_key),
    before_state: sanitizeStoredAuditState(row.before_state, `audit:${row.id}:before_state`),
    after_state: sanitizeStoredAuditState(row.after_state, `audit:${row.id}:after_state`),
  };
}

function activeAuditEpochForNextRow() {
  const nextRowid = Number(
    db.prepare(`SELECT COALESCE(MAX(rowid), 0) + 1 AS next_rowid FROM audit_logs`).get()?.next_rowid || 1
  );
  const epoch = db.prepare(
    `SELECT * FROM audit_epochs WHERE start_rowid <= ? ORDER BY start_rowid DESC LIMIT 1`
  ).get(nextRowid);
  if (!epoch || !AUDIT_HASH_VERSIONS.has(String(epoch.hash_version || ""))) {
    throw new Error("No supported audit epoch is available for the next audit row");
  }
  return { ...epoch, next_rowid: nextRowid };
}

function audit({
  storeId,
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
  const sanitizedTargetId = sanitizeAuditMetadataValue(targetId);
  const sanitizedRequestId = sanitizeAuditMetadataValue(requestId);
  const sanitizedIdempotencyKey = sanitizeAuditMetadataValue(idempotencyKey);
  const sanitizedBeforeState = sanitizeAuditState(beforeState);
  const sanitizedAfterState = sanitizeAuditState(afterState);
  const resolvedStoreId = resolveAuditStoreId({
    storeId,
    targetType,
    targetId: sanitizedTargetId,
    beforeState: sanitizedBeforeState,
    afterState: sanitizedAfterState,
  });
  const auditEpoch = activeAuditEpochForNextRow();
  const latest = db.prepare(`SELECT entry_hash FROM audit_logs ORDER BY rowid DESC LIMIT 1`).get();
  const prevHash = latest?.entry_hash || null;
  const entryHash = computeAuditEntryHash(prevHash, {
    auditEpoch: auditEpoch.id,
    storeId: resolvedStoreId,
    actorType,
    actorId,
    action,
    targetType,
    targetId: sanitizedTargetId,
    requestId: sanitizedRequestId,
    idempotencyKey: sanitizedIdempotencyKey,
    beforeState: sanitizedBeforeState,
    afterState: sanitizedAfterState,
    ip,
    createdAt
  }, auditEpoch.hash_version);
  db.prepare(
    `INSERT INTO audit_logs
    (id, store_id, audit_epoch, actor_type, actor_id, action, target_type, target_id, request_id, idempotency_key, before_state, after_state, prev_hash, entry_hash, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    resolvedStoreId,
    auditEpoch.id,
    actorType,
    actorId,
    action,
    targetType,
    sanitizedTargetId,
    sanitizedRequestId,
    sanitizedIdempotencyKey,
    sanitizedBeforeState == null ? null : JSON.stringify(sanitizedBeforeState),
    sanitizedAfterState == null ? null : JSON.stringify(sanitizedAfterState),
    prevHash,
    entryHash,
    ip || null,
    createdAt
  );
}

const RESOLVED_REFUND_STATUSES = new Set(["succeeded", "verified", "cancelled", "rejected"]);
const REFUND_RESERVATION_RELEASED_STATUSES = new Set(["cancelled", "rejected"]);

function isUnresolvedRefundStatus(status) {
  const value = String(status || "").trim();
  return !RESOLVED_REFUND_STATUSES.has(value);
}

function refundLedgerIntegrityError(refundId) {
  const error = new Error(`Invalid refund amount in ledger row ${String(refundId || "unknown")}`);
  error.code = "REFUND_LEDGER_INTEGRITY_ERROR";
  error.refundId = String(refundId || "unknown");
  return error;
}

function refundLedgerIntegrityApiResult(error) {
  return {
    status: 409,
    body: {
      error: {
        code: "REFUND_LEDGER_INTEGRITY_ERROR",
        message: "Refund ledger amount is invalid; operation stopped for accounting safety",
        details: { refund_id: error?.refundId || null },
      },
    },
  };
}

function parseRefundAmountBaseStrict(refund) {
  const raw = String(refund?.refund_amount_jpyc_base ?? "").trim();
  if (!/^\d+$/.test(raw)) throw refundLedgerIntegrityError(refund?.id);
  let amount;
  try {
    amount = BigInt(raw);
  } catch (_error) {
    throw refundLedgerIntegrityError(refund?.id);
  }
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw refundLedgerIntegrityError(refund?.id);
  }
  return amount;
}

function computeReservedRefundAmountBase({ invoiceId, reviewCaseId, refundCaseId }) {
  const rows = db
    .prepare(
      `SELECT id, status, refund_amount_jpyc_base
       FROM refund_requests
       WHERE invoice_id = ? OR review_case_id = ? OR refund_case_id = ?`
    )
    .all(String(invoiceId || ""), String(reviewCaseId || ""), String(refundCaseId || ""));
  return rows.reduce((total, row) => {
    const amount = parseRefundAmountBaseStrict(row);
    if (REFUND_RESERVATION_RELEASED_STATUSES.has(String(row.status || "").trim())) return total;
    return amount > 0n ? total + amount : total;
  }, 0n).toString();
}

function findActiveRefundBySemantic({ reviewCaseId, refundCaseId, refundAmountBase, refundToAddress, refundChainId }) {
  return db
    .prepare(
      `SELECT *
       FROM refund_requests
       WHERE (refund_case_id = ? OR review_case_id = ?)
         AND refund_amount_jpyc_base = ?
         AND lower(refund_to_address) = lower(?)
         AND refund_chain_id = ?
         AND status IN ('approved', 'recorded', 'pending_verification', 'verification_failed', 'failed', 'succeeded', 'verified')
       ORDER BY rowid ASC
       LIMIT 1`
    )
    .get(
      String(refundCaseId || ""),
      String(reviewCaseId || ""),
      String(refundAmountBase || ""),
      String(refundToAddress || ""),
      String(refundChainId || "")
  );
}

function getOrCreateRefundCase({ invoice, relatedReviewCaseId = null, reason = null, requestedBy }) {
  const existing = db
    .prepare(
      `SELECT * FROM refund_cases
       WHERE invoice_id = ?
         AND COALESCE(related_review_case_id, '') = COALESCE(?, '')
         AND status NOT IN ('cancelled', 'rejected')
       ORDER BY created_at ASC, id ASC
       LIMIT 1`
    )
    .get(invoice.id, relatedReviewCaseId || null);
  if (existing) return { row: existing, created: false };
  const timestamp = nowIso();
  const id = uuid();
  db.prepare(
    `INSERT INTO refund_cases
     (id, invoice_id, store_id, related_review_case_id, reason, status, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?)`
  ).run(
    id,
    invoice.id,
    invoice.store_id,
    relatedReviewCaseId || null,
    reason || null,
    requestedBy,
    timestamp,
    timestamp,
  );
  return { row: db.prepare(`SELECT * FROM refund_cases WHERE id = ?`).get(id), created: true };
}

function isProductionLikeRuntime() {
  return IS_PRODUCTION || ["pilot", "commercial"].includes(DEPLOYMENT_STAGE) || COMMERCIAL_GO_MODE;
}

function getRefundTreasuryConfig({ storeId, chainId }) {
  const requestedChainId = String(chainId || "").trim();
  const store = db
    .prepare(
      `SELECT id, chain_id, refund_treasury_address, refund_treasury_chain_id, refund_treasury_approval_ref
       FROM stores WHERE id = ?`
    )
    .get(String(storeId || ""));
  const storeChainId = String(store?.refund_treasury_chain_id || store?.chain_id || "").trim();
  if (store && storeChainId === requestedChainId && isEvmAddress(store.refund_treasury_address)) {
    const approvalRef = String(store.refund_treasury_approval_ref || "").trim();
    if (isProductionLikeRuntime() && isPlaceholderLike(approvalRef)) return null;
    return {
      address: normalizeAddress(store.refund_treasury_address),
      chain_id: storeChainId,
      approval_ref: approvalRef || null,
      source: "store",
    };
  }
  if (!isProductionLikeRuntime() && requestedChainId === String(CHAIN_ID) && isEvmAddress(REFUND_TREASURY_ADDRESS)) {
    return {
      address: normalizeAddress(REFUND_TREASURY_ADDRESS),
      chain_id: requestedChainId,
      approval_ref: REFUND_TREASURY_APPROVAL_REF || null,
      source: "environment_development_fallback",
    };
  }
  return null;
}

function getRefundFundingLineage(refundId) {
  return db.prepare(`SELECT * FROM refund_funding_lineage WHERE refund_request_id = ?`).get(String(refundId || "")) || null;
}

function getRefundFundingSweeps(refundId) {
  return db
    .prepare(
      `SELECT * FROM refund_funding_sweeps
       WHERE invoice_id = (SELECT invoice_id FROM refund_requests WHERE id = ?)
         AND store_id = (SELECT store_id FROM invoices WHERE id = (SELECT invoice_id FROM refund_requests WHERE id = ?))
       ORDER BY created_at ASC, id ASC`
    )
    .all(String(refundId || ""), String(refundId || ""));
}

function getRefundFundingAllocationParts(refundId = null, sweepId = null) {
  const clauses = [];
  const params = [];
  if (refundId) {
    clauses.push("refund_request_id = ?");
    params.push(String(refundId));
  }
  if (sweepId) {
    clauses.push("funding_sweep_id = ?");
    params.push(String(sweepId));
  }
  if (clauses.length === 0) return [];
  return db
    .prepare(
      `SELECT id, funding_sweep_id AS sweep_id, refund_request_id, amount_jpyc_base, idempotency_key, created_by, created_at
       FROM refund_funding_allocation_parts
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC, id ASC`
    )
    .all(...params);
}

function getRefundFundingAllocationsForConservation(refundId, sweeps = null) {
  const fundingSweeps = Array.isArray(sweeps) ? sweeps : getRefundFundingSweeps(refundId);
  const allocationById = new Map();
  for (const allocation of getRefundFundingAllocationParts(refundId)) {
    allocationById.set(String(allocation.id), allocation);
  }
  for (const sweep of fundingSweeps) {
    for (const allocation of getRefundFundingAllocationParts(null, sweep.id)) {
      allocationById.set(String(allocation.id), allocation);
    }
  }
  return [...allocationById.values()].sort((left, right) => {
    const byCreatedAt = String(left.created_at || "").localeCompare(String(right.created_at || ""));
    return byCreatedAt || String(left.id || "").localeCompare(String(right.id || ""));
  });
}

function evaluateRefundFundingConservation(refund, sweeps = null, allocations = null) {
  const refundId = String(refund?.id || "");
  const fundingSweeps = Array.isArray(sweeps) ? sweeps : getRefundFundingSweeps(refundId);
  const fundingAllocations = Array.isArray(allocations)
    ? allocations
    : getRefundFundingAllocationsForConservation(refundId, fundingSweeps);
  const requestedAmount = parseBaseUnitOrZero(refund?.refund_amount_jpyc_base);
  const sweepById = new Map(fundingSweeps.map((sweep) => [String(sweep.id), sweep]));
  const totalsBySweep = new Map();
  const violations = [];
  let refundAllocated = 0n;

  if (!refundId || requestedAmount <= 0n) {
    violations.push({
      code: "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR",
      message: "refund funding conservation requires a positive refund amount",
    });
  }

  for (const allocation of fundingAllocations) {
    const sweepId = String(allocation.sweep_id || "");
    const amount = parseBaseUnitOrZero(allocation.amount_jpyc_base);
    if (amount <= 0n) {
      violations.push({
        code: "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR",
        message: "refund funding allocation amount must be positive",
        allocation_id: allocation.id || null,
      });
      continue;
    }
    if (!sweepById.has(sweepId)) {
      violations.push({
        code: "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR",
        message: "refund funding allocation references an unrelated sweep",
        allocation_id: allocation.id || null,
        sweep_id: sweepId || null,
      });
      continue;
    }
    totalsBySweep.set(sweepId, (totalsBySweep.get(sweepId) || 0n) + amount);
    if (String(allocation.refund_request_id) === refundId) refundAllocated += amount;
  }

  const refundStoreId = String(
    refund?.store_id
      || db.prepare(`SELECT store_id FROM invoices WHERE id = ?`).get(refund?.invoice_id)?.store_id
      || ""
  );
  for (const sweep of fundingSweeps) {
    const sweepId = String(sweep.id);
    const sweepAmount = parseBaseUnitOrZero(sweep.sweep_amount_jpyc_base);
    const allocatedAmount = totalsBySweep.get(sweepId) || 0n;
    if (sweepAmount <= 0n) {
      violations.push({
        code: "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR",
        message: "refund funding sweep amount must be positive",
        sweep_id: sweepId,
      });
    }
    if (allocatedAmount > sweepAmount) {
      violations.push({
        code: "REFUND_FUNDING_SWEEP_OVERALLOCATED",
        message: "refund funding allocations exceed the verified sweep amount",
        sweep_id: sweepId,
        sweep_amount_jpyc_base: sweepAmount.toString(),
        allocated_amount_jpyc_base: allocatedAmount.toString(),
      });
    }
    if (allocatedAmount > 0n && String(sweep.status || "") !== "verified") {
      violations.push({
        code: "REFUND_FUNDING_SWEEP_NOT_VERIFIED",
        message: "allocated refund funding sweep is not verified",
        sweep_id: sweepId,
        status: String(sweep.status || "") || null,
      });
    }
  }

  const refundSweepIds = new Set(
    fundingAllocations
      .filter((allocation) => String(allocation.refund_request_id) === refundId)
      .map((allocation) => String(allocation.sweep_id))
  );
  for (const sweepId of refundSweepIds) {
    const sweep = sweepById.get(sweepId);
    const treasury = sweep
      ? getRefundTreasuryConfig({ storeId: sweep.store_id, chainId: sweep.chain_id })
      : null;
    if (!sweep
      || String(sweep.invoice_id) !== String(refund?.invoice_id || "")
      || String(sweep.store_id) !== refundStoreId
      || String(sweep.chain_id) !== String(refund?.refund_chain_id || "")
      || !treasury
      || normalizeAddress(sweep.treasury_address) !== treasury.address
      || normalizeAddress(sweep.source_address) === treasury.address) {
      violations.push({
        code: "REFUND_FUNDING_LINEAGE_MISMATCH",
        message: "refund funding sweep does not match the refund invoice, chain, or approved treasury",
        sweep_id: sweepId,
      });
    }
  }

  if (refundAllocated > requestedAmount) {
    violations.push({
      code: "REFUND_FUNDING_REFUND_OVERALLOCATED",
      message: "refund funding allocations exceed the requested refund amount",
      refund_request_id: refundId,
      refund_amount_jpyc_base: requestedAmount.toString(),
      allocated_amount_jpyc_base: refundAllocated.toString(),
    });
  }

  const conserved = violations.length === 0;
  const fullyFunded = requestedAmount > 0n && refundAllocated === requestedAmount;
  const refundRemaining = requestedAmount > refundAllocated ? requestedAmount - refundAllocated : 0n;
  const refundAllocations = fundingAllocations.filter(
    (allocation) => String(allocation.refund_request_id) === refundId
  );
  const snapshot = {
    refund_request_id: refundId || null,
    refund_amount_jpyc_base: requestedAmount.toString(),
    allocated_amount_jpyc_base: refundAllocated.toString(),
    remaining_amount_jpyc_base: refundRemaining.toString(),
    refund_fully_funded: fullyFunded,
    conserved,
    violations,
    refund_allocations: refundAllocations,
    funding_sweeps: fundingSweeps.map((sweep) => {
      const sweepAmount = parseBaseUnitOrZero(sweep.sweep_amount_jpyc_base);
      const allocatedAmount = totalsBySweep.get(String(sweep.id)) || 0n;
      return {
        id: sweep.id,
        status: sweep.status,
        sweep_amount_jpyc_base: sweepAmount.toString(),
        allocated_amount_jpyc_base: allocatedAmount.toString(),
        remaining_amount_jpyc_base: (sweepAmount > allocatedAmount ? sweepAmount - allocatedAmount : 0n).toString(),
        allocations: fundingAllocations.filter((allocation) => String(allocation.sweep_id) === String(sweep.id)),
      };
    }),
  };
  return {
    conserved,
    fullyFunded,
    executionReady: conserved && fullyFunded,
    requestedAmount,
    refundAllocated,
    totalsBySweep,
    allocations: fundingAllocations,
    snapshot,
  };
}

function buildRefundFundingAuditState(refund, conservation) {
  const {
    funding_sweeps: fundingSweeps,
    refund_allocations: refundAllocations,
    ...summary
  } = conservation.snapshot;
  return {
    refund,
    funding_sweeps: fundingSweeps,
    allocations: refundAllocations,
    conservation: summary,
  };
}

function listIntegrityHeldInvoices(storeId, range = null) {
  const clauses = ["store_id = ?", "integrity_hold = 1"];
  const params = [String(storeId || "")];
  if (range?.fromUtc && range?.toUtc) {
    clauses.push("created_at BETWEEN ? AND ?");
    params.push(range.fromUtc, range.toUtc);
  }
  return db.prepare(`SELECT id, status, integrity_hold_reason, integrity_hold_at FROM invoices WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`).all(...params);
}

function integrityHoldApiResult(rows, action = "operation") {
  return {
    status: 409,
    body: {
      error: {
        code: "INTEGRITY_HOLD_ACTIVE",
        message: `${action} is blocked while payment integrity hold is active`,
        details: { invoice_ids: rows.map((row) => row.id), holds: rows },
      },
    },
  };
}

function hasVerifiedRefundFundingLineage(refund) {
  const requestedAmount = parseBaseUnitOrZero(refund?.refund_amount_jpyc_base);
  const v2Sweeps = getRefundFundingSweeps(refund?.id);
  if (v2Sweeps.length > 0) {
    return evaluateRefundFundingConservation(refund, v2Sweeps).executionReady;
  }

  const lineage = getRefundFundingLineage(refund?.id);
  const acceptedStatuses = isProductionLikeRuntime() ? ["verified"] : ["recorded", "verified"];
  if (!lineage || !acceptedStatuses.includes(String(lineage.status || ""))) return false;
  if (String(lineage.invoice_id || "") !== String(refund?.invoice_id || "")) return false;
  if (String(lineage.chain_id || "") !== String(refund?.refund_chain_id || "")) return false;
  const refundStoreId = String(
    refund?.store_id
      || db.prepare(`SELECT store_id FROM invoices WHERE id = ?`).get(refund?.invoice_id)?.store_id
      || ""
  );
  if (String(lineage.store_id || "") !== refundStoreId) return false;
  const treasury = getRefundTreasuryConfig({ storeId: lineage.store_id, chainId: lineage.chain_id });
  if (!treasury
    || normalizeAddress(lineage.treasury_address) !== treasury.address
    || normalizeAddress(lineage.source_address) === treasury.address) return false;
  const legacyAllocations = db
    .prepare(
      `SELECT amount_jpyc_base
       FROM refund_funding_allocations
       WHERE funding_lineage_id = ? AND refund_request_id = ?`
    )
    .all(lineage.id, refund.id);
  const allocated = legacyAllocations.reduce((total, allocation) => total + parseBaseUnitOrZero(allocation.amount_jpyc_base), 0n);
  return Boolean(
    treasury
    && allocated === requestedAmount
    && allocated <= parseBaseUnitOrZero(lineage.sweep_amount_jpyc_base)
  );
}

function buildRefundDestinationApprovalMessage({ invoiceId, refundToAddress, refundAmountBase, refundChainId }) {
  return [
    "JPYC refund destination approval v1",
    `invoice_id:${String(invoiceId)}`,
    `refund_to_address:${String(refundToAddress).toLowerCase()}`,
    `refund_amount_jpyc_base:${String(refundAmountBase)}`,
    `refund_chain_id:${String(refundChainId)}`,
  ].join("\n");
}

function refundAuditLogRefs(refundId) {
  return db
    .prepare(`SELECT id, action, created_at FROM audit_logs WHERE target_type = 'refund' AND target_id = ? ORDER BY rowid ASC`)
    .all(refundId);
}

function buildRefundEvidenceResponse(refund) {
  if (!refund) return null;
  const auditRefs = refundAuditLogRefs(refund.id);
  const fundingLineage = getRefundFundingLineage(refund.id);
  const fundingSweeps = getRefundFundingSweeps(refund.id);
  const primaryFundingSweep = fundingSweeps[0] || null;
  const fundingAllocations = fundingLineage
    ? db.prepare(
      `SELECT id, funding_lineage_id, refund_request_id, amount_jpyc_base, idempotency_key, created_by, created_at
       FROM refund_funding_allocations
       WHERE funding_lineage_id = ?
       ORDER BY created_at ASC, id ASC`
    ).all(fundingLineage.id)
    : [];
  const fundingAllocationParts = getRefundFundingAllocationParts(refund.id);
  return {
    refund_request_id: refund.id,
    refund_case_id: refund.refund_case_id || null,
    review_case_id: refund.review_case_id || null,
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
    audit_log_refs: auditRefs,
    chain_id: refund.chain_id || refund.refund_chain_id || null,
    token_contract: refund.token_contract || null,
    from_address: refund.from_address || null,
    to_address: refund.to_address || refund.refund_to_address || null,
    expected_from_address: refund.expected_from_address || null,
    destination_approval_type: refund.destination_approval_type || "payer_default",
    funding_lineage_id: refund.funding_lineage_id || fundingLineage?.id || primaryFundingSweep?.id || null,
    funding_lineage: fundingLineage
      ? {
          id: fundingLineage.id,
          source_address: fundingLineage.source_address,
          treasury_address: fundingLineage.treasury_address,
          chain_id: fundingLineage.chain_id,
          sweep_tx_hash: fundingLineage.sweep_tx_hash,
          sweep_tx_log_index: fundingLineage.sweep_tx_log_index ?? null,
          sweep_amount_jpyc_base: fundingLineage.sweep_amount_jpyc_base,
          status: fundingLineage.status,
          evidence_note_path: fundingLineage.evidence_note_path || null,
          created_at: fundingLineage.created_at,
          updated_at: fundingLineage.updated_at,
          allocations: fundingAllocations,
        }
      : primaryFundingSweep
        ? {
            id: primaryFundingSweep.id,
            source_address: primaryFundingSweep.source_address,
            treasury_address: primaryFundingSweep.treasury_address,
            chain_id: primaryFundingSweep.chain_id,
            sweep_tx_hash: primaryFundingSweep.sweep_tx_hash,
            sweep_tx_log_index: primaryFundingSweep.sweep_tx_log_index ?? null,
            sweep_amount_jpyc_base: primaryFundingSweep.sweep_amount_jpyc_base,
            status: primaryFundingSweep.status,
            evidence_note_path: primaryFundingSweep.evidence_note_path || null,
            created_at: primaryFundingSweep.created_at,
            updated_at: primaryFundingSweep.updated_at,
            allocations: fundingAllocationParts.filter((allocation) => allocation.sweep_id === primaryFundingSweep.id),
          }
        : null,
    funding_allocations: fundingAllocations,
    funding_sweeps: fundingSweeps.map((sweep) => ({
      id: sweep.id,
      invoice_id: sweep.invoice_id,
      store_id: sweep.store_id,
      source_address: sweep.source_address,
      treasury_address: sweep.treasury_address,
      chain_id: sweep.chain_id,
      sweep_tx_hash: sweep.sweep_tx_hash,
      sweep_tx_log_index: sweep.sweep_tx_log_index ?? null,
      sweep_amount_jpyc_base: sweep.sweep_amount_jpyc_base,
      status: sweep.status,
      evidence_note_path: sweep.evidence_note_path || null,
      created_at: sweep.created_at,
      updated_at: sweep.updated_at,
      allocations: fundingAllocationParts.filter((allocation) => allocation.sweep_id === sweep.id),
    })),
    funding_allocation_parts: fundingAllocationParts,
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
  const epochs = db.prepare(`SELECT * FROM audit_epochs ORDER BY start_rowid ASC`).all();
  if (epochs.length === 0) {
    return { ok: false, total: rows.length, error: "AUDIT_EPOCH_MISSING" };
  }

  for (const [index, epoch] of epochs.entries()) {
    const expectedAttestation = computeAuditEpochAttestation({
      id: epoch.id,
      startRowid: epoch.start_rowid,
      hashVersion: epoch.hash_version,
      previousEpochId: epoch.previous_epoch_id,
      previousTailHash: epoch.previous_tail_hash,
      reason: epoch.reason,
      createdAt: epoch.created_at,
    });
    if (epoch.attestation_hash !== expectedAttestation || !AUDIT_HASH_VERSIONS.has(epoch.hash_version)) {
      return {
        ok: false,
        total: rows.length,
        error: "AUDIT_EPOCH_ATTESTATION_INVALID",
        broken_epoch: epoch.id,
      };
    }
    if (index === 0) {
      if (epoch.previous_epoch_id != null || epoch.previous_tail_hash != null) {
        return {
          ok: false,
          total: rows.length,
          error: "AUDIT_EPOCH_ROOT_INVALID",
          broken_epoch: epoch.id,
        };
      }
      continue;
    }
    const previousEpoch = epochs[index - 1];
    const priorRow = db.prepare(
      `SELECT entry_hash FROM audit_logs WHERE rowid < ? ORDER BY rowid DESC LIMIT 1`
    ).get(epoch.start_rowid);
    if (
      epoch.previous_epoch_id !== previousEpoch.id
      || epoch.previous_tail_hash !== (priorRow?.entry_hash || null)
    ) {
      return {
        ok: false,
        total: rows.length,
        error: "AUDIT_EPOCH_BRIDGE_INVALID",
        broken_epoch: epoch.id,
        expected_previous_epoch_id: previousEpoch.id,
        actual_previous_epoch_id: epoch.previous_epoch_id,
        expected_previous_tail_hash: priorRow?.entry_hash || null,
        actual_previous_tail_hash: epoch.previous_tail_hash,
      };
    }
  }

  let prevHash = null;
  let epochIndex = 0;
  for (const row of rows) {
    while (
      epochIndex + 1 < epochs.length
      && Number(epochs[epochIndex + 1].start_rowid) <= Number(row.rowid)
    ) {
      epochIndex += 1;
    }
    const epoch = epochs[epochIndex];
    if (!epoch || Number(row.rowid) < Number(epoch.start_rowid)) {
      return {
        ok: false,
        total: rows.length,
        error: "AUDIT_ROW_WITHOUT_EPOCH",
        broken_at: row.id,
      };
    }
    if (epoch.hash_version === AUDIT_HASH_VERSION_EPOCH_V3 && row.audit_epoch !== epoch.id) {
      return {
        ok: false,
        total: rows.length,
        error: "AUDIT_ROW_EPOCH_MISMATCH",
        broken_at: row.id,
        expected_epoch: epoch.id,
        actual_epoch: row.audit_epoch,
      };
    }
    const expected = computeAuditEntryHash(
      prevHash,
      auditEntryDataFromRow(row, "audit_chain_verify"),
      epoch.hash_version,
    );
    if (row.prev_hash !== prevHash || row.entry_hash !== expected) {
      return {
        ok: false,
        total: rows.length,
        error: "AUDIT_HASH_CHAIN_INVALID",
        broken_at: row.id,
        broken_epoch: epoch.id,
        expected_prev_hash: prevHash,
        actual_prev_hash: row.prev_hash,
        expected_entry_hash: expected,
        actual_entry_hash: row.entry_hash
      };
    }
    prevHash = row.entry_hash;
  }

  const attributions = db.prepare(
    `SELECT attribution.*, audit.entry_hash
     FROM audit_log_store_attributions attribution
     JOIN audit_logs audit ON audit.id = attribution.audit_log_id
     ORDER BY audit.rowid ASC`
  ).all();
  for (const attribution of attributions) {
    const expected = computeAuditStoreAttributionAttestation({
      auditLogId: attribution.audit_log_id,
      storeId: attribution.store_id,
      method: attribution.attribution_method,
      sourceEntryHash: attribution.source_entry_hash,
      attributedAt: attribution.attributed_at,
    });
    if (
      attribution.attestation_hash !== expected
      || attribution.source_entry_hash !== attribution.entry_hash
    ) {
      return {
        ok: false,
        total: rows.length,
        error: "AUDIT_STORE_ATTRIBUTION_INVALID",
        broken_at: attribution.audit_log_id,
      };
    }
  }

  return {
    ok: true,
    total: rows.length,
    tail_hash: prevHash,
    epoch_count: epochs.length,
    attribution_count: attributions.length,
    epochs: epochs.map((epoch) => ({
      id: epoch.id,
      start_rowid: epoch.start_rowid,
      hash_version: epoch.hash_version,
      previous_epoch_id: epoch.previous_epoch_id,
      previous_tail_hash: epoch.previous_tail_hash,
      attestation_hash: epoch.attestation_hash,
    })),
  };
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

  let outcome;
  try {
    const execute = db.transaction(() => {
      const concurrentExisting = db
        .prepare(
          `SELECT status_code, response_json, request_hash
           FROM idempotency_records
           WHERE actor_id = ? AND endpoint = ? AND idempotency_key = ? AND expires_at > ?`
        )
        .get(actorId, endpoint, key, nowIso());
      if (concurrentExisting) {
        return {
          kind: concurrentExisting.request_hash === requestHash ? "replay" : "conflict",
          existing: concurrentExisting,
        };
      }

      const result = logicFn() || {};
      const statusCode = result.status ?? 200;
      const responseBody = result.body ?? {};
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SEC * 1000).toISOString();
      db.prepare(
        `INSERT INTO idempotency_records
        (id, actor_id, endpoint, idempotency_key, request_hash, status_code, response_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), actorId, endpoint, key, requestHash, statusCode, JSON.stringify(responseBody), createdAt, expiresAt);
      return { kind: "created", statusCode, responseBody };
    });
    outcome = execute.immediate();
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

  if (outcome.kind === "conflict") {
    return jsonError(res, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key already used with different payload");
  }
  if (outcome.kind === "replay") {
    const parsedResponse = parseJsonWithWarning(outcome.existing.response_json, "idempotency.concurrent_response_json", null);
    if (!parsedResponse || typeof parsedResponse !== "object") {
      return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error");
    }
    return res.status(outcome.existing.status_code).json(parsedResponse);
  }
  return res.status(outcome.statusCode).json(outcome.responseBody);
}

const IDEMPOTENCY_PENDING_STATUS_CODE = 0;
const IDEMPOTENCY_PENDING_RESPONSE_JSON = JSON.stringify({ _idempotency_state: "pending" });

function finalizeAsyncIdempotencyClaim(claimId, statusCode, responseBody) {
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SEC * 1000).toISOString();
  const responseJson = JSON.stringify(responseBody);
  const updated = db.prepare(
    `UPDATE idempotency_records
     SET status_code = ?, response_json = ?, expires_at = ?
     WHERE id = ? AND status_code = ? AND response_json = ?`
  ).run(
    statusCode,
    responseJson,
    expiresAt,
    claimId,
    IDEMPOTENCY_PENDING_STATUS_CODE,
    IDEMPOTENCY_PENDING_RESPONSE_JSON
  );
  if (updated.changes !== 1) {
    const error = new Error("Async idempotency claim could not be finalized");
    error.code = "IDEMPOTENCY_CLAIM_FINALIZE_FAILED";
    throw error;
  }
}

async function idempotentAsync(req, res, endpoint, actorId, logicFn) {
  const key = req.header("Idempotency-Key");
  if (!key) {
    return jsonError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
  }

  cleanupIdempotencyRecords();
  const requestHash = hashJson(req.body);
  let claim;
  try {
    const executeClaim = db.transaction(() => {
      const existing = db
        .prepare(
          `SELECT id, status_code, response_json, request_hash
           FROM idempotency_records
           WHERE actor_id = ? AND endpoint = ? AND idempotency_key = ? AND expires_at > ?`
        )
        .get(actorId, endpoint, key, nowIso());
      if (existing) return { kind: "existing", record: existing };

      const claimId = uuid();
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SEC * 1000).toISOString();
      db.prepare(
        `INSERT INTO idempotency_records
        (id, actor_id, endpoint, idempotency_key, request_hash, status_code, response_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        claimId,
        actorId,
        endpoint,
        key,
        requestHash,
        IDEMPOTENCY_PENDING_STATUS_CODE,
        IDEMPOTENCY_PENDING_RESPONSE_JSON,
        createdAt,
        expiresAt
      );
      return { kind: "claimed", claimId };
    });
    claim = executeClaim.immediate();
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: nowIso(),
        level: "error",
        type: "idempotency_async.claim_failed",
        endpoint,
        request_id: requestIdFromReq(req),
        actor_id: actorId,
        message: String(error.message || error),
      })
    );
    return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error");
  }

  if (claim.kind === "existing") {
    const existing = claim.record;
    if (existing.request_hash !== requestHash) {
      return jsonError(res, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key already used with different payload");
    }
    if (
      existing.status_code === IDEMPOTENCY_PENDING_STATUS_CODE
      && existing.response_json === IDEMPOTENCY_PENDING_RESPONSE_JSON
    ) {
      res.setHeader("retry-after", "1");
      return jsonError(res, 409, "IDEMPOTENCY_IN_PROGRESS", "A request with this idempotency key is still in progress", {
        retryable: true,
      });
    }
    const parsedResponse = parseJsonWithWarning(existing.response_json, "idempotency_async.response_json", null);
    if (!parsedResponse || typeof parsedResponse !== "object") {
      return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error");
    }
    return res.status(existing.status_code).json(parsedResponse);
  }

  let result;
  try {
    result = (await logicFn()) || {};
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
    const responseBody = { error: { code: "INTERNAL_ERROR", message: "Unexpected server error", details: {} } };
    try {
      finalizeAsyncIdempotencyClaim(claim.claimId, 500, responseBody);
    } catch (finalizeError) {
      console.error(
        JSON.stringify({
          ts: nowIso(),
          level: "error",
          type: "idempotency_async.finalize_failed",
          endpoint,
          request_id: requestIdFromReq(req),
          actor_id: actorId,
          message: String(finalizeError.message || finalizeError),
        })
      );
    }
    return res.status(500).json(responseBody);
  }

  const statusCode = result.status ?? 200;
  const responseBody = result.body ?? {};
  try {
    finalizeAsyncIdempotencyClaim(claim.claimId, statusCode, responseBody);
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: nowIso(),
        level: "error",
        type: "idempotency_async.finalize_failed",
        endpoint,
        request_id: requestIdFromReq(req),
        actor_id: actorId,
        message: String(error.message || error),
      })
    );
    return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error");
  }

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
  if (!raw || !/^-?\d+$/.test(raw)) return 0n;
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

const REVIEW_DISPOSITIONS = new Set([
  "accepted_as_paid",
  "cancelled_no_sale",
  "refunded",
  "written_off",
  "escalated",
]);

function normalizeReviewDisposition(value, fallback = null) {
  const raw = String(value || "").trim().toLowerCase();
  return REVIEW_DISPOSITIONS.has(raw) ? raw : fallback;
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

function findRefundRequests(invoiceId) {
  return db
    .prepare(`SELECT * FROM refund_requests WHERE invoice_id = ? ORDER BY created_at ASC, id ASC`)
    .all(invoiceId);
}

function buildSettlementRefundSummary(refunds) {
  const references = (Array.isArray(refunds) ? refunds : []).map((refund) => {
    const amount = parseRefundAmountBaseStrict(refund);
    return {
      refund_id: refund.id,
      refund_case_id: refund.refund_case_id || null,
      review_case_id: refund.review_case_id || null,
      funding_lineage_id: refund.funding_lineage_id || null,
      status: String(refund.status || ""),
      refund_amount_jpyc_base: Number(amount),
      refund_tx_hash: refund.refund_tx_hash || null,
      refund_tx_log_index: refund.refund_tx_log_index ?? null,
      verified_at: refund.verified_at || null,
      audit_log_refs: refundAuditLogRefs(refund.id).map((row) => row.id),
    };
  });
  const requestedAmount = references.reduce((sum, row) => sum + BigInt(String(row.refund_amount_jpyc_base || 0)), 0n);
  const reservedAmount = references.reduce((sum, row) => {
    if (REFUND_RESERVATION_RELEASED_STATUSES.has(row.status)) return sum;
    return sum + BigInt(String(row.refund_amount_jpyc_base || 0));
  }, 0n);
  const succeededAmount = references.reduce((sum, row) => {
    if (!["succeeded", "verified"].includes(row.status) || !row.refund_tx_hash) return sum;
    return sum + BigInt(String(row.refund_amount_jpyc_base || 0));
  }, 0n);
  return {
    refund_reference_status: "complete",
    refund_reference_count: references.length,
    refund_requested_amount_jpyc_base: Number(requestedAmount),
    refund_reserved_amount_jpyc_base: Number(reservedAmount),
    refund_succeeded_amount_jpyc_base: Number(succeededAmount),
    refund_references: references,
  };
}

function emptySettlementRefundSummary(referenceStatus) {
  return {
    refund_reference_status: referenceStatus,
    refund_reference_count: 0,
    refund_requested_amount_jpyc_base: 0,
    refund_reserved_amount_jpyc_base: 0,
    refund_succeeded_amount_jpyc_base: 0,
    refund_references: [],
  };
}

function compareSettlementPaymentSessions(left, right) {
  const railRank = (session) => String(session?.rail_type || "") === PAYMENT_RAIL_TYPES.WALLET_DIRECT ? 0 : 1;
  const rankDifference = railRank(left) - railRank(right);
  if (rankDifference !== 0) return rankDifference;
  for (const field of ["provider_code", "id"]) {
    const leftValue = String(left?.[field] || "");
    const rightValue = String(right?.[field] || "");
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function buildSettlementRefundTotals(refundManifest) {
  const totals = (Array.isArray(refundManifest) ? refundManifest : []).reduce(
    (result, entry) => ({
      invoiceCount: result.invoiceCount + 1,
      referenceCount: result.referenceCount + BigInt(String(entry.refund_reference_count || 0)),
      requested: result.requested + BigInt(String(entry.refund_requested_amount_jpyc_base || 0)),
      reserved: result.reserved + BigInt(String(entry.refund_reserved_amount_jpyc_base || 0)),
      succeeded: result.succeeded + BigInt(String(entry.refund_succeeded_amount_jpyc_base || 0)),
    }),
    { invoiceCount: 0, referenceCount: 0n, requested: 0n, reserved: 0n, succeeded: 0n }
  );
  for (const value of [totals.referenceCount, totals.requested, totals.reserved, totals.succeeded]) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw refundLedgerIntegrityError("aggregate");
  }
  return {
    invoice_count: totals.invoiceCount,
    refund_reference_count: Number(totals.referenceCount),
    refund_requested_amount_jpyc_base: Number(totals.requested),
    refund_reserved_amount_jpyc_base: Number(totals.reserved),
    refund_succeeded_amount_jpyc_base: Number(totals.succeeded),
  };
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

function buildSettlementExportBaseInvoices(storeId, range, businessDate) {
  return db
    .prepare(
      `SELECT i.*
       FROM invoices i
       WHERE i.store_id = ?
         AND (
           i.created_at BETWEEN ? AND ?
           OR EXISTS (
             SELECT 1 FROM refund_requests rr
             WHERE rr.invoice_id = i.id
               AND rr.status NOT IN ('cancelled', 'rejected')
               AND COALESCE(rr.verified_at, rr.updated_at, rr.created_at) BETWEEN ? AND ?
           )
           OR EXISTS (
             SELECT 1 FROM accounting_event_journal aej
             WHERE aej.invoice_id = i.id
               AND aej.store_id = i.store_id
               AND aej.business_date = ?
           )
         )
       ORDER BY i.created_at ASC`
    )
    .all(storeId, range.fromUtc, range.toUtc, range.fromUtc, range.toUtc, businessDate);
}

function findLatestProviderAllocationForPayment(providerPaymentId, invoiceId = null) {
  if (!providerPaymentId) return null;
  if (invoiceId) {
    return db
      .prepare(
        `SELECT psa.*, ps.provider_settlement_id AS external_provider_settlement_id, ps.batch_reference, ps.settlement_status
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
      `SELECT psa.*, ps.provider_settlement_id AS external_provider_settlement_id, ps.batch_reference, ps.settlement_status
       FROM provider_settlement_allocations psa
       JOIN provider_settlements ps ON ps.id = psa.provider_settlement_id
       WHERE psa.provider_payment_id = ?
       ORDER BY psa.updated_at DESC, psa.created_at DESC
       LIMIT 1`
    )
    .get(providerPaymentId) || null;
}

function shouldIncludeSettlementSnapshotRow({ invoice, paymentSession, providerSession, hasRefunds }) {
  if (hasRefunds) return true;
  if (providerSession || String(paymentSession?.rail_type) === PAYMENT_RAIL_TYPES.PROVIDER_EXTERNAL) return true;
  return ["paid", "review_required", "cancelled"].includes(String(invoice.status));
}

function hasCleanProviderAllocation(providerAllocation, invoiceId) {
  if (!providerAllocation) return false;
  if (String(providerAllocation.allocation_status || "") !== "matched") return false;
  return String(providerAllocation.invoice_id || "") === String(invoiceId || "");
}

function settlementPaymentAttemptIds(invoiceId) {
  return db
    .prepare(`SELECT id FROM payment_attempts WHERE invoice_id = ? ORDER BY created_at ASC, id ASC`)
    .all(invoiceId)
    .map((row) => row.id);
}

function settlementAuditRefs(invoiceId, relatedIds = []) {
  const targetIds = [...new Set([invoiceId, ...relatedIds].filter(Boolean))];
  if (targetIds.length === 0) return [];
  return db
    .prepare(
      `SELECT id FROM audit_logs
       WHERE target_id IN (${targetIds.map(() => "?").join(",")})
       ORDER BY created_at ASC, id ASC
       LIMIT 100`
    )
    .all(...targetIds)
    .map((row) => row.id);
}

function settlementAccountingEventRefs(invoiceId, businessDate) {
  return db
    .prepare(
      `SELECT id FROM accounting_event_journal
       WHERE invoice_id = ? AND business_date = ?
       ORDER BY occurred_at ASC, id ASC`
    )
    .all(invoiceId, businessDate)
    .map((row) => row.id);
}

function settlementPrimaryPaymentEvent(invoice) {
  if (!invoice?.paid_tx_hash) return null;
  return db
    .prepare(
      `SELECT log_index, block_timestamp, detected_at
       FROM payment_events
       WHERE invoice_id = ? AND tx_hash = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`
    )
    .get(invoice.id, invoice.paid_tx_hash) || null;
}

function buildSettlementExportRow({
  invoice,
  paymentSession,
  providerSession,
  providerAllocation,
  review,
  refundSummary,
  refundAttribution,
  hasRefunds,
  exportRunId,
  businessDate,
  createdAt,
}) {
  if (!shouldIncludeSettlementSnapshotRow({ invoice, paymentSession, providerSession, hasRefunds })) return null;
  const invoiceAmountBase = toIntegerAmount(invoice.amount_jpyc_base, 0);
  const paidAmountBase = toIntegerAmount(invoice.paid_amount_jpyc_base, 0);
  const providerAmountBase = toIntegerAmount(providerSession?.provider_amount_jpyc_base, invoiceAmountBase);
  const allocationAmountBase = toIntegerAmount(providerAllocation?.allocated_amount_jpyc_base, providerAmountBase);

  let accountingStatus = "cancelled";
  let cashRecognitionStatus = "none";
  let receivableStatus = "none";
  let onchainCashAmount = 0;
  let providerReceivableAmount = 0;
  let exceptionAmount = 0;
  let voidAmount = 0;
  let refundAmount = 0;

  if (refundSummary.refund_succeeded_amount_jpyc_base > 0) {
    accountingStatus = "refunded_onchain";
    cashRecognitionStatus = "none";
    refundAmount = refundSummary.refund_succeeded_amount_jpyc_base;
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
  const primaryEvent = settlementPrimaryPaymentEvent(invoice);
  const primaryRefund = refundSummary.refund_references.find((refund) =>
    ["succeeded", "verified"].includes(String(refund.status)) && refund.refund_tx_hash
  ) || refundSummary.refund_references[0] || null;
  const auditLogRefs = settlementAuditRefs(invoice.id, [
    exportRunId,
    review?.id,
    primaryRefund?.refund_id,
    primaryRefund?.refund_case_id,
  ]);
  const externalSyncRefs = [...new Set([providerPaymentRef, providerSettlementRef].filter(Boolean))];
  const accountingEventRefs = settlementAccountingEventRefs(invoice.id, businessDate);
  const evidenceHash = hashProviderEvidence({
    invoice_id: invoice.id,
    payment_session_id: paymentSession?.id || null,
    provider_payment_ref: providerPaymentRef,
    provider_settlement_ref: providerSettlementRef,
    onchain_transfer_ref: onchainTransferRef,
    invoice_status: invoice.status,
    review_status: review?.status || null,
    refund_references: refundSummary.refund_references,
    refund_attribution: refundAttribution,
    accounting_status: accountingStatus,
  });

  const rowId = uuid();
  return {
    id: rowId,
    export_reference: `settlement-export-run:${exportRunId}`,
    settlement_id: invoice.settlement_id || null,
    settlement_export_run_id: exportRunId,
    settlement_export_row_id: rowId,
    export_run_id: exportRunId,
    export_version: "v2",
    business_date: businessDate,
    store_id: invoice.store_id || null,
    terminal_id: invoice.terminal_id || null,
    operator_id: invoice.operator_id || invoice.staff_user_id || null,
    invoice_id: invoice.id,
    invoice_no: invoice.invoice_no || null,
    checkout_session_id: invoice.checkout_session_id || null,
    payment_session_id: paymentSession?.id || null,
    rail_type: paymentSession?.rail_type || PAYMENT_RAIL_TYPES.WALLET_DIRECT,
    provider_code: paymentSession?.provider_code || PROVIDER_CODES.SELF_WALLET,
    chain_id: String(invoice.chain_id || ""),
    network: getNetworkLabel(invoice.chain_id),
    token_contract: invoice.token_contract || null,
    recipient_address: invoice.recipient_address || null,
    payment_attempt_ids: paymentAttemptIds,
    primary_tx_hash: invoice.paid_tx_hash || null,
    primary_tx_log_index: primaryEvent?.log_index ?? null,
    review_case_id: review?.id || null,
    review_reason_type: review?.reason_type || null,
    review_status: review?.status || null,
    refund_request_id: primaryRefund?.refund_id || null,
    refund_tx_hash: primaryRefund?.refund_tx_hash || null,
    audit_log_refs: auditLogRefs,
    external_sync_refs: externalSyncRefs,
    accounting_event_refs: accountingEventRefs,
    invoice_amount_jpyc_base: invoiceAmountBase,
    invoice_status: String(invoice.status),
    accounting_status: accountingStatus,
    cash_recognition_status: cashRecognitionStatus,
    receivable_status: receivableStatus,
    onchain_cash_amount_jpyc_base: onchainCashAmount,
    provider_receivable_amount_jpyc_base: providerReceivableAmount,
    exception_amount_jpyc_base: exceptionAmount,
    refund_amount_jpyc_base: refundAmount,
    refund_attribution: refundAttribution,
    ...refundSummary,
    void_amount_jpyc_base: voidAmount,
    provider_payment_ref: providerPaymentRef,
    provider_settlement_ref: providerSettlementRef,
    onchain_transfer_ref: onchainTransferRef,
    source_ledger_snapshot_hash: evidenceHash,
    evidence_hash: evidenceHash,
    payload_schema_version: SETTLEMENT_EXPORT_CONTRACT_V2,
    export_excluded_private_data: 1,
    created_at: createdAt,
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
     VALUES (?, 'v2', ?, ?, ?, 'created', ?, ?, ?)`
  ).run(runId, businessDate, store.id, terminalId || null, createdAt, actorId || null, createdAt);

  audit({
    actorType: actorId ? "admin" : "system",
    actorId: actorId || "system",
    action: "settlement_export_run_created",
    targetType: "settlement_export",
    targetId: runId,
    requestId,
    idempotencyKey,
    afterState: {
      business_date: businessDate,
      contract_version: SETTLEMENT_EXPORT_CONTRACT_V2,
      export_version: "v2",
      store_id: store.id,
    },
    ip,
  });

  const invoices = buildSettlementExportBaseInvoices(store.id, range, businessDate);
  const rows = [];
  const refundManifest = [];
  for (const invoice of invoices) {
    const review = findLatestReviewCase(invoice.id);
    const refunds = findRefundRequests(invoice.id);
    const hasRefunds = refunds.length > 0;
    const invoiceRefundSummary = buildSettlementRefundSummary(refunds);
    const sessions = [...getPaymentSessionsForInvoice(invoice)].sort(compareSettlementPaymentSessions);
    let primaryRow = null;
    for (const [sessionIndex, paymentSession] of sessions.entries()) {
      const providerSession = paymentSession.id
        ? db.prepare(`SELECT * FROM provider_payment_sessions WHERE payment_session_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(paymentSession.id) || null
        : null;
      const providerAllocation = providerSession
        ? findLatestProviderAllocationForPayment(providerSession.provider_payment_id, invoice.id)
        : null;
      const isRefundPrimary = hasRefunds && sessionIndex === 0;
      const refundAttribution = isRefundPrimary
        ? "invoice_primary"
        : (hasRefunds ? "invoice_manifest_only" : "none");
      const rowRefundSummary = isRefundPrimary
        ? invoiceRefundSummary
        : emptySettlementRefundSummary(hasRefunds ? "invoice_manifest_only" : "none");
      const row = buildSettlementExportRow({
        invoice,
        paymentSession,
        providerSession,
        providerAllocation,
        review,
        refundSummary: rowRefundSummary,
        refundAttribution,
        hasRefunds,
        exportRunId: runId,
        businessDate,
        createdAt,
      });
      if (!row) continue;
      rows.push(row);
      if (isRefundPrimary) primaryRow = row;
    }
    if (hasRefunds && primaryRow) {
      refundManifest.push({
        invoice_id: invoice.id,
        primary_export_row_id: primaryRow.id,
        primary_payment_session_id: primaryRow.payment_session_id || null,
        attribution: "invoice_primary_row",
        ...invoiceRefundSummary,
      });
    }
  }

  rows.sort(compareSettlementExportV2Rows);
  refundManifest.sort((left, right) => {
    const leftValue = String(left.invoice_id || "");
    const rightValue = String(right.invoice_id || "");
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  });
  for (const row of rows) {
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
      JSON.stringify(row),
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
    refundManifest,
    refundTotals: buildSettlementRefundTotals(refundManifest),
  };
}

function persistSettlementExportArtifact({
  settlementId = null,
  businessDate,
  format,
  store,
  actorId,
  range,
  snapshot,
}) {
  const exportId = uuid();
  const generatedAt = nowIso();
  const outputPath = `api://settlement-exports/${exportId}.${format}`;
  const metadata = {
    export_run_id: snapshot.exportRunId,
    contract_version: SETTLEMENT_EXPORT_CONTRACT_V2,
    export_version: "v2",
    export_scope: "daily",
    totals: buildDailyAccountingSummary(snapshot.rows),
    timezone: store.timezone || "Asia/Tokyo",
    period_start_utc: range.fromUtc,
    period_end_utc: range.toUtc,
    row_count: snapshot.rows.length,
    hash_scope: {
      version: SETTLEMENT_EXPORT_V2_CANONICAL_HASH_SCOPE,
      json: "SHA-256 of UTF-8 JSON.stringify(Settlement Export v2 canonical payload), excluding content_hash/content_hashes and internal storage annotations",
      csv: "SHA-256 of UTF-8 BOM CSV download bytes",
    },
    _row_annotations: buildSettlementExportV2RowAnnotations(snapshot.rows),
    _refund_manifest: snapshot.refundManifest,
    _refund_totals: snapshot.refundTotals,
  };
  const exportRowForPayload = {
    id: exportId,
    business_date: businessDate,
    format,
    generated_at: generatedAt,
    output_path: outputPath,
  };
  const decoratedRows = applySettlementExportV2RowAnnotations(snapshot.rows, metadata);
  const jsonPayload = buildSettlementExportV2SnapshotJsonPayload({
    exportRow: exportRowForPayload,
    metadata,
    rows: decoratedRows,
  });
  const jsonDownload = JSON.stringify(jsonPayload);
  const csvDownload = buildSettlementExportV2SnapshotCsv(decoratedRows, { bom: true });
  metadata.content_hashes = {
    json: sha256(jsonDownload),
    csv: sha256(csvDownload),
  };
  metadata.content_hash = metadata.content_hashes[format];
  db.prepare(
    `INSERT INTO settlement_exports
     (id, merchant_id, store_id, settlement_id, business_date, format, output_path, generated_by, generated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    exportId,
    store.merchant_id || "merchant-001",
    store.id,
    settlementId || null,
    businessDate,
    format,
    outputPath,
    actorId,
    generatedAt,
    JSON.stringify(metadata)
  );
  return {
    exportId,
    exportRunId: snapshot.exportRunId,
    generatedAt,
    outputPath,
    metadata,
    rows: decoratedRows,
  };
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
      recordAccountingEvent({
        storeId: invoice.store_id,
        invoiceId: invoice.id,
        eventType: "void_adjustment",
        occurredAt: providerEvent.occurred_at,
        amountBase: String(providerEvent.amount_jpyc_base || providerPaymentSession.provider_amount_jpyc_base || invoice.amount_jpyc_base || "0"),
        status: "recorded",
        sourceRef: `provider_event:${providerEvent.provider_event_id}:void`,
        payload: {
          provider_event_id: providerEvent.provider_event_id,
          provider_payment_id: providerPaymentSession.provider_payment_id,
          provider_status: providerPaymentSession.provider_status,
        },
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
    if (existing?.payload_hash && existing.payload_hash !== payloadHash) {
      const conflictStoreId = db
        .prepare(
          `SELECT i.store_id
           FROM provider_settlement_allocations psa
           JOIN invoices i ON i.id = psa.invoice_id
           WHERE psa.provider_settlement_id = ?
           ORDER BY psa.rowid ASC LIMIT 1`
        )
        .get(existing.id)?.store_id || null;
      db.prepare(`UPDATE provider_settlements SET settlement_status = 'disputed', updated_at = ? WHERE id = ?`).run(
        nowIso(),
        existing.id,
      );
      audit({
        storeId: conflictStoreId,
        actorType: "service",
        actorId,
        action: "provider_settlement_payload_conflict",
        targetType: "provider_settlement",
        targetId: internalSettlementId,
        requestId,
        idempotencyKey,
        afterState: {
          store_id: conflictStoreId,
          provider_code: settlementInput.provider_code,
          provider_settlement_id: settlementInput.provider_settlement_id,
          existing_payload_hash: existing.payload_hash,
          incoming_payload_hash: payloadHash,
          disputed: true,
        },
        ip,
      });
      return {
        status: 409,
        body: {
          error: {
            code: "PROVIDER_SETTLEMENT_PAYLOAD_CONFLICT",
            message: "provider settlement payload conflicts with the already recorded settlement",
          },
        },
      };
    }
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
    const seenAllocationIdentities = new Set();
    let disputed = false;
    for (const allocation of settlementInput.allocations) {
      allocationTotal += BigInt(String(allocation.allocated_amount_jpyc_base));
      const allocationIdentity = String(allocation.provider_payment_id);
      const duplicateWithinPayload = seenAllocationIdentities.has(allocationIdentity);
      seenAllocationIdentities.add(allocationIdentity);
      if (duplicateWithinPayload) disputed = true;
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
      const existingAllocation = db
        .prepare(
          `SELECT * FROM provider_settlement_allocations
           WHERE provider_settlement_id = ? AND provider_payment_id = ?
           ORDER BY rowid ASC LIMIT 1`
        )
        .get(internalSettlementId, allocation.provider_payment_id);
      if (existingAllocation) {
        const sameInvoice = String(existingAllocation.invoice_id || "") === String(matchedInvoiceId || "");
        const sameAmount = String(existingAllocation.allocated_amount_jpyc_base) === String(allocation.allocated_amount_jpyc_base);
        const sameStatus = String(existingAllocation.allocation_status) === String(allocationStatus);
        if (!sameInvoice || !sameAmount || !sameStatus || duplicateWithinPayload) disputed = true;
        continue;
      }
      const allocationInOtherSettlement = db
        .prepare(
          `SELECT psa.id, psa.provider_settlement_id, i.store_id
           FROM provider_settlement_allocations psa
           LEFT JOIN invoices i ON i.id = psa.invoice_id
           WHERE psa.provider_payment_id = ? AND psa.provider_settlement_id <> ?
           ORDER BY psa.rowid ASC LIMIT 1`
        )
        .get(allocation.provider_payment_id, internalSettlementId);
      if (allocationInOtherSettlement) {
        disputed = true;
        if (allocation.invoice_id) affectedInvoices.add(String(allocation.invoice_id));
        continue;
      }
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

function qualifyStoredPaymentEvents(invoice) {
  const rows = db
    .prepare(
      `SELECT * FROM payment_events
       WHERE invoice_id = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(invoice.id);
  const events = rows.map((row) => {
    const rawPayload = parseJsonWithWarning(row.raw_payload, `payment_event.raw_payload:${row.id}`, {});
    const nonExactTokenConversion = rawPayload?.amount_conversion_exact === false
      || String(rawPayload?.amount_conversion_error || "").trim() === "non_exact_decimal_conversion";
    return {
      ...row,
      amount_jpyc_base: String(row.amount_jpyc_base ?? "0"),
      amount_conversion_exact: !nonExactTokenConversion,
      amount_conversion_error: nonExactTokenConversion ? "non_exact_decimal_conversion" : null,
      // Missing canonicality is not proof of finality.  Legacy rows remain
      // auditable, but qualification must fail closed until the chain worker
      // supplies an explicit canonical status.
      canonical_status: row.canonical_status || "unknown",
      block_timestamp: row.block_timestamp || row.observed_at || null,
    };
  });
  const decision = decideQualifiedPaymentStatus(invoice, events, {
    integrityHold: Number(invoice.integrity_hold || 0) === 1,
    qualificationOptions: (event) => ({
      canonicalStatus: event.canonical_status || "unknown",
      blockTimestamp: event.block_timestamp || event.observed_at || null,
    }),
  });
  for (const item of decision.qualifications || []) {
    const qualification = item.qualification;
    const recognitionStatus = item.event.amount_conversion_exact === false
      ? "review_required"
      : qualification.eligible
      ? "eligible"
      : qualification.reasonLabel === "awaiting_confirmations"
        ? "pending"
        : "review_required";
    db.prepare(
      `UPDATE payment_events
       SET chain_verified = ?, token_verified = ?, recipient_verified = ?,
           canonical_status = ?, within_expiry = ?, recognition_status = ?
       WHERE id = ?`
    ).run(
      qualification.checks.chainMatches ? 1 : 0,
      qualification.checks.tokenMatches ? 1 : 0,
      qualification.checks.recipientMatches ? 1 : 0,
      qualification.canonicalStatus,
      qualification.checks.withinExpiry ? 1 : 0,
      recognitionStatus,
      item.event.id,
    );
  }
  const eligibleRows = (decision.qualifications || [])
    .filter((item) => item.qualification.eligible && item.event.amount_conversion_exact !== false)
    .map((item) => item.event);
  const totalPaidBase = eligibleRows
    .reduce((total, row) => total + BigInt(String(row.amount_jpyc_base || "0")), 0n)
    .toString();
  const earliestBlockTimestamp = eligibleRows
    .map((row) => String(row.block_timestamp || row.observed_at || "").trim())
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] || null;
  return { ...decision, events, totalPaidBase, earliestBlockTimestamp };
}

function postPaymentMonitorUntil() {
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
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
  const nonExactTokenConversion = event.amount_conversion_exact === false
    || String(event.amount_conversion_error || "").trim() === "non_exact_decimal_conversion";
  const forcedChainInconsistencyReason = String(event.chain_inconsistency_reason || "").trim() === "multiple_matching_transfers"
    ? "multiple_matching_transfers"
    : null;
  const integrityHoldReason = forcedChainInconsistencyReason
    || (nonExactTokenConversion ? "non_exact_decimal_conversion" : null);
  const parsedAmountBaseResult = event.amount_jpyc_base != null
    ? (nonExactTokenConversion && /^\d+$/.test(String(event.amount_jpyc_base).trim())
      ? { value: String(event.amount_jpyc_base).trim() }
      : parsePositiveBaseUnitInteger(String(event.amount_jpyc_base), "amount_jpyc_base"))
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
  const eventObservedAt = String(event.observed_at || nowIso());
  const eventBlockTimestamp = String(event.block_timestamp || eventObservedAt);
  const eventCanonicalStatus = String(event.canonical_status || "unknown");
  const eventAmountAtomic = event.amount_atomic == null ? null : String(event.amount_atomic);
  const decision = db.transaction(() => {
    const peId = uuid();
    const paymentAttemptId = uuid();
    try {
      db.prepare(
        `INSERT INTO payment_events
        (id, invoice_id, event_type, chain_id, tx_hash, log_index, block_number, confirmations, from_address, to_address,
         token_contract, amount_jpyc, amount_jpyc_base, amount_atomic, chain_verified, token_verified, recipient_verified,
         canonical_status, within_expiry, recognition_status, reorg_id, observed_at, block_hash, block_timestamp, detected_at,
         raw_payload, created_at)
        VALUES (?, ?, 'tx_detected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 'pending', NULL, ?, ?, ?, ?, ?, ?)`
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
          eventAmountAtomic,
          eventCanonicalStatus,
          eventObservedAt,
          event.block_hash ? String(event.block_hash) : null,
          eventBlockTimestamp,
          String(event.detected_at || nowIso()),
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
        const existingEvent = db
          .prepare(
            `SELECT * FROM payment_events
             WHERE invoice_id = ? AND tx_hash = ? AND COALESCE(log_index, -1) = COALESCE(?, -1)
             ORDER BY created_at ASC, id ASC
             LIMIT 1`
          )
          .get(invoice.id, String(event.tx_hash), event.log_index ?? null);
        if (existingEvent) {
          const previousInvoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
          const nextConfirmations = Math.max(Number(existingEvent.confirmations || 0), parsedConfirmations);
          const nextBlockHash = existingEvent.block_hash || event.block_hash || null;
          const nextBlockTimestamp = existingEvent.block_timestamp || event.block_timestamp || eventObservedAt;
          const nextDetectedAt = event.detected_at || existingEvent.detected_at || nowIso();
          const confirmationEvidenceAdvanced = nextConfirmations > Number(existingEvent.confirmations || 0);
          const blockHashEvidenceAdded = !existingEvent.block_hash && Boolean(event.block_hash);
          const blockTimestampEvidenceAdded = !existingEvent.block_timestamp && Boolean(event.block_timestamp);
          db.prepare(
            `UPDATE payment_events
             SET confirmations = ?,
                 block_hash = COALESCE(block_hash, ?),
                 block_timestamp = COALESCE(block_timestamp, ?),
                 amount_atomic = COALESCE(amount_atomic, ?),
                 canonical_status = COALESCE(?, canonical_status, 'unknown'),
                 detected_at = ?,
                 raw_payload = ?
             WHERE id = ?`
          ).run(
            nextConfirmations,
            nextBlockHash,
            nextBlockTimestamp,
            eventAmountAtomic,
            eventCanonicalStatus,
            nextDetectedAt,
            JSON.stringify(event),
            existingEvent.id
          );
          const qualified = qualifyStoredPaymentEvents(previousInvoice);
          const totalPaidBase = BigInt(qualified.totalPaidBase || "0");
          const earliestBlockTimestamp = qualified.earliestBlockTimestamp || nextBlockTimestamp;
          const outcome = {
            nextStatus: qualified.nextStatus,
            reasonType: qualified.reasonType,
            reasonLabel: qualified.reasonLabel,
          };
          if (nonExactTokenConversion) {
            outcome.nextStatus = "review_required";
            outcome.reasonType = REVIEW_REASON_CODES.CHAIN_INCONSISTENT;
            outcome.reasonLabel = "non_exact_decimal_conversion";
            db.prepare(`UPDATE payment_events SET recognition_status = 'review_required' WHERE id = ?`).run(existingEvent.id);
          }
          if (forcedChainInconsistencyReason) {
            outcome.nextStatus = "review_required";
            outcome.reasonType = REVIEW_REASON_CODES.CHAIN_INCONSISTENT;
            outcome.reasonLabel = forcedChainInconsistencyReason;
            db.prepare(`UPDATE payment_events SET recognition_status = 'review_required' WHERE id = ?`).run(existingEvent.id);
          }
          if (String(previousInvoice.status) === "cancelled") {
            outcome.nextStatus = "review_required";
            outcome.reasonType = REVIEW_REASON_CODES.LATE_PAYMENT;
            outcome.reasonLabel = "payment_after_cancelled_invoice";
          }
          if (isPaymentsDisabled() && outcome.nextStatus === "paid") {
            outcome.nextStatus = "review_required";
            outcome.reasonType = "payments_disabled";
            outcome.reasonLabel = "payments_disabled";
          }
          const update = transitionInvoiceForPayment(previousInvoice, outcome.nextStatus, outcome.reasonLabel, {
            actorType,
            actorId,
            requestId,
            idempotencyKey,
            ip,
            reason: outcome.reasonLabel || "payment_confirmation_update",
          });
          if (update.error) {
            return {
              status: 409,
              body: { error: { code: "INVALID_STATE_TRANSITION", message: "Invalid transition during payment confirmation update", details: update } },
            };
          }
          const refreshed = update.invoice || db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
          const totalPaidDisplay = Number(formatJpyc(totalPaidBase.toString()));
          db.prepare(`UPDATE invoices
                      SET paid_amount_jpyc = ?, paid_amount_jpyc_base = ?, paid_tx_hash = COALESCE(paid_tx_hash, ?),
                          integrity_hold = CASE WHEN ? IS NOT NULL THEN 1 ELSE integrity_hold END,
                          integrity_hold_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE integrity_hold_reason END,
                          integrity_hold_at = CASE WHEN ? IS NOT NULL THEN COALESCE(integrity_hold_at, ?) ELSE integrity_hold_at END,
                          monitor_until = CASE WHEN ? = 'paid' THEN COALESCE(monitor_until, ?) ELSE monitor_until END,
                          updated_at = ? WHERE id = ?`).run(
            Number.isFinite(totalPaidDisplay) ? totalPaidDisplay : 0,
            totalPaidBase.toString(),
            event.tx_hash,
            integrityHoldReason,
            integrityHoldReason,
            integrityHoldReason,
            integrityHoldReason,
            nowIso(),
            outcome.nextStatus,
            postPaymentMonitorUntil(),
            nowIso(),
            invoice.id
          );
          if (outcome.nextStatus === "paid") {
            recordAccountingEvent({
              storeId: refreshed.store_id,
              invoiceId: refreshed.id,
              eventType: "payment_confirmed",
              occurredAt: earliestBlockTimestamp || nextDetectedAt || nowIso(),
              amountBase: totalPaidBase.toString(),
              status: "confirmed",
              sourceRef: `payment_event:${existingEvent.id}`,
              payload: {
                payment_event_id: existingEvent.id,
                tx_hash: event.tx_hash,
                log_index: event.log_index ?? null,
                cumulative_amount_jpyc_base: totalPaidBase.toString(),
              },
            });
          }
          const after = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
          audit({
            storeId: invoice.store_id,
            actorType,
            actorId,
            action: "payment.confirmations_updated",
            targetType: "payment_event",
            targetId: existingEvent.id,
            requestId,
            idempotencyKey,
            beforeState: { payment_event: existingEvent, invoice: previousInvoice },
            afterState: { payment_event: db.prepare(`SELECT * FROM payment_events WHERE id = ?`).get(existingEvent.id), invoice: after },
            ip,
          });
          return {
            status: 200,
            body: {
              duplicate: true,
              invoice_id: after.id,
              decision: confirmationEvidenceAdvanced || blockHashEvidenceAdded || blockTimestampEvidenceAdded ? outcome.nextStatus : "ignored_duplicate",
              status: after.status,
              review_required: after.status === "review_required",
              tx_hash: event.tx_hash,
              payment_attempt_id: null,
              event_id: existingEvent.id,
            },
          };
        }
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

    const qualified = qualifyStoredPaymentEvents(invoice);
    const totalPaidBase = BigInt(qualified.totalPaidBase || "0");
    const earliestBlockTimestamp = qualified.earliestBlockTimestamp || eventBlockTimestamp;
    const outcome = {
      nextStatus: qualified.nextStatus,
      reasonType: qualified.reasonType,
      reasonLabel: qualified.reasonLabel,
    };
    if (nonExactTokenConversion) {
      outcome.nextStatus = "review_required";
      outcome.reasonType = REVIEW_REASON_CODES.CHAIN_INCONSISTENT;
      outcome.reasonLabel = "non_exact_decimal_conversion";
      db.prepare(`UPDATE payment_events SET recognition_status = 'review_required' WHERE id = ?`).run(peId);
    }
    if (forcedChainInconsistencyReason) {
      outcome.nextStatus = "review_required";
      outcome.reasonType = REVIEW_REASON_CODES.CHAIN_INCONSISTENT;
      outcome.reasonLabel = forcedChainInconsistencyReason;
      db.prepare(`UPDATE payment_events SET recognition_status = 'review_required' WHERE id = ?`).run(peId);
    }
    if (String(invoice.status) === "cancelled") {
      outcome.nextStatus = "review_required";
      outcome.reasonType = REVIEW_REASON_CODES.LATE_PAYMENT;
      outcome.reasonLabel = "payment_after_cancelled_invoice";
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
        blockTimestamp: event.block_timestamp || event.observed_at || nowIso(),
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

    const totalPaidDisplay = Number(formatJpyc(totalPaidBase.toString()));
    db.prepare(`UPDATE invoices
                SET paid_amount_jpyc = ?, paid_amount_jpyc_base = ?, paid_tx_hash = ?,
                    integrity_hold = CASE WHEN ? IS NOT NULL THEN 1 ELSE integrity_hold END,
                    integrity_hold_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE integrity_hold_reason END,
                    integrity_hold_at = CASE WHEN ? IS NOT NULL THEN COALESCE(integrity_hold_at, ?) ELSE integrity_hold_at END,
                    monitor_until = CASE WHEN ? = 'paid' THEN COALESCE(monitor_until, ?) ELSE monitor_until END,
                    updated_at = ? WHERE id = ?`).run(
      Number.isFinite(totalPaidDisplay) ? totalPaidDisplay : 0,
      totalPaidBase.toString(),
      event.tx_hash,
      integrityHoldReason,
      integrityHoldReason,
      integrityHoldReason,
      integrityHoldReason,
      nowIso(),
      outcome.nextStatus,
      postPaymentMonitorUntil(),
      nowIso(),
      invoice.id
    );
    if (outcome.nextStatus === "paid") {
      const openReview = db
        .prepare(`SELECT * FROM review_cases WHERE invoice_id = ? AND status IN ('open', 'in_progress')`)
        .get(invoice.id);
      if (openReview) {
        const reviewTs = nowIso();
        db.prepare(
          `UPDATE review_cases
           SET status = 'resolved',
               resolution_status = 'settled',
               disposition = 'accepted_as_paid',
               resolution_note = COALESCE(resolution_note, 'payment_total_confirmed'),
               resolved_at = ?,
               updated_at = ?
           WHERE id = ?`
        ).run(reviewTs, reviewTs, openReview.id);
        audit({
          storeId: invoice.store_id,
          actorType: "system",
          actorId: "chain-monitor",
          action: "review.auto_resolved_as_paid",
          targetType: "review",
          targetId: openReview.id,
          requestId,
          idempotencyKey,
          beforeState: openReview,
          afterState: db.prepare(`SELECT * FROM review_cases WHERE id = ?`).get(openReview.id),
          ip,
        });
      }
    }
    const refreshed = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
    if (outcome.nextStatus === "paid") {
      recordAccountingEvent({
        storeId: refreshed.store_id,
        invoiceId: refreshed.id,
        eventType: "payment_confirmed",
        occurredAt: earliestBlockTimestamp || event.detected_at || event.observed_at || nowIso(),
        amountBase: totalPaidBase.toString(),
        status: "confirmed",
        sourceRef: `payment_event:${peId}`,
        payload: {
          payment_event_id: peId,
          payment_attempt_id: paymentAttemptId,
          tx_hash: event.tx_hash,
          log_index: event.log_index ?? null,
          cumulative_amount_jpyc_base: totalPaidBase.toString(),
        },
      });
    }
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
  const blockHash = payload?.block_hash == null || String(payload.block_hash).trim() === ""
    ? null
    : parseTxHash(payload.block_hash);
  const amount = payload?.amount_jpyc;
  const nonExactConversion = payload?.amount_conversion_exact === false
    || String(payload?.amount_conversion_error || "").trim() === "non_exact_decimal_conversion";
  const amountBaseParsed = payload?.amount_jpyc_base != null
    ? (nonExactConversion
      ? (/^\d+$/.test(String(payload.amount_jpyc_base).trim())
        ? { value: String(payload.amount_jpyc_base).trim() }
        : { error: "amount_jpyc_base is invalid" })
      : parsePositiveBaseUnitInteger(payload.amount_jpyc_base, "amount_jpyc_base"))
    : toBaseUnits(amount);
  const confirmations = Number(payload?.confirmations || 0);
  if (!payload?.invoice_id || !txHash || !payload?.chain_id || !payload?.token_contract || !payload?.to_address) {
    return { error: "Missing required fields for ingest" };
  }
  if (payload?.block_hash != null && !blockHash) return { error: "block_hash must be a 0x-prefixed 32-byte hash" };
  if (amountBaseParsed.error) return { error: "amount_jpyc is invalid" };
  if (BigInt(amountBaseParsed.value) <= 0n && !nonExactConversion) return { error: "amount_jpyc must be > 0" };
  if (nonExactConversion && !/^\d+$/.test(String(payload?.amount_atomic || ""))) {
    return { error: "amount_atomic is required for non-exact token conversion" };
  }
  if (!Number.isFinite(confirmations) || confirmations < 0) {
    return { error: "confirmations must be >= 0" };
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
      amount_atomic: payload.amount_atomic == null ? null : String(payload.amount_atomic),
      amount_conversion_exact: nonExactConversion ? false : true,
      amount_conversion_error: nonExactConversion ? String(payload.amount_conversion_error || "non_exact_decimal_conversion") : null,
      canonical_status: payload.canonical_status || "unknown",
      observed_at: payload.observed_at || nowIso(),
      block_hash: blockHash,
      block_timestamp: payload.block_timestamp || null,
      block_hash: payload.block_hash || null,
      detected_at: payload.detected_at || nowIso(),
    }
  };
}

async function buildVerifiedManualIngestEvent(invoice, payload) {
  const invoiceChainId = String(invoice.chain_id || CHAIN_ID);
  const invoiceTokenContract = String(invoice.token_contract || APPROVED_TOKEN_CONTRACT);
  if ((rpcProvidersByChain.get(invoiceChainId) || []).length === 0) {
    return { error: { code: "RPC_UNAVAILABLE", message: "manual ingest verification requires RPC_URLS" } };
  }
  const expectedAmount = convertLedgerBaseToTokenAtomicExact(String(invoice.amount_jpyc_base || "0"));
  if (expectedAmount.error) {
    return {
      error: {
        code: "AMOUNT_SCALE_INCOMPATIBLE",
        message: "invoice amount cannot be represented exactly in token atomic units",
      },
    };
  }
  const verification = await verifyTransferOnChain({
    txHash: payload?.tx_hash,
    chainId: invoiceChainId,
    expectedTokenContract: invoiceTokenContract,
    expectedToAddress: invoice.recipient_address,
    expectedAmountAtomic: expectedAmount.value,
  });

  if (!verification.ok) {
    if (verification.code === "MULTIPLE_TRANSFERS" && verification.transfer) {
      if (verification.confirmations < REQUIRED_CONFIRMATIONS) {
        return {
          pending: true,
          error: {
            code: "CONFIRMATIONS_PENDING",
            message: `transaction has ${verification.confirmations} confirmations; ${REQUIRED_CONFIRMATIONS} required`,
          },
        };
      }
      const matchingTransfers = Array.isArray(verification.transfers) ? verification.transfers : [verification.transfer];
      const totalAmountAtomic = matchingTransfers
        .reduce((total, transfer) => total + BigInt(String(transfer.amountBase)), 0n)
        .toString();
      const observedAmount = convertTokenAtomicToLedgerBase(totalAmountAtomic);
      if (observedAmount.error) {
        return {
          error: {
            code: "AMOUNT_SCALE_INCOMPATIBLE",
            message: "on-chain token amount cannot be converted to ledger base units",
          },
        };
      }
      return {
        event: {
          invoice_id: invoice.id,
          chain_id: invoiceChainId,
          tx_hash: parseTxHash(payload?.tx_hash),
          log_index: verification.transfer.logIndex,
          block_number: verification.transfer.blockNumber,
          confirmations: verification.confirmations,
          from_address: verification.transfer.from,
          to_address: verification.transfer.to,
          token_contract: invoiceTokenContract,
          amount_jpyc: formatJpyc(observedAmount.value),
          amount_jpyc_base: observedAmount.value,
          amount_atomic: totalAmountAtomic,
          amount_conversion_exact: observedAmount.exact,
          amount_conversion_error: observedAmount.exact ? null : "non_exact_decimal_conversion",
          chain_inconsistency_reason: "multiple_matching_transfers",
          matching_transfers: matchingTransfers,
          canonical_status: verification.canonicalStatus || "unknown",
          observed_at: verification.observedAt,
          block_hash: verification.receipt?.blockHash || null,
          block_timestamp: verification.observedAt,
          source: "manual_ingest",
          verified_onchain: true,
        },
      };
    }
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
      const observedAmount = convertTokenAtomicToLedgerBase(verification.transfer.amountBase);
      if (observedAmount.error) {
        return {
          error: {
            code: "AMOUNT_SCALE_INCOMPATIBLE",
            message: "on-chain token amount cannot be converted to ledger base units",
          },
        };
      }
      return {
        event: {
          invoice_id: invoice.id,
          chain_id: invoiceChainId,
          tx_hash: parseTxHash(payload?.tx_hash),
          log_index: verification.transfer.logIndex,
          block_number: verification.transfer.blockNumber,
          confirmations: verification.confirmations,
          from_address: verification.transfer.from,
          to_address: verification.transfer.to,
          token_contract: invoiceTokenContract,
          amount_jpyc: formatJpyc(observedAmount.value),
          amount_jpyc_base: observedAmount.value,
          amount_atomic: verification.transfer.amountBase,
          amount_conversion_exact: observedAmount.exact,
          amount_conversion_error: observedAmount.exact ? null : "non_exact_decimal_conversion",
          canonical_status: verification.canonicalStatus || "unknown",
          observed_at: verification.observedAt,
          block_hash: verification.receipt?.blockHash || null,
          block_timestamp: verification.observedAt,
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

  const observedAmount = convertTokenAtomicToLedgerBase(verification.transfer.amountBase);
  if (observedAmount.error) {
    return {
      error: {
        code: "AMOUNT_SCALE_INCOMPATIBLE",
        message: "on-chain token amount cannot be converted to ledger base units",
      },
    };
  }

  return {
    event: {
      invoice_id: invoice.id,
      chain_id: invoiceChainId,
      tx_hash: parseTxHash(payload?.tx_hash),
      log_index: verification.transfer.logIndex,
      block_number: verification.transfer.blockNumber,
      confirmations: verification.confirmations,
      from_address: verification.transfer.from,
      to_address: verification.transfer.to,
      token_contract: invoiceTokenContract,
      amount_jpyc: formatJpyc(observedAmount.value),
      amount_jpyc_base: observedAmount.value,
      amount_atomic: verification.transfer.amountBase,
      amount_conversion_exact: observedAmount.exact,
      amount_conversion_error: observedAmount.exact ? null : "non_exact_decimal_conversion",
      canonical_status: verification.canonicalStatus || "unknown",
      observed_at: verification.observedAt,
      block_hash: verification.receipt?.blockHash || null,
      block_timestamp: verification.observedAt,
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

  // A normal paid invoice is refundable independently of an exception review.
  // Exception-specific rules below remain authoritative for review_required cases.
  if (["paid", "refunded"].includes(String(invoice?.invoice_status || invoice?.status || "").toLowerCase())) {
    return paidBase.toString();
  }

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
  const treasury = getRefundTreasuryConfig({ storeId: refund.store_id || db.prepare(`SELECT store_id FROM invoices WHERE id = ?`).get(refund.invoice_id)?.store_id, chainId: refund.refund_chain_id });
  const hasLineage = hasVerifiedRefundFundingLineage(refund);
  if (isProductionLikeRuntime() && (!treasury || !hasLineage)) {
    return {
      error: {
        code: "REFUND_FUNDING_LINEAGE_REQUIRED",
        message: "production refund verification requires an approved store/chain treasury and verified sweep lineage",
      },
    };
  }
  const expectedFromAddresses = isProductionLikeRuntime()
    ? [treasury?.address]
    : [refund.expected_from_address, hasLineage ? treasury?.address : null];
  const expectedAmount = convertLedgerBaseToTokenAtomicExact(refund.refund_amount_jpyc_base);
  if (expectedAmount.error) {
    return {
      error: {
        code: "AMOUNT_SCALE_INCOMPATIBLE",
        message: "refund amount cannot be represented exactly in token atomic units",
      },
    };
  }
  const verification = await verifyTransferOnChain({
    txHash,
    chainId: String(refund.refund_chain_id || CHAIN_ID),
    expectedTokenContract: String(refund.token_contract || APPROVED_TOKEN_CONTRACT),
    expectedToAddress: refund.refund_to_address,
    expectedFromAddress: null,
    expectedFromAddresses: expectedFromAddresses.filter(Boolean),
    expectedAmountAtomic: expectedAmount.value,
  });
  if (verification.ok && verification.canonicalStatus !== "canonical") {
    return {
      status: "verification_failed",
      refundTxHash: txHash,
      refundTxLogIndex: verification.transfer?.logIndex ?? null,
      failureReason: "NON_CANONICAL",
      fromAddress: verification.transfer?.from || null,
      toAddress: verification.transfer?.to || refund.refund_to_address || null,
      chainId: String(refund.refund_chain_id || CHAIN_ID),
      tokenContract: String(refund.token_contract || APPROVED_TOKEN_CONTRACT || TOKEN_CONTRACT || ""),
      blockNumber: verification.transfer?.blockNumber ?? null,
      blockTimestamp: verification.observedAt || nowIso(),
      detectedAt: nowIso(),
    };
  }
  if (!verification.ok) {
    if (["WRONG_AMOUNT", "WRONG_FROM_ADDRESS", "WRONG_RECIPIENT", "MULTIPLE_TRANSFERS"].includes(verification.code)) {
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
        blockTimestamp: verification.observedAt || nowIso(),
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
        blockTimestamp: verification.observedAt || nowIso(),
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
      blockTimestamp: verification.observedAt || nowIso(),
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
    blockTimestamp: verification.observedAt || nowIso(),
    detectedAt: nowIso(),
  };
}

async function verifyRefundFundingLineageOnChain(refund, lineage) {
  const tokenContract = String(
    refund.token_contract
      || refund.invoice_token_contract
      || APPROVED_TOKEN_CONTRACT
      || TOKEN_CONTRACT
      || ""
  );
  try {
    const expectedAmount = convertLedgerBaseToTokenAtomicExact(lineage.sweep_amount_jpyc_base);
    if (expectedAmount.error) {
      return {
        status: "verification_failed",
        failureReason: "AMOUNT_SCALE_INCOMPATIBLE",
        evidence: {
          code: "AMOUNT_SCALE_INCOMPATIBLE",
          message: "sweep amount cannot be represented exactly in token atomic units",
        },
      };
    }
    const verification = await verifyTransferOnChain({
      txHash: lineage.sweep_tx_hash,
      chainId: String(lineage.chain_id),
      expectedTokenContract: tokenContract,
      expectedToAddress: lineage.treasury_address,
      expectedFromAddress: lineage.source_address,
      expectedAmountAtomic: expectedAmount.value,
    });
    if (!verification.ok) {
      const permanentFailureCodes = new Set([
        "WRONG_TOKEN",
        "WRONG_RECIPIENT",
        "WRONG_FROM_ADDRESS",
        "WRONG_AMOUNT",
        "MULTIPLE_TRANSFERS",
        "TX_REVERTED",
        "WRONG_CHAIN",
      ]);
      if (permanentFailureCodes.has(String(verification.code || ""))) {
        return {
          status: "verification_failed",
          failureReason: verification.code,
          evidence: {
            code: verification.code,
            message: verification.message || null,
            confirmations: Number(verification.confirmations || 0),
            observed_at: verification.observedAt || null,
            transfer: verification.transfer || null,
          },
        };
      }
      return {
        status: "pending_verification",
        failureReason: verification.code || "RPC_VERIFICATION_PENDING",
        evidence: {
          code: verification.code || "RPC_VERIFICATION_PENDING",
          message: verification.message || null,
          confirmations: Number(verification.confirmations || 0),
          observed_at: verification.observedAt || null,
        },
      };
    }

    if (verification.canonicalStatus !== "canonical") {
      return {
        status: "verification_failed",
        failureReason: "NON_CANONICAL",
        evidence: {
          code: "NON_CANONICAL",
          confirmations: Number(verification.confirmations || 0),
          observed_at: verification.observedAt || null,
          canonical_status: verification.canonicalStatus || "unknown",
          transfer: verification.transfer || null,
        },
      };
    }

    if (Number(verification.confirmations || 0) < REQUIRED_CONFIRMATIONS) {
      return {
        status: "pending_verification",
        failureReason: `confirmations_pending:${Number(verification.confirmations || 0)}/${REQUIRED_CONFIRMATIONS}`,
        evidence: {
          code: "CONFIRMATIONS_PENDING",
          confirmations: Number(verification.confirmations || 0),
          required_confirmations: REQUIRED_CONFIRMATIONS,
          observed_at: verification.observedAt || null,
          canonical_status: verification.canonicalStatus || "unknown",
          transfer: verification.transfer || null,
        },
      };
    }

    return {
      status: "verified",
      failureReason: null,
      evidence: {
        code: "VERIFIED",
        confirmations: Number(verification.confirmations || 0),
        required_confirmations: REQUIRED_CONFIRMATIONS,
        observed_at: verification.observedAt || null,
        canonical_status: verification.canonicalStatus || "unknown",
        transfer: verification.transfer || null,
      },
    };
  } catch (error) {
    return {
      status: "pending_verification",
      failureReason: "RPC_UNAVAILABLE",
      evidence: {
        code: "RPC_UNAVAILABLE",
        message: String(error.message || error).slice(0, 240),
      },
    };
  }
}

async function verifyRefundFundingSweepsV2(refund, sweeps, actorId, auditContext = null) {
  const results = await Promise.all(
    sweeps.map(async (sweep) => ({
      sweep,
      verification: String(sweep.status) === "verified"
        ? { status: "verified", evidence: { code: "ALREADY_VERIFIED" } }
        : await verifyRefundFundingLineageOnChain(refund, sweep),
    }))
  );
  const requestedAmount = parseBaseUnitOrZero(refund.refund_amount_jpyc_base);
  const timestamp = nowIso();
  try {
    const finalizeVerification = db.transaction(() => {
      const currentRefund = db
        .prepare(
          `SELECT rr.*, i.store_id
           FROM refund_requests rr
           JOIN invoices i ON i.id = rr.invoice_id
           WHERE rr.id = ?`
        )
        .get(refund.id);
      if (!currentRefund) {
        const error = new Error("refund request changed while funding verification was in progress");
        error.code = "REFUND_FUNDING_LINEAGE_CONFLICT";
        throw error;
      }
      const beforeSweeps = getRefundFundingSweeps(currentRefund.id);
      const beforeConservation = evaluateRefundFundingConservation(
        currentRefund,
        beforeSweeps,
        getRefundFundingAllocationsForConservation(currentRefund.id, beforeSweeps)
      );

      for (const { sweep, verification } of results) {
        const currentSweep = db.prepare(`SELECT * FROM refund_funding_sweeps WHERE id = ?`).get(sweep.id);
        if (!currentSweep) {
          const error = new Error("funding sweep changed while verification was in progress");
          error.code = "REFUND_FUNDING_SWEEP_CONFLICT";
          error.details = { sweep_id: sweep.id };
          throw error;
        }
        if (String(currentSweep.status) === "verified") continue;
        if (String(currentSweep.status) !== String(sweep.status)
          || String(currentSweep.updated_at || "") !== String(sweep.updated_at || "")) {
          const error = new Error("funding sweep changed while verification was in progress");
          error.code = "REFUND_FUNDING_SWEEP_CONFLICT";
          error.details = { sweep_id: sweep.id, current_status: currentSweep.status };
          throw error;
        }
        const existingEvidence = parseJsonWithWarning(
          currentSweep.evidence_json,
          "refund_funding_sweeps.verify.evidence",
          {}
        );
        const evidence = {
          ...(existingEvidence && typeof existingEvidence === "object" ? existingEvidence : {}),
          verification: verification.evidence || {},
          failure_reason: verification.failureReason || null,
        };
        const updated = db.prepare(
          `UPDATE refund_funding_sweeps
           SET status = ?, evidence_json = ?, updated_at = ?
           WHERE id = ? AND status = ? AND updated_at = ?`
        ).run(
          verification.status,
          JSON.stringify(sanitizeAuditState(evidence)),
          timestamp,
          currentSweep.id,
          currentSweep.status,
          currentSweep.updated_at
        );
        if (updated.changes !== 1) {
          const error = new Error("funding sweep changed while verification was in progress");
          error.code = "REFUND_FUNDING_SWEEP_CONFLICT";
          error.details = { sweep_id: sweep.id };
          throw error;
        }
      }

      const freshSweeps = getRefundFundingSweeps(refund.id);
      const existingAllocations = getRefundFundingAllocationsForConservation(refund.id, freshSweeps);
      const initialConservation = evaluateRefundFundingConservation(
        currentRefund,
        freshSweeps,
        existingAllocations
      );
      if (!initialConservation.conserved) {
        const violation = initialConservation.snapshot.violations[0] || {};
        const error = new Error(violation.message || "refund funding conservation check failed");
        error.code = violation.code || "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR";
        error.details = violation;
        throw error;
      }
      let allocatedTotal = initialConservation.refundAllocated;
      const allocationsBySweep = new Map(initialConservation.totalsBySweep);
      const refundSweepPairs = new Set(
        existingAllocations
          .filter((allocation) => String(allocation.refund_request_id) === String(refund.id))
          .map((allocation) => String(allocation.sweep_id))
      );
      for (const sweep of freshSweeps) {
        if (allocatedTotal >= requestedAmount || String(sweep.status) !== "verified") continue;
        if (refundSweepPairs.has(String(sweep.id))) continue;
        const sweepAmount = parseBaseUnitOrZero(sweep.sweep_amount_jpyc_base);
        const available = sweepAmount - (allocationsBySweep.get(String(sweep.id)) || 0n);
        const amount = available < requestedAmount - allocatedTotal ? available : requestedAmount - allocatedTotal;
        if (amount <= 0n) continue;
        const idempotencyKey = `refund-funding-v2:${refund.id}:${sweep.id}`;
        const allocationPlan = planRefundFundingAllocation({
          sweep: { id: sweep.id, status: "verified", verified_amount_jpyc_base: sweepAmount.toString() },
          existingAllocations,
          request: {
            sweep_id: sweep.id,
            refund_request_id: refund.id,
            amount_jpyc_base: amount.toString(),
            refund_amount_jpyc_base: requestedAmount.toString(),
            idempotency_key: idempotencyKey,
          },
        });
        if (!allocationPlan.ok) {
          const error = new Error(allocationPlan.error?.message || "refund funding allocation was rejected");
          error.code = allocationPlan.error?.code || "REFUND_FUNDING_ALLOCATION_REJECTED";
          error.details = allocationPlan.error?.details || {};
          throw error;
        }
        if (allocationPlan.decision === "create") {
          const allocationId = uuid();
          db.prepare(
            `INSERT INTO refund_funding_allocation_parts
             (id, funding_sweep_id, refund_request_id, amount_jpyc_base, idempotency_key, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(allocationId, sweep.id, refund.id, amount.toString(), idempotencyKey, actorId, timestamp);
          existingAllocations.push({
            id: allocationId,
            sweep_id: sweep.id,
            refund_request_id: refund.id,
            amount_jpyc_base: amount.toString(),
            idempotency_key: idempotencyKey,
            created_by: actorId,
            created_at: timestamp,
          });
          allocationsBySweep.set(
            String(sweep.id),
            (allocationsBySweep.get(String(sweep.id)) || 0n) + amount
          );
          refundSweepPairs.add(String(sweep.id));
          allocatedTotal += amount;
        }
      }

      const finalSweeps = getRefundFundingSweeps(refund.id);
      const finalConservation = evaluateRefundFundingConservation(
        currentRefund,
        finalSweeps,
        getRefundFundingAllocationsForConservation(refund.id, finalSweeps)
      );
      if (!finalConservation.conserved) {
        const violation = finalConservation.snapshot.violations[0] || {};
        const error = new Error(violation.message || "refund funding conservation check failed");
        error.code = violation.code || "REFUND_FUNDING_ALLOCATION_INTEGRITY_ERROR";
        error.details = violation;
        throw error;
      }
      if (!finalConservation.fullyFunded) {
        const errorDetails = {
          refund_amount_jpyc_base: requestedAmount.toString(),
          allocated_amount_jpyc_base: finalConservation.refundAllocated.toString(),
          verification_results: results.map(({ sweep, verification }) => ({
            sweep_id: sweep.id,
            status: verification.status,
            failure_reason: verification.failureReason || null,
          })),
        };
        // Keep failed/pending sweep evidence and any valid partial allocation
        // durable.  Rolling back here would make a raw-atomic mismatch look
        // as if it had never been observed, weakening the refund audit trail
        // and forcing the operator to resubmit the same evidence blindly.
        const afterRefund = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
        const beforeState = buildRefundFundingAuditState(currentRefund, beforeConservation);
        const afterState = buildRefundFundingAuditState(afterRefund, finalConservation);
        if (auditContext) {
          audit({
            storeId: currentRefund.store_id,
            actorType: "admin",
            actorId,
            action: "refund.funding_sweeps_verification_incomplete",
            targetType: "refund",
            targetId: refund.id,
            requestId: auditContext.requestId,
            idempotencyKey: auditContext.idempotencyKey,
            beforeState,
            afterState: {
              ...afterState,
              verification_results: errorDetails.verification_results,
            },
            ip: auditContext.ip,
          });
        }
        return {
          incomplete: true,
          afterRefund,
          beforeState,
          afterState,
          error: {
            code: "REFUND_FUNDING_UNDERALLOCATED",
            message: "verified funding sweeps do not fully fund the requested refund",
            details: errorDetails,
          },
        };
      }

      const afterRefund = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
      const beforeState = buildRefundFundingAuditState(currentRefund, beforeConservation);
      const afterState = buildRefundFundingAuditState(afterRefund, finalConservation);
      if (auditContext) {
        audit({
          storeId: currentRefund.store_id,
          actorType: "admin",
          actorId,
          action: "refund.funding_sweeps_verified",
          targetType: "refund",
          targetId: refund.id,
          requestId: auditContext.requestId,
          idempotencyKey: auditContext.idempotencyKey,
          beforeState,
          afterState,
          ip: auditContext.ip,
        });
      }
      return { afterRefund, beforeState, afterState };
    });
    const finalized = finalizeVerification.immediate();
    if (finalized?.incomplete) {
      const error = new Error(finalized.error?.message || "refund funding verification is incomplete");
      error.code = finalized.error?.code || "REFUND_FUNDING_UNDERALLOCATED";
      error.details = finalized.error?.details || {};
      return { ok: false, results, error, finalized };
    }
    return { ok: true, results, ...finalized };
  } catch (error) {
    return { ok: false, results, error };
  }
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
      (id, merchant_id, name, status, timezone, admin_contact, invoice_ttl_sec, chain_id, token_contract, settlement_unresolved_review_policy,
       refund_treasury_address, refund_treasury_chain_id, refund_treasury_approval_ref, created_at, updated_at)
      VALUES ('store-001', 'merchant-001', 'JPYC Store Alpha', 'active', 'Asia/Tokyo', '+81-3-1234-5678', 300, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      CHAIN_ID,
      TOKEN_CONTRACT,
      resolveSettlementUnresolvedReviewPolicy(null),
      isEvmAddress(REFUND_TREASURY_ADDRESS) ? normalizeAddress(REFUND_TREASURY_ADDRESS) : null,
      CHAIN_ID,
      REFUND_TREASURY_APPROVAL_REF || null,
      now,
      now,
    );
  } else {
    db.prepare(
      `UPDATE stores
       SET merchant_id = 'merchant-001',
           token_contract = ?,
           chain_id = ?,
           settlement_unresolved_review_policy = COALESCE(settlement_unresolved_review_policy, ?),
           refund_treasury_address = COALESCE(refund_treasury_address, ?),
           refund_treasury_chain_id = COALESCE(refund_treasury_chain_id, ?),
           refund_treasury_approval_ref = COALESCE(refund_treasury_approval_ref, ?),
           updated_at = ?
       WHERE id = 'store-001'`
    ).run(
      TOKEN_CONTRACT,
      CHAIN_ID,
      resolveSettlementUnresolvedReviewPolicy(null),
      isEvmAddress(REFUND_TREASURY_ADDRESS) ? normalizeAddress(REFUND_TREASURY_ADDRESS) : null,
      CHAIN_ID,
      REFUND_TREASURY_APPROVAL_REF || null,
      now,
    );
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
      .prepare(
        `SELECT COUNT(*) AS count,
                MIN(block_timestamp) AS earliest_block_timestamp,
                MIN(observed_at) AS earliest_observed_at
         FROM payment_events
         WHERE invoice_id = ?`
      )
      .get(invoice.id);
    const hasPaymentEvidence = invoice.status !== "issued" || Number(paymentEvidence?.count || 0) > 0 || !!invoice.paid_tx_hash;
    const expiresMs = new Date(invoice.expires_at).getTime();
    const earliestCanonicalMs = new Date(String(paymentEvidence?.earliest_block_timestamp || "")).getTime();
    if (
      hasPaymentEvidence
      && Number.isFinite(expiresMs)
      && Number.isFinite(earliestCanonicalMs)
      && earliestCanonicalMs <= expiresMs
      && ["payment_detected", "confirming"].includes(String(invoice.status))
    ) {
      // The send was mined before expiry. Keep waiting for finality even when
      // the monitor observed it after the customer-facing payment window.
      continue;
    }
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
        blockTimestamp: paymentEvidence?.earliest_block_timestamp || paymentEvidence?.earliest_observed_at || now,
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
app.set("trust proxy", EXPRESS_TRUST_PROXY);

const securityDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", "data:"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  // 開発用LAN HTTP確認では相対リソースまでHTTPS化するとSafariの実機確認が成立しない。
  // 公開HTTPSの本番環境では昇格を維持し、混在コンテンツを防ぐ。
  upgradeInsecureRequests: IS_PRODUCTION ? [] : null,
};

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: securityDirectives,
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

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

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
  const publicEntryToken = String(req.params.publicEntryToken || "").trim();
  const terminal = getTerminalByPublicEntryToken(publicEntryToken);
  if (!terminal) {
    return jsonError(res, 404, "NOT_FOUND", "Terminal entry not found");
  }
  return res.redirect(`/terminal-entry.html?token=${encodeURIComponent(publicEntryToken)}`);
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
  const unmatchedCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_unmatched_events WHERE chain_id = ?`).get(CHAIN_ID).count;
  const deadLetterCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE chain_id = ?`).get(CHAIN_ID).count;
  const deadLetterPendingCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE chain_id = ? AND status = 'pending'`).get(CHAIN_ID).count;
  const deadLetterAbandonedCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE chain_id = ? AND status = 'abandoned'`).get(CHAIN_ID).count;
  const rpcFailoverCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_rpc_failovers WHERE chain_id = ?`).get(CHAIN_ID).count;
  const unresolvedReorgCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_reorgs WHERE chain_id = ? AND status = 'unresolved'`).get(CHAIN_ID).count;
  const addressPoolAvailableCount = db.prepare(`SELECT COUNT(*) AS count FROM receive_addresses WHERE status = 'available'`).get().count;
  const issuedInvoiceCount = db.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE status = 'issued'`).get().count;
  const expiredInvoiceCount = db.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE status = 'expired'`).get().count;
  const manualReviewCount = db.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE status = 'review_required'`).get().count;
  const workerLastCycle = db.prepare(`SELECT value, updated_at FROM chain_monitor_state WHERE key = ?`).get(`worker:${CHAIN_ID}:last_cycle_at`);
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
    unresolved_reorg_count: unresolvedReorgCount,
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
    policy_urls_gate: commercial.policy_urls_gate,
    wallet_evidence_gate: commercial.wallet_evidence_gate,
    real_payment_evidence_gate: commercial.real_payment_evidence_gate,
    tls_evidence_gate: commercial.tls_evidence_gate,
    store_ops_drill_gate: commercial.store_ops_drill_gate,
    poc_package_gate: commercial.poc_package_gate,
    audit_chain_gate: commercial.audit_chain_gate,
    settlement_policy_gate: commercial.settlement_policy_gate,
    refund_policy_gate: commercial.refund_policy_gate,
    dangerous_flags_gate: commercial.dangerous_flags_gate,
    chain_reorg_gate: commercial.chain_reorg_gate,
    commercial_verdict: commercial.commercial_verdict,
    blockers: commercial.blockers,
    checks: metrics,
    policy_urls: commercial.policy_urls,
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
  const matchingStaff = candidateRows.filter((row) => verifyPin(String(staffPin), row.pin_hash));
  if (matchingStaff.length !== 1) {
    if (matchingStaff.length === 0) registerPinFailure(terminalCode);
    return jsonError(res, 401, "UNAUTHORIZED", "Invalid staff credentials");
  }
  const staff = matchingStaff[0];
  clearPinFailures(terminalCode);
  if (!staff.pin_hash.startsWith("$2")) {
    db.prepare(`UPDATE staff_users SET pin_hash = ?, updated_at = ? WHERE id = ?`).run(hashPin(staffPin), nowIso(), staff.id);
  }

  const rawToken = `${uuid()}-${uuid()}`;
  const tokenHash = sha256(rawToken);
  const sid = uuid();
  const ts = nowIso();
  const expiresAt = new Date(new Date(ts).getTime() + SESSION_TTL_SEC * 1000).toISOString();
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
    staff_name: staff.staff_name,
    role: staff.role,
    effective_permissions: [...getPermissionsForSession(staff)].sort(),
    ...publicEntry,
    current_invoice: summarizeInvoiceForTerminalState(currentInvoiceContext.currentInvoice),
    terminal_invariant_broken: currentInvoiceContext.invariantBroken === true,
    payments: getPaymentsDisableState({ storeId: terminal.store_id, terminalId: terminal.id }),
    supported_wallets: getSupportedWallets(ENV),
    started_at: ts,
    expires_at: expiresAt,
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
        const auditStoreId = req.body?.invoice_id
          ? db.prepare(`SELECT store_id FROM invoices WHERE id = ?`).get(String(req.body.invoice_id))?.store_id || null
          : null;
        audit({
          storeId: auditStoreId,
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
        const allocationInvoiceId = Array.isArray(req.body?.allocations)
          ? req.body.allocations.find((row) => row && row.invoice_id)?.invoice_id
          : null;
        const auditStoreId = allocationInvoiceId
          ? db.prepare(`SELECT store_id FROM invoices WHERE id = ?`).get(String(allocationInvoiceId))?.store_id || null
          : null;
        audit({
          storeId: auditStoreId,
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
  return res.json({ staff: rows.map(projectStaffUser) });
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
    const securityValidation = validateDirectStaffSecurityChange({ role, permissionsOverride });
    if (!securityValidation.ok) {
      return rejectStaffSecurityChange(req, {
        actorId,
        attemptedAction: "staff.create",
        reason: securityValidation.reason,
      });
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
    const created = db.prepare(`SELECT * FROM staff_users WHERE id = ?`).get(id);
    audit({
      actorType: "admin",
      actorId,
      action: "staff.created",
      targetType: "staff",
      targetId: id,
      requestId,
      idempotencyKey: idemKey,
      afterState: projectStaffUser(created),
      ip: req.ip
    });
    return { status: 201, body: { staff: projectStaffUser(created) } };
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

    if (!DIRECTLY_MANAGEABLE_STAFF_ROLES.has(String(before.role || ""))) {
      return rejectStaffSecurityChange(req, {
        actorId,
        targetId: before.id,
        attemptedAction: "staff.update",
        reason: "existing_privileged_role_requires_independent_approval",
      });
    }

    const nextName = req.body?.staff_name != null ? String(req.body.staff_name).trim() : before.staff_name;
    const nextRole = req.body?.role != null ? String(req.body.role) : before.role;
    const nextStatus = req.body?.status != null ? String(req.body.status) : before.status;
    const storedOverride = parseStoredPermissionsOverride(before.permissions_override);
    const nextOverrideValues = Array.isArray(req.body?.permissions_override)
      ? req.body.permissions_override.map((value) => String(value))
      : storedOverride.values;
    const nextOverride = Array.isArray(req.body?.permissions_override)
      ? JSON.stringify(nextOverrideValues)
      : before.permissions_override;
    if (!nextName || !["staff", "operator", "manager", "accounting", "admin"].includes(nextRole) || !["active", "inactive"].includes(nextStatus)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Invalid staff update payload" } } };
    }
    const securityValidation = storedOverride.invalid
      ? { ok: false, reason: "existing_permissions_override_invalid" }
      : validateDirectStaffSecurityChange({ role: nextRole, permissionsOverride: nextOverrideValues });
    if (!securityValidation.ok) {
      return rejectStaffSecurityChange(req, {
        actorId,
        targetId: before.id,
        attemptedAction: "staff.update",
        reason: securityValidation.reason,
      });
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
    return { status: 200, body: { staff: projectStaffUser(after) } };
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
    const storedOverride = parseStoredPermissionsOverride(before.permissions_override);
    const privilegedTarget = !DIRECTLY_MANAGEABLE_STAFF_ROLES.has(String(before.role || ""))
      || storedOverride.invalid
      || !validateDirectStaffSecurityChange({ role: before.role, permissionsOverride: storedOverride.values }).ok;
    if (privilegedTarget) {
      return rejectStaffSecurityChange(req, {
        actorId,
        targetId: before.id,
        attemptedAction: "staff.pin.rotate",
        reason: "privileged_staff_pin_requires_independent_approval",
      });
    }
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
  return res.json({ sessions: rows.map(projectTerminalSession), page: { limit, offset, returned: rows.length } });
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

app.post("/api/v1/admin/payments/disable", requirePlatformPermission("payments.control.global"), (req, res) => {
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

app.post("/api/v1/admin/payments/enable", requirePlatformPermission("payments.control.global"), (req, res) => {
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
  const chainId = String(req.query?.payment_chain_id || req.query?.chain_id || CHAIN_ID).trim();
  const chainResult = paymentChainForInvoiceRequest(chainId, ENABLED_PAYMENT_CHAIN_IDS);
  if (chainResult.error) return jsonError(res, 400, chainResult.error.code, chainResult.error.message, chainResult.error.details);
  const rows = listReceiveAddresses(req.session.store_id, chainId);
  return res.json({
    receive_addresses: rows.map((row) => ({
      id: row.id,
      address: row.address,
      status: row.status,
      network: row.network,
      token_contract: row.token_contract,
      allocated_invoice_id: row.allocated_invoice_id,
      source_label: row.source_label,
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
    const chainId = String(req.body?.payment_chain_id || req.body?.chain_id || CHAIN_ID).trim();
    const chainResult = paymentChainForInvoiceRequest(chainId, ENABLED_PAYMENT_CHAIN_IDS);
    if (chainResult.error) {
      return { status: 400, body: { error: chainResult.error } };
    }
    const imported = importReceiveAddresses({
      storeId: req.session.store_id,
      actorId,
      addresses,
      sourceLabel,
      chainId,
      requestId,
      idempotencyKey: idemKey,
      ip: req.ip,
    });
    if (imported.error) {
      const code = [
        "PRIVATE_KEY_MATERIAL_REJECTED",
        "VALIDATION_ERROR",
        "UNSUPPORTED_PAYMENT_CHAIN",
        "PAYMENT_CHAIN_DISABLED",
      ].includes(imported.error.code) ? 400 : 409;
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

app.get("/api/v1/payment-chains", (req, res) => {
  if (!hasPermission(req.session, "invoice.create") && !hasPermission(req.session, "invoice.read")) {
    return jsonError(res, 403, "FORBIDDEN", "Permission denied: invoice.read");
  }
  return res.json({
    payment_chains: listEnabledPaymentChains(ENABLED_PAYMENT_CHAIN_IDS).map((chain) => publicPaymentChain(chain)),
    official_contract_reference: JPYC_CONTRACT_REFERENCE,
    denied_contracts: JPYC_PREPAID_DENYLIST_CONTRACTS,
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
    const paymentChainId = String(req.body?.payment_chain_id || "").trim();
    if (!paymentChainId) {
      return {
        status: 400,
        body: {
          error: {
            code: "PAYMENT_CHAIN_REQUIRED",
            message: "payment_chain_id is required",
            details: { enabled_chain_ids: ENABLED_PAYMENT_CHAIN_IDS },
          },
        },
      };
    }
    const paymentChainResult = paymentChainForInvoiceRequest(paymentChainId, ENABLED_PAYMENT_CHAIN_IDS);
    if (paymentChainResult.error) {
      return { status: 400, body: { error: paymentChainResult.error } };
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
      paymentChain: paymentChainResult.chain,
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
    // Reorg detection runs in the chain-monitor process. Keep the hold and
    // observation window in the authenticated invoice payload so the terminal
    // can fail closed even when the worker updates SQLite without calling the
    // API process directly.
    monitor_until: invoice.monitor_until || null,
    integrity_hold: Number(invoice.integrity_hold || 0) === 1,
    integrity_hold_reason: invoice.integrity_hold_reason || null,
    fulfillment_hold: Number(invoice.integrity_hold || 0) === 1 || invoice.status === "review_required",
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
        paymentChain: getSupportedPaymentChain(original.chain_id),
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
    const invoiceProviders = rpcProvidersByChain.get(String(invoice.chain_id || CHAIN_ID)) || [];
    const shouldVerifyOnChain = IS_PRODUCTION || (invoiceProviders.length > 0 && parseTxHash(req.body?.tx_hash));
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
    const { status, resolution_note, assigned_to, admin_note, resolution_status, disposition } = req.body || {};
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
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ?`).get(review.invoice_id, req.session.store_id);
    if (!invoice) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice for review case not found" } } };
    const currentResolutionStatus = normalizeReviewResolutionStatus(review.resolution_status, "pending") || "pending";
    const inferredDisposition = nextStatus === "resolved"
      ? (parseBaseUnitOrZero(invoice.paid_amount_jpyc_base) >= parseBaseUnitOrZero(invoice.amount_jpyc_base)
        ? "accepted_as_paid"
        : "cancelled_no_sale")
      : (nextStatus === "rejected" ? "cancelled_no_sale" : null);
    const nextDisposition = normalizeReviewDisposition(disposition, normalizeReviewDisposition(review.disposition, inferredDisposition));
    if (["resolved", "rejected"].includes(nextStatus) && nextDisposition === "escalated") {
      return {
        status: 400,
        body: { error: { code: "ESCALATION_REQUIRES_OPEN_REVIEW", message: "escalated reviews must remain open or in_progress until a final disposition is recorded" } },
      };
    }
    if (nextStatus !== "open" && nextStatus !== "in_progress" && !nextDisposition) {
      return {
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: "disposition is required when resolving or rejecting a review" } },
      };
    }
    if (["resolved", "rejected"].includes(nextStatus) && !String(resolution_note ?? review.resolution_note ?? "").trim()) {
      return {
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: "resolution_note is required when resolving or rejecting a review" } },
      };
    }
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
    const dispositionResult = db.transaction(() => {
      db.prepare(
        `UPDATE review_cases
         SET status = ?,
             resolution_note = ?,
             admin_note = ?,
             resolution_status = ?,
             disposition = ?,
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
        nextDisposition,
        assigned_to ?? review.assigned_to ?? null,
        actionHistory,
        ts,
        nextStatus === "resolved" ? ts : null,
        review.id
      );

      let updatedInvoice = invoice;
      if (nextDisposition === "accepted_as_paid" || nextDisposition === "refunded") {
        if (parseBaseUnitOrZero(invoice.paid_amount_jpyc_base) >= parseBaseUnitOrZero(invoice.amount_jpyc_base)) {
          const update = transitionInvoiceForPayment(invoice, "paid", `review_${nextDisposition}`, {
            actorType: "admin",
            actorId,
            requestId,
            idempotencyKey: idemKey,
            ip: req.ip,
            reason: `review_${nextDisposition}`,
          });
          if (update.error) throw new Error(update.error);
          updatedInvoice = update.invoice;
        }
      } else if (nextDisposition === "cancelled_no_sale" || nextDisposition === "written_off") {
        const update = updateInvoiceStatus(invoice.id, "cancelled", `review_${nextDisposition}`, {
          actorType: "admin",
          actorId,
          requestId,
          idempotencyKey: idemKey,
          ip: req.ip,
          reason: `review_${nextDisposition}`,
        });
        if (update.error) throw new Error(update.error);
        updatedInvoice = update.invoice;
      }
      if (
        ["accepted_as_paid", "refunded"].includes(nextDisposition)
        && String(updatedInvoice.status) === "paid"
        && !db.prepare(`SELECT 1 FROM accounting_event_journal WHERE invoice_id = ? AND event_type = 'payment_confirmed' LIMIT 1`).get(updatedInvoice.id)
      ) {
        const paymentEvent = db
          .prepare(
            `SELECT id, tx_hash, log_index, block_timestamp, detected_at
             FROM payment_events
             WHERE invoice_id = ?
             ORDER BY created_at ASC, rowid ASC
             LIMIT 1`
          )
          .get(updatedInvoice.id);
        recordAccountingEvent({
          storeId: updatedInvoice.store_id,
          invoiceId: updatedInvoice.id,
          eventType: "payment_confirmed",
          occurredAt: paymentEvent?.block_timestamp || paymentEvent?.detected_at || ts,
          amountBase: String(updatedInvoice.paid_amount_jpyc_base || "0"),
          status: "confirmed_by_review",
          sourceRef: `review:${review.id}`,
          payload: {
            review_case_id: review.id,
            payment_event_id: paymentEvent?.id || null,
            tx_hash: paymentEvent?.tx_hash || updatedInvoice.paid_tx_hash || null,
            log_index: paymentEvent?.log_index ?? null,
          },
        });
      }
      return { review: db.prepare(`SELECT * FROM review_cases WHERE id = ?`).get(review.id), invoice: updatedInvoice };
    })();
    const after = dispositionResult.review;
    audit({
      actorType: "admin",
      actorId,
      action: "review.updated",
      targetType: "review",
      targetId: review.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: review,
      afterState: { review: after, invoice: dispositionResult.invoice },
      ip: req.ip
    });
    const reasonCode = normalizeReviewReasonCode(after.reason_type);
    return {
      status: 200,
      body: {
        review: {
          ...after,
          disposition: after.disposition || nextDisposition,
          reason_type: reasonCode,
          reason_code: reasonCode,
          reason_label: reasonCodeLabelJa(reasonCode),
        },
        invoice: dispositionResult.invoice,
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
      invoice_id,
      refund_amount_jpyc,
      refund_to_address,
      refund_chain_id,
      reason,
      evidence_screenshot,
      evidence_note_path,
      customer_note,
    } = req.body || {};
    const parsedRefundBase = parsePositiveBaseUnits(refund_amount_jpyc, "refund_amount_jpyc");
    if ((!review_case_id && !invoice_id) || parsedRefundBase.error || !refund_to_address || !refund_chain_id) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "review_case_id or invoice_id and refund fields are required" } } };
    }
    if (!isEvmAddress(refund_to_address)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "refund_to_address must be valid EVM address" } } };
    }
    let review = db
      .prepare(
        `SELECT r.*,
                i.store_id,
                i.id AS invoice_id,
                i.status AS invoice_status,
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
      .get(review_case_id || "", req.session.store_id);
    if (!review && invoice_id) {
      const paidInvoice = db
        .prepare(`SELECT * FROM invoices WHERE id = ? AND store_id = ?`)
        .get(String(invoice_id), req.session.store_id);
      if (!paidInvoice) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Invoice not found" } } };
      if (String(paidInvoice.status) !== "paid") {
        return { status: 409, body: { error: { code: "REFUND_REQUIRES_PAID_INVOICE", message: "Only a paid invoice can start a normal refund" } } };
      }
      review = db
        .prepare(
          `SELECT r.*,
                  i.store_id,
                  i.id AS invoice_id,
                  i.status AS invoice_status,
                  i.chain_id,
                  i.token_contract,
                  i.recipient_address,
                  i.checkout_session_id,
                  i.amount_jpyc_base,
                  i.paid_amount_jpyc_base,
                  i.paid_tx_hash
           FROM review_cases r JOIN invoices i ON i.id = r.invoice_id
           WHERE r.invoice_id = ? AND i.store_id = ?`
        )
        .get(paidInvoice.id, req.session.store_id);
      if (!review) {
        const caseId = uuid();
        const ts = nowIso();
        db.prepare(
          `INSERT INTO review_cases
           (id, invoice_id, reason_type, tx_hash, billed_amount_jpyc_base, paid_amount_jpyc_base, diff_jpyc_base,
            suggested_action, refundable_candidate_jpyc_base, action_history_json, resolution_status, disposition,
            status, resolution_note, created_at, updated_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', 'refunded', 'resolved', ?, ?, ?, ?)`
        ).run(
          caseId,
          paidInvoice.id,
          REVIEW_REASON_CODES.OTHER,
          paidInvoice.paid_tx_hash || null,
          String(paidInvoice.amount_jpyc_base || "0"),
          String(paidInvoice.paid_amount_jpyc_base || "0"),
          (parseBaseUnitOrZero(paidInvoice.paid_amount_jpyc_base) - parseBaseUnitOrZero(paidInvoice.amount_jpyc_base)).toString(),
          "通常返金として承認・検証の証跡を残してください",
          String(paidInvoice.paid_amount_jpyc_base || "0"),
          JSON.stringify([{ at: ts, action: "refund.case.created_for_paid_invoice", actor_id: actorId }]),
          "normal_refund_case_created",
          ts,
          ts,
          ts
        );
        audit({
          actorType: "admin",
          actorId,
          action: "refund.case.created_for_paid_invoice",
          targetType: "invoice",
          targetId: paidInvoice.id,
          requestId,
          idempotencyKey: idemKey,
          afterState: { review_case_id: caseId, invoice_id: paidInvoice.id, disposition: "refunded" },
          ip: req.ip,
        });
        review = db
          .prepare(
            `SELECT r.*,
                    i.store_id,
                    i.id AS invoice_id,
                    i.status AS invoice_status,
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
          .get(caseId, req.session.store_id);
      }
    }
    if (!review) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Review not found" } } };
    const heldInvoice = db.prepare(`SELECT id, integrity_hold, integrity_hold_reason, integrity_hold_at FROM invoices WHERE id = ? AND integrity_hold = 1`).get(review.invoice_id);
    if (heldInvoice) return integrityHoldApiResult([heldInvoice], "refund request");
    const refundCaseResult = getOrCreateRefundCase({
      invoice: { id: review.invoice_id, store_id: req.session.store_id },
      relatedReviewCaseId: review.id || null,
      reason: reason || review.reason_type || null,
      requestedBy: actorId,
    });
    const refundCase = refundCaseResult.row;
    if (!refundCase) {
      return { status: 500, body: { error: { code: "REFUND_CASE_CREATE_FAILED", message: "Refund case could not be created" } } };
    }
    if (refundCaseResult.created) {
      audit({
        storeId: req.session.store_id,
        actorType: "admin",
        actorId,
        action: "refund.case.created",
        targetType: "refund_case",
        targetId: refundCase.id,
        requestId,
        idempotencyKey: idemKey,
        afterState: refundCase,
        ip: req.ip,
      });
    }
    if (String(refund_chain_id) !== String(review.chain_id)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "refund_chain_id must match invoice chain_id" } } };
    }

    const payerRows = db
      .prepare(
        `SELECT DISTINCT lower(from_address) AS from_address
         FROM payment_events
         WHERE invoice_id = ? AND from_address IS NOT NULL AND length(trim(from_address)) > 0`
      )
      .all(review.invoice_id);
    if (payerRows.length !== 1 || !isEvmAddress(payerRows[0]?.from_address)) {
      return {
        status: 409,
        body: {
          error: {
            code: "PAYER_ADDRESS_NOT_UNAMBIGUOUS",
            message: "refund destination cannot be verified until exactly one payer address is recorded",
            details: { payer_address_count: payerRows.length },
          },
        },
      };
    }
    const payerAddress = normalizeAddress(payerRows[0].from_address);
    const requestedRefundAddress = normalizeAddress(refund_to_address);
    const alternateDestination = requestedRefundAddress !== payerAddress;
    const customerApprovalSignature = String(req.body?.customer_approval_signature || "").trim();
    let destinationApprovalType = "payer_default";
    const effectiveReviewCaseId = review.id;
    const existingSemanticRefund = findActiveRefundBySemantic({
      reviewCaseId: effectiveReviewCaseId,
      refundCaseId: refundCase.id,
      refundAmountBase: parsedRefundBase.value,
      refundToAddress: refund_to_address,
      refundChainId: refund_chain_id,
    });
    if (existingSemanticRefund) {
      audit({
        actorType: "admin",
        actorId,
        action: "refund.request_deduplicated",
        targetType: "refund",
        targetId: existingSemanticRefund.id,
        requestId,
        idempotencyKey: idemKey,
        afterState: existingSemanticRefund,
        ip: req.ip,
      });
      const deduplicated = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(existingSemanticRefund.id);
      return { status: 200, body: buildRefundEvidenceResponse(deduplicated) };
    }

    const eligibleBase = computeRefundEligibilityBase(review, review);
    let reservedBase;
    try {
      reservedBase = computeReservedRefundAmountBase({
        invoiceId: review.invoice_id,
        reviewCaseId: effectiveReviewCaseId,
        refundCaseId: refundCase.id,
      });
    } catch (error) {
      if (error?.code === "REFUND_LEDGER_INTEGRITY_ERROR") return refundLedgerIntegrityApiResult(error);
      throw error;
    }
    const requestedPlusReservedBase = (BigInt(reservedBase) + BigInt(parsedRefundBase.value)).toString();
    if (compareBaseUnits(requestedPlusReservedBase, eligibleBase) > 0) {
      const remainingBase = BigInt(eligibleBase) > BigInt(reservedBase)
        ? (BigInt(eligibleBase) - BigInt(reservedBase)).toString()
        : "0";
      recordSuspiciousActivity({
        storeId: req.session.store_id,
        invoiceId: review.invoice_id,
        reason: "abnormal_refund_request_over_limit",
        payload: {
          requested_base: parsedRefundBase.value,
          reserved_base: reservedBase,
          requested_plus_reserved_base: requestedPlusReservedBase,
          eligible_base: eligibleBase,
          review_case_id: effectiveReviewCaseId,
        },
      });
      return {
        status: 400,
        body: {
          error: {
            code: "OVER_REFUND",
            message: "requested refund exceeds remaining eligible amount",
            details: {
              eligible_refund_amount_jpyc_base: eligibleBase,
              reserved_refund_amount_jpyc_base: reservedBase,
              remaining_refund_amount_jpyc_base: remainingBase,
            },
          },
        },
      };
    }

    if (alternateDestination) {
      const approvalMessage = buildRefundDestinationApprovalMessage({
        invoiceId: review.invoice_id,
        refundToAddress: requestedRefundAddress,
        refundAmountBase: parsedRefundBase.value,
        refundChainId: refund_chain_id,
      });
      if (!customerApprovalSignature) {
        return {
          status: 409,
          body: {
            error: {
              code: "CUSTOMER_DESTINATION_APPROVAL_REQUIRED",
              message: "an alternate refund destination requires a payer signature",
              details: { approval_message: approvalMessage },
            },
          },
        };
      }
      try {
        const recoveredAddress = normalizeAddress(verifyMessage(approvalMessage, customerApprovalSignature));
        if (recoveredAddress !== payerAddress) throw new Error("payer_signature_mismatch");
      } catch (_error) {
        return {
          status: 400,
          body: {
            error: {
              code: "CUSTOMER_DESTINATION_APPROVAL_INVALID",
              message: "customer approval signature does not match the recorded payer address",
            },
          },
        };
      }
      destinationApprovalType = "payer_signed_alternate";
    }

    const rid = uuid();
    const ts = nowIso();
    const refundDisplay = Number(refund_amount_jpyc);
    const normalizedReason = String(reason || normalizeReviewReasonCode(review.reason_type || REVIEW_REASON_CODES.OTHER)).trim();
    db.prepare(
      `INSERT INTO refund_requests
      (id, review_case_id, refund_case_id, invoice_id, original_invoice_id, checkout_session_id, original_tx_hash, reason, requested_by, status, refund_amount_jpyc, refund_amount_jpyc_base,
       refund_eligible_jpyc_base, refund_to_address, refund_chain_id, expected_from_address, customer_approval_signature, destination_approval_type,
       to_address, chain_id, token_contract, evidence_screenshot, evidence_note_path, customer_note, detected_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rid,
      effectiveReviewCaseId,
      refundCase.id,
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
      payerAddress,
      alternateDestination ? customerApprovalSignature : null,
      destinationApprovalType,
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

app.post("/api/v1/refunds/:refundId/funding-lineage", requirePermission("refund.execute"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/refunds/:id/funding-lineage", actorId, () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const refund = db
      .prepare(
        `SELECT rr.*, i.store_id, i.recipient_address, i.chain_id AS invoice_chain_id
         FROM refund_requests rr
         JOIN invoices i ON i.id = rr.invoice_id
         WHERE rr.id = ? AND i.store_id = ?`
      )
      .get(req.params.refundId, req.session.store_id);
    if (!refund) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Refund request not found" } } };
    const existingSweep = db
      .prepare(
        `SELECT id FROM refund_funding_sweeps
         WHERE invoice_id = ? AND sweep_tx_hash = ? AND chain_id = ?
           AND COALESCE(sweep_tx_log_index, -1) = COALESCE(?, -1)`
      )
      .get(refund.invoice_id, parseTxHash(req.body?.sweep_tx_hash), String(req.body?.chain_id || refund.refund_chain_id || ""), req.body?.sweep_tx_log_index == null ? null : Number(req.body.sweep_tx_log_index));
    if (existingSweep) return { status: 200, body: buildRefundEvidenceResponse(db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id)) };

    const sourceAddress = String(req.body?.source_address || "").trim();
    const treasuryAddress = String(req.body?.treasury_address || "").trim();
    const sweepTxHash = parseTxHash(req.body?.sweep_tx_hash);
    const sweepAmount = parsePositiveBaseUnitInteger(req.body?.sweep_amount_jpyc_base, "sweep_amount_jpyc_base");
    const chainId = String(req.body?.chain_id || refund.refund_chain_id || "").trim();
    const sweepTxLogIndex = req.body?.sweep_tx_log_index == null ? null : Number(req.body.sweep_tx_log_index);
    if (
      !isEvmAddress(sourceAddress)
      || !sweepTxHash
      || sweepAmount.error
      || !chainId
      || (sweepTxLogIndex != null && (!Number.isInteger(sweepTxLogIndex) || sweepTxLogIndex < 0))
    ) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "source_address, chain_id, sweep_tx_hash, and sweep_amount_jpyc_base are required" } } };
    }
    if (chainId !== String(refund.refund_chain_id || refund.invoice_chain_id || "")) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "funding lineage chain_id must match refund chain" } } };
    }
    // A single sweep may be smaller than the refund. The v2 allocation ledger
    // conserves each sweep independently and permits several sweeps to fund
    // one refund; the execution gate requires the aggregate to be complete.
    const treasury = getRefundTreasuryConfig({ storeId: refund.store_id, chainId });
    if (!treasury) {
      return {
        status: 409,
        body: { error: { code: "REFUND_TREASURY_NOT_CONFIGURED", message: "store/chain refund treasury is not configured" } },
      };
    }
    if (normalizeAddress(treasuryAddress) !== treasury.address) {
      return { status: 400, body: { error: { code: "REFUND_TREASURY_MISMATCH", message: "treasury_address does not match the approved store/chain treasury" } } };
    }
    if (normalizeAddress(sourceAddress) === treasury.address) {
      return { status: 409, body: { error: { code: "REFUND_SWEEP_SOURCE_TREASURY", message: "sweep source must be the recorded invoice receive address, not the treasury" } } };
    }
    const allowedSourceAddresses = new Set([
      normalizeAddress(refund.recipient_address),
      ...db
        .prepare(`SELECT DISTINCT to_address FROM payment_events WHERE invoice_id = ? AND to_address IS NOT NULL`)
        .all(refund.invoice_id)
        .map((row) => normalizeAddress(row.to_address)),
    ].filter(Boolean));
    if (!allowedSourceAddresses.has(normalizeAddress(sourceAddress))) {
      return {
        status: 409,
        body: {
          error: {
            code: "REFUND_SWEEP_SOURCE_NOT_RECORDED",
            message: "sweep source must be a recorded invoice receive address",
          },
        },
      };
    }
    const timestamp = nowIso();
    const sweepId = uuid();
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO refund_funding_sweeps
           (id, invoice_id, store_id, chain_id, source_address, treasury_address, sweep_tx_hash, sweep_tx_log_index,
            sweep_amount_jpyc_base, status, evidence_note_path, evidence_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?, ?)`
        ).run(
          sweepId,
          refund.invoice_id,
          refund.store_id,
          chainId,
          normalizeAddress(sourceAddress),
          treasury.address,
          sweepTxHash,
          sweepTxLogIndex,
          sweepAmount.value,
          String(req.body?.evidence_note_path || "").trim() || null,
          JSON.stringify(sanitizeAuditState(req.body?.evidence || {})),
          actorId,
          timestamp,
          timestamp,
        );
        // Keep the legacy foreign-key column untouched.  v2 sweep IDs are not
        // rows in refund_funding_lineage; mixing the identifiers would violate
        // the FK and make old evidence ambiguous.
        db.prepare(`UPDATE refund_requests SET updated_at = ? WHERE id = ?`).run(timestamp, refund.id);
      })();
    } catch (error) {
      if (String(error.message || "").includes("UNIQUE")) {
        return { status: 409, body: { error: { code: "DUPLICATE_REFUND_SWEEP", message: "sweep transaction is already linked" } } };
      }
      throw error;
    }
    const after = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
    audit({
      storeId: refund.store_id,
      actorType: "admin",
      actorId,
      action: "refund.funding_lineage_recorded",
      targetType: "refund",
      targetId: refund.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: refund,
      afterState: { refund: after, funding_sweeps: getRefundFundingSweeps(refund.id) },
      ip: req.ip,
    });
    return { status: 201, body: buildRefundEvidenceResponse(after) };
  });
});

app.post("/api/v1/refunds/:refundId/funding-lineage/verify", requirePermission("refund.execute"), async (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotentAsync(req, res, "POST:/api/v1/refunds/:id/funding-lineage/verify", actorId, async () => {
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const refund = db
      .prepare(
        `SELECT rr.*, i.store_id, i.token_contract AS invoice_token_contract
         FROM refund_requests rr
         JOIN invoices i ON i.id = rr.invoice_id
         WHERE rr.id = ? AND i.store_id = ?`
      )
      .get(req.params.refundId, req.session.store_id);
    if (!refund) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Refund request not found" } } };
    const v2Sweeps = getRefundFundingSweeps(refund.id);
    if (v2Sweeps.length > 0) {
      const verified = await verifyRefundFundingSweepsV2(refund, v2Sweeps, actorId, {
        requestId,
        idempotencyKey: idemKey,
        ip: req.ip,
      });
      if (!verified.ok) {
        return {
          status: 409,
          body: {
            error: {
              code: verified.error?.code || "REFUND_FUNDING_ALLOCATION_REJECTED",
              message: verified.error?.message || "refund funding verification is incomplete",
              details: verified.error?.details || {},
            },
          },
        };
      }
      return { status: 200, body: buildRefundEvidenceResponse(verified.afterRefund) };
    }
    const lineage = getRefundFundingLineage(refund.id);
    if (!lineage) {
      return {
        status: 404,
        body: {
          error: {
            code: "REFUND_FUNDING_LINEAGE_NOT_FOUND",
            message: "refund funding lineage must be recorded before verification",
          },
        },
      };
    }
    if (String(lineage.status) === "verified") {
      return { status: 200, body: buildRefundEvidenceResponse(refund) };
    }

    const verification = await verifyRefundFundingLineageOnChain(refund, lineage);
    const timestamp = nowIso();
    const existingEvidence = parseJsonWithWarning(
      lineage.evidence_json,
      "refund_funding_lineage.verify.evidence",
      {}
    );
    const evidence = {
      ...(existingEvidence && typeof existingEvidence === "object" ? existingEvidence : {}),
      verification: verification.evidence || {},
    };
    const update = db
      .prepare(
        `UPDATE refund_funding_lineage
         SET status = ?, evidence_json = ?, updated_at = ?
         WHERE id = ? AND status = ? AND updated_at = ?`
      )
      .run(
        verification.status,
        JSON.stringify(sanitizeAuditState(evidence)),
        timestamp,
        lineage.id,
        lineage.status,
        lineage.updated_at,
      );
    if (update.changes !== 1) {
      const current = getRefundFundingLineage(refund.id);
      if (current?.status === "verified") {
        return {
          status: 200,
          body: buildRefundEvidenceResponse(db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id)),
        };
      }
      return {
        status: 409,
        body: {
          error: {
            code: "REFUND_FUNDING_LINEAGE_CONFLICT",
            message: "funding lineage changed while verification was in progress",
          },
        },
      };
    }
    if (verification.status === "verified") {
      const allocationIdempotencyKey = `refund-funding:${refund.id}:${lineage.id}`;
      const existingAllocations = db
        .prepare(
          `SELECT funding_lineage_id AS sweep_id, refund_request_id, amount_jpyc_base, idempotency_key
           FROM refund_funding_allocations
           WHERE funding_lineage_id = ? OR refund_request_id = ? OR idempotency_key = ?`
        )
        .all(lineage.id, refund.id, allocationIdempotencyKey);
      const allocationPlan = planRefundFundingAllocation({
        sweep: {
          id: lineage.id,
          status: "verified",
          verified_amount_jpyc_base: String(lineage.sweep_amount_jpyc_base || "0"),
        },
        existingAllocations,
        request: {
          sweep_id: lineage.id,
          refund_request_id: refund.id,
          amount_jpyc_base: String(refund.refund_amount_jpyc_base || "0"),
          refund_amount_jpyc_base: String(refund.refund_amount_jpyc_base || "0"),
          idempotency_key: allocationIdempotencyKey,
        },
      });
      if (!allocationPlan.ok) {
        db.prepare(
          `UPDATE refund_funding_lineage
           SET status = 'allocation_failed',
               evidence_json = ?,
               updated_at = ?
           WHERE id = ?`
        ).run(JSON.stringify(sanitizeAuditState({ ...evidence, allocation: allocationPlan })), timestamp, lineage.id);
        return {
          status: 409,
          body: {
            error: {
              code: allocationPlan.error?.code || "REFUND_FUNDING_ALLOCATION_REJECTED",
              message: allocationPlan.error?.message || "refund funding allocation was rejected",
              details: allocationPlan.error?.details || {},
            },
          },
        };
      }
      if (allocationPlan.decision === "create") {
        db.prepare(
          `INSERT INTO refund_funding_allocations
           (id, funding_lineage_id, refund_request_id, amount_jpyc_base, idempotency_key, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuid(),
          lineage.id,
          refund.id,
          allocationPlan.allocation.amount_jpyc_base,
          allocationIdempotencyKey,
          actorId,
          timestamp,
        );
      }
    }
    const after = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
    audit({
      storeId: refund.store_id,
      actorType: "admin",
      actorId,
      action: "refund.funding_lineage_verified",
      targetType: "refund",
      targetId: refund.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: { refund, funding_lineage: lineage },
      afterState: { refund: after, funding_lineage: getRefundFundingLineage(refund.id) },
      ip: req.ip,
    });
    return { status: 200, body: buildRefundEvidenceResponse(after) };
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
    const approveHold = db.prepare(`SELECT id, integrity_hold, integrity_hold_reason, integrity_hold_at FROM invoices WHERE id = ? AND integrity_hold = 1`).get(refund.invoice_id);
    if (approveHold) return integrityHoldApiResult([approveHold], "refund approval");
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
    if (refund.refund_case_id) {
      db.prepare(`UPDATE refund_cases SET status = 'approved', updated_at = ? WHERE id = ?`).run(ts, refund.refund_case_id);
    }
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
    const executeHold = db.prepare(`SELECT id, integrity_hold, integrity_hold_reason, integrity_hold_at FROM invoices WHERE id = ? AND integrity_hold = 1`).get(refund.invoice_id);
    if (executeHold) return integrityHoldApiResult([executeHold], "refund execution");
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
    if (refund.refund_case_id) {
      db.prepare(`UPDATE refund_cases SET status = ?, updated_at = ? WHERE id = ?`).run(execResult.status, ts, refund.refund_case_id);
    }
    const after = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
    recordFinalRefundAccountingEvent(after, req.session.store_id);
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
    const verifyHold = db.prepare(`SELECT id, integrity_hold, integrity_hold_reason, integrity_hold_at FROM invoices WHERE id = ? AND integrity_hold = 1`).get(refund.invoice_id);
    if (verifyHold) return integrityHoldApiResult([verifyHold], "refund verification");
    if (!["recorded", "pending_verification", "verification_failed", "failed"].includes(String(refund.status))) {
      return { status: 409, body: { error: { code: "INVALID_STATE_TRANSITION", message: "Refund is not awaiting verification" } } };
    }

    const verified = await verifyRefundExecutionOnChain(refund, req.body?.refund_tx_hash || null);
    if (verified.error) {
      return { status: 400, body: { error: verified.error } };
    }

    const finalTxHash = verified.refundTxHash || refund.refund_tx_hash || null;
    const finalTxLogIndex = verified.refundTxLogIndex ?? refund.refund_tx_log_index ?? null;
    const normalizeEvidenceHash = (value) => String(value || "").trim().toLowerCase();
    const normalizeEvidenceLogIndex = (value) => (value == null ? -1 : Number(value));
    const conflictResult = (current) => ({
      status: 409,
      body: {
        error: {
          code: "REFUND_VERIFICATION_CONFLICT",
          message: "Refund state or transaction evidence changed while verification was in progress",
          details: {
            refund_id: refund.id,
            current_status: current?.status || null,
          },
        },
      },
    });

    const finalizeVerification = db.transaction(() => {
      const current = db
        .prepare(
          `SELECT rr.* FROM refund_requests rr
           JOIN invoices i ON i.id = rr.invoice_id
           WHERE rr.id = ? AND i.store_id = ?`
        )
        .get(refund.id, req.session.store_id);
      if (!current) {
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "Refund request not found" } } };
      }

      const currentFundingSweeps = getRefundFundingSweeps(current.id);
      const fundingConservation = currentFundingSweeps.length > 0
        ? evaluateRefundFundingConservation(
            current,
            currentFundingSweeps,
            getRefundFundingAllocationsForConservation(current.id, currentFundingSweeps)
          )
        : null;
      const fundingReady = fundingConservation
        ? fundingConservation.executionReady
        : hasVerifiedRefundFundingLineage(current);
      const fundingRequired = currentFundingSweeps.length > 0 || isProductionLikeRuntime();
      if (verified.status === "succeeded" && fundingRequired && !fundingReady) {
        const conservation = fundingConservation?.snapshot || null;
        return {
          status: 409,
          body: {
            error: {
              code: "REFUND_FUNDING_LINEAGE_REQUIRED",
              message: "refund verification requires conserved verified sweep funding",
              details: conservation
                ? {
                    refund_amount_jpyc_base: conservation.refund_amount_jpyc_base,
                    allocated_amount_jpyc_base: conservation.allocated_amount_jpyc_base,
                    refund_fully_funded: conservation.refund_fully_funded,
                    conserved: conservation.conserved,
                    violations: conservation.violations,
                  }
                : {},
            },
          },
        };
      }

      const currentEvidenceMatchesResult = normalizeEvidenceHash(current.refund_tx_hash) === normalizeEvidenceHash(finalTxHash)
        && normalizeEvidenceLogIndex(current.refund_tx_log_index) === normalizeEvidenceLogIndex(finalTxLogIndex);
      const alreadySameSuccess = ["succeeded", "verified"].includes(String(current.status))
        && verified.status === "succeeded"
        && currentEvidenceMatchesResult;
      const snapshotStillCurrent = String(current.status) === String(refund.status)
        && String(current.updated_at || "") === String(refund.updated_at || "")
        && normalizeEvidenceHash(current.refund_tx_hash) === normalizeEvidenceHash(refund.refund_tx_hash)
        && normalizeEvidenceLogIndex(current.refund_tx_log_index) === normalizeEvidenceLogIndex(refund.refund_tx_log_index);

      if (!snapshotStillCurrent) {
        if (alreadySameSuccess) {
          return { status: 200, body: buildRefundEvidenceResponse(current) };
        }
        return conflictResult(current);
      }
      if (!["recorded", "pending_verification", "verification_failed", "failed"].includes(String(current.status))) {
        return { status: 409, body: { error: { code: "INVALID_STATE_TRANSITION", message: "Refund is not awaiting verification" } } };
      }

      if (finalTxHash) {
        const existingHash = db
          .prepare(
            `SELECT id
             FROM refund_requests
             WHERE refund_tx_hash = ?
               AND COALESCE(refund_tx_log_index, -1) = COALESCE(?, -1)
               AND id != ?`
          )
          .get(finalTxHash, finalTxLogIndex, refund.id);
        if (existingHash) {
          return { status: 409, body: { error: { code: "DUPLICATE_REFUND_TX_HASH", message: "refund_tx_hash/log_index already used by another request" } } };
        }
      }

      const ts = nowIso();
      const updated = db.prepare(
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
         WHERE id = ?
           AND status = ?
           AND updated_at = ?
           AND COALESCE(refund_tx_hash, '') = COALESCE(?, '')
           AND COALESCE(refund_tx_log_index, -1) = COALESCE(?, -1)`
      ).run(
        verified.status,
        finalTxHash,
        finalTxLogIndex,
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
        refund.id,
        refund.status,
        refund.updated_at,
        refund.refund_tx_hash || null,
        refund.refund_tx_log_index ?? null
      );
      if (updated.changes !== 1) return conflictResult(current);

      if (current.refund_case_id) {
        db.prepare(`UPDATE refund_cases SET status = ?, updated_at = ? WHERE id = ?`).run(verified.status, ts, current.refund_case_id);
      }

      const after = db.prepare(`SELECT * FROM refund_requests WHERE id = ?`).get(refund.id);
      recordFinalRefundAccountingEvent(after, req.session.store_id);
      const auditBeforeState = fundingConservation
        ? buildRefundFundingAuditState(current, fundingConservation)
        : current;
      const auditAfterState = fundingConservation
        ? buildRefundFundingAuditState(after, fundingConservation)
        : after;
      audit({
        actorType: "admin",
        actorId,
        action: "refund.verified_onchain",
        targetType: "refund",
        targetId: refund.id,
        requestId,
        idempotencyKey: idemKey,
        beforeState: auditBeforeState,
        afterState: auditAfterState,
        ip: req.ip,
      });
      return { status: 200, body: buildRefundEvidenceResponse(after) };
    });
    return finalizeVerification.immediate();
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
    refund_treasury_address: store.refund_treasury_address || null,
    refund_treasury_chain_id: store.refund_treasury_chain_id || store.chain_id || null,
    refund_treasury_approval_ref: store.refund_treasury_approval_ref || null,
    settlement_unresolved_review_policy: resolveSettlementUnresolvedReviewPolicy(store),
    payments,
    supported_wallets: getSupportedWallets(ENV),
    public_payment_simulation_enabled: ENABLE_PUBLIC_PAYMENT_SIMULATION,
    wallet_adapter: WALLET_ADAPTER
  });
});

app.patch("/api/v1/admin/stores/:storeId/refund-treasury", requirePermission("refund.treasury.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "PATCH:/api/v1/admin/stores/:id/refund-treasury", actorId, () => {
    if (req.params.storeId !== req.session.store_id) {
      return { status: 403, body: { error: { code: "FORBIDDEN", message: "Store mismatch" } } };
    }
    const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.params.storeId);
    if (!store) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Store not found" } } };
    const address = String(req.body?.refund_treasury_address || "").trim();
    const chainId = String(req.body?.refund_treasury_chain_id || store.chain_id || "").trim();
    const approvalRef = String(req.body?.refund_treasury_approval_ref || "").trim();
    if (!isEvmAddress(address) || chainId !== String(store.chain_id || "") || isPlaceholderLike(approvalRef)) {
      return {
        status: 400,
        body: {
          error: {
            code: "REFUND_TREASURY_INVALID",
            message: "A valid store-chain treasury address, matching chain, and approval reference are required",
          },
        },
      };
    }
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const before = {
      refund_treasury_address: store.refund_treasury_address || null,
      refund_treasury_chain_id: store.refund_treasury_chain_id || store.chain_id || null,
      refund_treasury_approval_ref: store.refund_treasury_approval_ref || null,
    };
    db.prepare(
      `UPDATE stores
       SET refund_treasury_address = ?, refund_treasury_chain_id = ?, refund_treasury_approval_ref = ?, updated_at = ?
       WHERE id = ?`
    ).run(normalizeAddress(address), chainId, approvalRef, nowIso(), store.id);
    const afterStore = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(store.id);
    audit({
      storeId: store.id,
      actorType: "admin",
      actorId,
      action: "store.refund_treasury_updated",
      targetType: "store",
      targetId: store.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: {
        refund_treasury_address: afterStore.refund_treasury_address,
        refund_treasury_chain_id: afterStore.refund_treasury_chain_id,
        refund_treasury_approval_ref: afterStore.refund_treasury_approval_ref,
      },
      ip: req.ip,
    });
    return {
      status: 200,
      body: {
        store_id: store.id,
        refund_treasury_address: afterStore.refund_treasury_address,
        refund_treasury_chain_id: afterStore.refund_treasury_chain_id,
        refund_treasury_approval_ref: afterStore.refund_treasury_approval_ref,
      },
    };
  });
});

app.patch("/api/v1/admin/stores/:storeId/customer-policies", requirePermission("policy.manage"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "PATCH:/api/v1/admin/stores/:id/customer-policies", actorId, () => {
    if (req.params.storeId !== req.session.store_id) {
      return { status: 403, body: { error: { code: "FORBIDDEN", message: "Store mismatch" } } };
    }
    const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.params.storeId);
    if (!store) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Store not found" } } };
    const values = {
      terms_url: String(req.body?.terms_url || "").trim(),
      privacy_url: String(req.body?.privacy_url || "").trim(),
      refund_policy_url: String(req.body?.refund_policy_url || "").trim(),
      terms_version: String(req.body?.terms_version || "").trim(),
      privacy_version: String(req.body?.privacy_version || "").trim(),
      refund_policy_version: String(req.body?.refund_policy_version || "").trim(),
      terms_hash: String(req.body?.terms_hash || "").trim().toLowerCase(),
      privacy_hash: String(req.body?.privacy_hash || "").trim().toLowerCase(),
      refund_policy_hash: String(req.body?.refund_policy_hash || "").trim().toLowerCase(),
      terms_content: typeof req.body?.contents?.terms === "string" ? req.body.contents.terms : "",
      privacy_content: typeof req.body?.contents?.privacy === "string" ? req.body.contents.privacy : "",
      refund_policy_content: typeof req.body?.contents?.refund === "string" ? req.body.contents.refund : "",
    };
    const invalidUrl = [values.terms_url, values.privacy_url, values.refund_policy_url].some((value) => !isPublishedPolicyUrl(value));
    const invalidVersion = [values.terms_version, values.privacy_version, values.refund_policy_version].some((value) => !isPublishedPolicyVersion(value));
    const invalidHash = [values.terms_hash, values.privacy_hash, values.refund_policy_hash].some((value) => !isPublishedPolicyHash(value));
    const contentVerification = verifyPolicyContentHashes(
      {
        terms: values.terms_content,
        privacy: values.privacy_content,
        refund: values.refund_policy_content,
      },
      {
        terms_hash: values.terms_hash,
        privacy_hash: values.privacy_hash,
        refund_policy_hash: values.refund_policy_hash,
      }
    );
    if (invalidUrl || invalidVersion || invalidHash || !contentVerification.ok) {
      return {
        status: 400,
        body: {
          error: {
            code: "POLICY_PUBLICATION_INVALID",
            message: "All policy URLs, published versions, and server-computed SHA-256 policy content hashes are required",
            details: {
              content_canonicalization: contentVerification.canonicalization,
              missing_content_keys: contentVerification.missing_content_keys,
              mismatch_hash_keys: contentVerification.mismatch_hash_keys,
            },
          },
        },
      };
    }
    const requestId = requestIdFromReq(req);
    const idemKey = req.header("Idempotency-Key");
    const before = evaluateStorePolicyGate(store);
    db.prepare(
      `UPDATE stores
       SET terms_url = ?, privacy_url = ?, refund_policy_url = ?,
           terms_version = ?, privacy_version = ?, refund_policy_version = ?,
           terms_hash = ?, privacy_hash = ?, refund_policy_hash = ?,
           terms_content = ?, privacy_content = ?, refund_policy_content = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      values.terms_url,
      values.privacy_url,
      values.refund_policy_url,
      values.terms_version,
      values.privacy_version,
      values.refund_policy_version,
      contentVerification.computed_hashes.terms_hash,
      contentVerification.computed_hashes.privacy_hash,
      contentVerification.computed_hashes.refund_policy_hash,
      values.terms_content,
      values.privacy_content,
      values.refund_policy_content,
      nowIso(),
      store.id
    );
    const afterStore = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(store.id);
    audit({
      storeId: store.id,
      actorType: "admin",
      actorId,
      action: "store.customer_policies_updated",
      targetType: "store",
      targetId: store.id,
      requestId,
      idempotencyKey: idemKey,
      beforeState: before,
      afterState: evaluateStorePolicyGate(afterStore),
      ip: req.ip,
    });
    return { status: 200, body: { store_id: store.id, policy: evaluateStorePolicyGate(afterStore) } };
  });
});

app.get("/api/v1/audit-logs", requirePermission("audit.read"), (req, res) => {
  const targetType = req.query.target_type ? String(req.query.target_type) : null;
  const targetId = req.query.target_id ? String(req.query.target_id) : null;
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const platformWide = isPlatformOperator(req.session);
  let rows;
  if (targetType && targetId) {
    const scopeSql = platformWide ? "" : " AND store_id = ?";
    const scopeArgs = platformWide ? [targetType, targetId, limit, offset] : [targetType, targetId, req.session.store_id, limit, offset];
    rows = db
      .prepare(`SELECT * FROM audit_logs_scoped WHERE target_type = ? AND target_id = ?${scopeSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...scopeArgs);
  } else {
    const scopeSql = platformWide ? "" : " WHERE store_id = ?";
    rows = db.prepare(`SELECT * FROM audit_logs_scoped${scopeSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...(platformWide ? [limit, offset] : [req.session.store_id, limit, offset]));
  }
  const sanitizedRows = rows.map(sanitizeAuditLogRowForResponse);
  res.json({ audit_logs: sanitizedRows, page: { limit, offset, returned: sanitizedRows.length } });
});

app.get("/api/v1/audit-logs/verify-chain", requirePlatformPermission("audit.read.global"), (_req, res) => {
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
  const platformWide = isPlatformOperator(req.session);
  const totalCount = Number(
    platformWide
      ? db.prepare(`SELECT COUNT(*) AS count FROM audit_logs_scoped`).get().count
      : db.prepare(`SELECT COUNT(*) AS count FROM audit_logs_scoped WHERE store_id = ?`).get(req.session.store_id).count
    || 0
  );
  const truncated = totalCount > limit || requestedLimit > limit;
  if (truncated) {
    res.setHeader(
      "X-Audit-Export-Warning",
      `export truncated: requested=${requestedLimit}, applied_limit=${limit}, total=${totalCount}`
    );
  }
  const rows = platformWide
    ? db.prepare(`SELECT * FROM audit_logs_scoped ORDER BY created_at DESC LIMIT ?`).all(limit)
    : db.prepare(`SELECT * FROM audit_logs_scoped WHERE store_id = ? ORDER BY created_at DESC LIMIT ?`).all(req.session.store_id, limit);
  const sanitizedRows = rows.map(sanitizeAuditLogRowForResponse);
  audit({
    storeId: platformWide ? null : req.session.store_id,
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
      "store_id",
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
    for (const row of sanitizedRows) {
      lines.push(headers.map((header) => escapeCell(row[header])).join(","));
    }
    res.setHeader("content-type", "text/csv; charset=utf-8");
    return res.send(lines.join("\n"));
  }
  return res.json({
    audit_logs: sanitizedRows,
    exported_at: nowIso(),
    format: "json",
    count: sanitizedRows.length,
    meta: {
      requested_limit: requestedLimit,
      applied_limit: limit,
      total_count: totalCount,
      truncated,
    },
  });
});

app.get("/api/v1/chain-monitor/status", requirePlatformPermission("monitor.read"), (_req, res) => {
  const stateRows = db.prepare(`SELECT key, value, updated_at FROM chain_monitor_state WHERE key LIKE ? OR key LIKE ? ORDER BY key ASC`).all(
    `worker:${CHAIN_ID}:%`,
    `last_block:${CHAIN_ID}:%`
  );
  const failoverCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_rpc_failovers WHERE chain_id = ?`).get(CHAIN_ID).count;
  const unmatchedCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_unmatched_events WHERE chain_id = ?`).get(CHAIN_ID).count;
  const deadLetterCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE chain_id = ?`).get(CHAIN_ID).count;
  const reorgCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_reorgs WHERE chain_id = ?`).get(CHAIN_ID).count;
  const unresolvedReorgCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_reorgs WHERE chain_id = ? AND status = 'unresolved'`).get(CHAIN_ID).count;
  const pendingDeadLetterCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE chain_id = ? AND status = 'pending'`).get(CHAIN_ID).count;
  const abandonedDeadLetterCount = db.prepare(`SELECT COUNT(*) AS count FROM chain_dead_letters WHERE chain_id = ? AND status = 'abandoned'`).get(CHAIN_ID).count;
  const addressPoolAvailableCount = db.prepare(`SELECT COUNT(*) AS count FROM receive_addresses WHERE status = 'available'`).get().count;
  return res.json({
    state: stateRows,
    failover_count: failoverCount,
    unmatched_event_count: unmatchedCount,
    dead_letter_count: deadLetterCount,
    reorg_count: reorgCount,
    unresolved_reorg_count: unresolvedReorgCount,
    pending_dead_letter_count: pendingDeadLetterCount,
    abandoned_dead_letter_count: abandonedDeadLetterCount,
    address_pool_available_count: addressPoolAvailableCount
  });
});

app.get("/api/v1/chain-monitor/reorgs", requirePlatformPermission("monitor.read"), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const rows = db
    .prepare(`SELECT * FROM chain_reorgs WHERE chain_id = ? ORDER BY detected_at DESC LIMIT ? OFFSET ?`)
    .all(CHAIN_ID, limit, offset);
  return res.json({ reorgs: rows, page: { limit, offset, returned: rows.length } });
});

app.post("/api/v1/chain-monitor/reorgs/:id/resolve", requirePlatformPermission("monitor.reconcile"), (req, res) => {
  const reorgId = String(req.params.id || "").trim();
  const resolutionNote = String(req.body?.resolution_note || "").trim();
  const invoiceIds = Array.isArray(req.body?.invoice_ids)
    ? [...new Set(req.body.invoice_ids.map((value) => String(value || "").trim()).filter(Boolean))]
    : null;
  if (!reorgId || resolutionNote.length < 10 || invoiceIds === null) {
    return jsonError(res, 400, "VALIDATION_ERROR", "resolution_note and invoice_ids array are required");
  }
  const before = db.prepare(`SELECT * FROM chain_reorgs WHERE id = ? AND chain_id = ?`).get(reorgId, CHAIN_ID);
  if (!before) return jsonError(res, 404, "NOT_FOUND", "Chain reorganization record not found");
  if (before.status !== "unresolved") return jsonError(res, 409, "ALREADY_RESOLVED", "Chain reorganization is already resolved");
  const lowerBlock = [before.from_block, before.to_block]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0] ?? null;
  const upperBlock = [before.from_block, before.to_block]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0] ?? null;
  const affectedRows = lowerBlock == null || upperBlock == null
    ? []
    : db.prepare(
      `SELECT DISTINCT i.*
       FROM invoices i
       JOIN payment_events pe ON pe.invoice_id = i.id
       WHERE pe.chain_id = ?
         AND pe.block_number BETWEEN ? AND ?
       ORDER BY i.created_at ASC, i.id ASC`
    ).all(CHAIN_ID, lowerBlock, upperBlock);
  const affectedIds = affectedRows.map((row) => String(row.id));
  const cancelledAffectedIds = affectedRows
    .filter((row) => String(row.status) === "cancelled")
    .map((row) => String(row.id));
  if (cancelledAffectedIds.length > 0) {
    return jsonError(
      res,
      409,
      "REORG_CANCELLED_INVOICE_REQUIRES_MANUAL_REVIEW",
      "cancelled invoices affected by a reorg require a separate platform review",
      { invoice_ids: cancelledAffectedIds }
    );
  }
  const unknownInvoiceIds = invoiceIds.filter((invoiceId) => !affectedIds.includes(invoiceId));
  const missingInvoiceIds = affectedIds.filter((invoiceId) => !invoiceIds.includes(invoiceId));
  if (unknownInvoiceIds.length > 0 || missingInvoiceIds.length > 0) {
    return jsonError(
      res,
      409,
      "REORG_INVOICE_RECONCILIATION_REQUIRED",
      "invoice_ids must exactly cover payment invoices affected by the reorg",
      { affected_invoice_ids: affectedIds, unknown_invoice_ids: unknownInvoiceIds, missing_invoice_ids: missingInvoiceIds }
    );
  }

  const requestId = requestIdFromReq(req);
  const resolvedAt = nowIso();
  const result = db.transaction(() => {
    const reconciled = [];
    for (const invoice of affectedRows) {
      let updatedInvoice = invoice;
      if (String(invoice.status) !== "review_required") {
        const update = updateInvoiceStatus(invoice.id, "review_required", "chain_reorg_reconciliation_required", {
          actorType: "platform_operator",
          actorId: req.session.staff_user_id,
          requestId,
          ip: req.ip,
          reason: "chain_reorg_reconciliation_required",
        });
        if (update.error) throw new Error(`reorg_invoice_transition_failed:${invoice.id}:${update.error}`);
        updatedInvoice = update.invoice;
      }
      const event = db
        .prepare(
          `SELECT tx_hash, amount_jpyc_base, block_timestamp, detected_at
           FROM payment_events
           WHERE invoice_id = ? AND chain_id = ? AND block_number BETWEEN ? AND ?
           ORDER BY block_number ASC, created_at ASC, id ASC
           LIMIT 1`
        )
        .get(invoice.id, CHAIN_ID, lowerBlock, upperBlock);
      const reviewCase = upsertReviewCase(updatedInvoice, REVIEW_REASON_CODES.CHAIN_INCONSISTENT, {
        txHash: event?.tx_hash || updatedInvoice.paid_tx_hash || null,
        eventAmountBase: updatedInvoice.paid_amount_jpyc_base || event?.amount_jpyc_base || "0",
        blockTimestamp: event?.block_timestamp || event?.detected_at || resolvedAt,
        detectedAt: event?.detected_at || resolvedAt,
        suggestedAction: "reconcile_chain_reorg_and_reconfirm_payment",
      });
      recordAccountingEvent({
        storeId: updatedInvoice.store_id,
        invoiceId: updatedInvoice.id,
        eventType: "payment_reorg_adjustment",
        occurredAt: resolvedAt,
        amountBase: "0",
        status: "reversal_pending",
        sourceRef: `reorg:${reorgId}:${updatedInvoice.id}`,
        payload: {
          chain_reorg_id: reorgId,
          payment_event_tx_hash: event?.tx_hash || null,
          from_block: before.from_block,
          to_block: before.to_block,
          review_case_id: reviewCase?.id || null,
        },
      });
      const afterInvoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoice.id);
      audit({
        storeId: invoice.store_id,
        actorType: "platform_operator",
        actorId: req.session.staff_user_id,
        action: "chain_reorg.invoice_reconciliation_required",
        targetType: "invoice",
        targetId: invoice.id,
        requestId,
        beforeState: invoice,
        afterState: { invoice: afterInvoice, review_case: reviewCase },
        ip: req.ip,
      });
      reconciled.push({ invoice_id: invoice.id, review_case_id: reviewCase?.id || null, status: afterInvoice.status });
    }
    db.prepare(
      `UPDATE chain_reorgs
       SET status = 'resolved', resolved_at = ?, resolution_note = ?
       WHERE id = ? AND chain_id = ? AND status = 'unresolved'`
    ).run(resolvedAt, resolutionNote, reorgId, CHAIN_ID);
    const after = db.prepare(`SELECT * FROM chain_reorgs WHERE id = ?`).get(reorgId);
    audit({
      actorType: "platform_operator",
      actorId: req.session.staff_user_id,
      action: "chain_reorg.reconciled",
      targetType: "chain_reorg",
      targetId: reorgId,
      requestId,
      beforeState: before,
      afterState: { reorg: after, reconciled_invoices: reconciled },
      ip: req.ip,
    });
    return { after, reconciled };
  })();
  return res.json({ reorg: result.after, reconciled_invoices: result.reconciled, audit_recorded: true });
});

app.get("/api/v1/chain-monitor/unmatched", requirePlatformPermission("monitor.read"), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const rows = db
    .prepare(`SELECT * FROM chain_unmatched_events WHERE chain_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(CHAIN_ID, limit, offset);
  return res.json({ unmatched_events: rows, page: { limit, offset, returned: rows.length } });
});

app.get("/api/v1/chain-monitor/dead-letters", requirePlatformPermission("monitor.read"), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const rows = db.prepare(`SELECT * FROM chain_dead_letters WHERE chain_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(CHAIN_ID, limit, offset);
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
    const integrityHeld = listIntegrityHeldInvoices(req.session.store_id, range);
    if (integrityHeld.length > 0) return integrityHoldApiResult(integrityHeld, "daily close");

    let result;
    try {
      result = db.transaction(() => {
      const existing = db.prepare(`SELECT * FROM settlements WHERE store_id = ? AND business_date = ?`).get(req.session.store_id, businessDate);
      if (existing) {
        const boundExport = db
          .prepare(
            `SELECT * FROM settlement_exports
             WHERE settlement_id = ? AND store_id = ?
             ORDER BY generated_at ASC
             LIMIT 1`
          )
          .get(existing.id, req.session.store_id);
        const boundMetadata = boundExport
          ? parseJsonWithWarning(boundExport.metadata_json, "settlement.close.bound_export_metadata", {})
          : {};
        const contractVersion = boundExport ? resolveSettlementExportContractVersion(boundMetadata) : null;
        if (boundExport && !contractVersion) {
          return {
            status: 409,
            body: {
              error: {
                code: "UNSUPPORTED_SETTLEMENT_EXPORT_CONTRACT",
                message: "Bound settlement export contract version is unsupported",
              },
            },
          };
        }
        const boundExportRunId = boundMetadata?.export_run_id || null;
        const storedSnapshotRows = boundExport
          ? loadSettlementExportRows(boundExportRunId, contractVersion)
          : [];
        const existingSnapshotRows = contractVersion === SETTLEMENT_EXPORT_CONTRACT_V2
          ? applySettlementExportV2RowAnnotations(storedSnapshotRows, boundMetadata)
          : storedSnapshotRows;
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
            export_id: boundExport?.id || null,
            export_run_id: boundExportRunId,
            contract_version: contractVersion,
            export_binding_status: boundExport ? "bound" : "legacy_export_missing",
            accounting_summary: boundExport ? buildDailyAccountingSummary(existingSnapshotRows) : null,
            refund_manifest: contractVersion === SETTLEMENT_EXPORT_CONTRACT_V2 ? boundMetadata._refund_manifest || [] : null,
            refund_totals: contractVersion === SETTLEMENT_EXPORT_CONTRACT_V2 ? boundMetadata._refund_totals || null : null,
            content_hash: boundMetadata?.content_hash || null,
            content_hashes: boundMetadata?.content_hashes || null,
            already_closed: true,
            warning: Number(existing.review_count || 0) > 0 ? "UNRESOLVED_REVIEWS" : null,
            review_count: Number(existing.review_count || 0),
            review_invoice_ids: []
          }
        };
      }

      const allInvoices = db
        .prepare(
           `SELECT id, amount_jpy, paid_amount_jpyc, paid_amount_jpyc_base, status, business_date, settled_at
           FROM invoices
           WHERE store_id = ?
             AND (business_date = ? OR (business_date IS NULL AND created_at BETWEEN ? AND ?))`
        )
        .all(req.session.store_id, businessDate, range.fromUtc, range.toUtc);
      const activeInvoices = allInvoices.filter((row) => (
        isTerminalActiveInvoiceStatus(row.status)
        && !row.settled_at
        && !hasProviderSettlementPath(row.id)
      ));
      if (activeInvoices.length > 0) {
        return {
          status: 409,
          body: {
            error: {
              code: "ACTIVE_INVOICES_BLOCK_CLOSE",
              message: "active invoices must be expired, paid, or moved to review before daily close",
              details: {
                business_date: businessDate,
                active_invoice_ids: activeInvoices.map((row) => row.id),
              },
            },
          },
        };
      }
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
      const artifact = persistSettlementExportArtifact({
        settlementId,
        businessDate,
        format: "csv",
        store,
        actorId,
        range,
        snapshot,
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
          export_id: artifact.exportId,
          export_run_id: artifact.exportRunId,
          contract_version: SETTLEMENT_EXPORT_CONTRACT_V2,
          export_binding_status: "bound",
          accounting_summary: artifact.metadata.totals,
          refund_manifest: artifact.metadata._refund_manifest,
          refund_totals: artifact.metadata._refund_totals,
          content_hash: artifact.metadata.content_hash,
          content_hashes: artifact.metadata.content_hashes,
          already_closed: false,
          warning: reviewInvoices.length > 0 ? "UNRESOLVED_REVIEWS" : null,
          review_count: reviewInvoices.length,
          review_invoice_ids: reviewInvoiceIds
        }
      };
      })();
    } catch (error) {
      if (error?.code === "REFUND_LEDGER_INTEGRITY_ERROR") return refundLedgerIntegrityApiResult(error);
      throw error;
    }

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
  const integrityHeld = listIntegrityHeldInvoices(req.session.store_id, range);
  if (integrityHeld.length > 0) {
    const blocked = integrityHoldApiResult(integrityHeld, "daily export");
    return res.status(blocked.status).json(blocked.body);
  }

  const rows = db
    .prepare(
      `SELECT i.id AS invoice_id,
              i.invoice_no,
              i.merchant_id,
              i.store_id,
              i.terminal_id,
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
              r.reason_type AS reason_code,
              r.id AS review_case_id,
              r.status AS review_status,
              r.block_timestamp,
              r.detected_at,
              r.audit_ref,
              rr.status AS refund_status,
              rr.id AS refund_request_id,
              rr.refund_case_id,
              rr.review_case_id AS refund_review_case_id,
              rr.refund_amount_jpyc_base,
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

  const legacyRows = normalizeLegacySettlementRows(rows);
  const invoiceRows = legacyRows.invoice_rows;

  const totals = {
    invoice_count: invoiceRows.length,
    paid_count: invoiceRows.filter((row) => String(row.invoice_status) === "paid").length,
    settled_count: invoiceRows.filter((row) => String(row.invoice_status) === "settled" || !!row.settled_at).length,
    manual_review_count: invoiceRows.filter((row) => String(row.invoice_status) === "review_required").length,
    cancelled_count: invoiceRows.filter((row) => String(row.invoice_status) === "cancelled").length,
    expired_count: invoiceRows.filter((row) => String(row.invoice_status) === "expired").length,
    refund_requested_count: legacyRows.refund_rows.filter((row) => String(row.refund_status) === "requested").length,
    refund_completed_count: legacyRows.refund_rows.filter((row) => String(row.refund_status) === "succeeded").length,
  };
  if (format === "csv") {
    res.setHeader("content-type", "text/csv; charset=utf-8");
    return res.send(buildSettlementExportCsv(invoiceRows));
  }

  return res.json({
    business_date: businessDate,
    timezone: store.timezone || "Asia/Tokyo",
    period_start_utc: range.fromUtc,
    period_end_utc: range.toUtc,
    totals,
    rows: legacyRows.detail_rows.map((row) => ({
      ...row,
      reason_code: normalizeReviewReasonCode(row.reason_code || REVIEW_REASON_CODES.OTHER),
      reason_label: reasonCodeLabelJa(row.reason_code || REVIEW_REASON_CODES.OTHER),
    })),
    invoice_rows: invoiceRows,
    refund_rows: legacyRows.refund_rows,
    legacy_row_attribution: "invoice_primary_rows_are_used_for_totals_and_csv_refunds_are_aggregated_by_refund_request_id",
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
  const integrityHeld = listIntegrityHeldInvoices(req.session.store_id, range);
  if (integrityHeld.length > 0) {
    const blocked = integrityHoldApiResult(integrityHeld, "monthly export");
    return res.status(blocked.status).json(blocked.body);
  }

  const rows = db
    .prepare(
      `SELECT i.id AS invoice_id,
              i.invoice_no,
              i.merchant_id,
              i.store_id,
              i.terminal_id,
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
              r.reason_type AS reason_code,
              r.id AS review_case_id,
              r.status AS review_status,
              r.block_timestamp,
              r.detected_at,
              r.audit_ref,
              rr.status AS refund_status,
              rr.id AS refund_request_id,
              rr.refund_case_id,
              rr.review_case_id AS refund_review_case_id,
              rr.refund_amount_jpyc_base,
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

  const legacyRows = normalizeLegacySettlementRows(rows);
  const invoiceRows = legacyRows.invoice_rows;

  const totals = {
    invoice_count: invoiceRows.length,
    paid_count: invoiceRows.filter((row) => String(row.invoice_status) === "paid").length,
    settled_count: invoiceRows.filter((row) => String(row.invoice_status) === "settled" || !!row.settled_at).length,
    manual_review_count: invoiceRows.filter((row) => String(row.invoice_status) === "review_required").length,
    cancelled_count: invoiceRows.filter((row) => String(row.invoice_status) === "cancelled").length,
    expired_count: invoiceRows.filter((row) => String(row.invoice_status) === "expired").length,
    refund_requested_count: legacyRows.refund_rows.filter((row) => String(row.refund_status) === "requested").length,
    refund_completed_count: legacyRows.refund_rows.filter((row) => String(row.refund_status) === "succeeded").length,
  };

  if (format === "csv") {
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="settlement-monthly-${yearMonth}.csv"`);
    return res.send(buildSettlementExportCsv(invoiceRows));
  }

  return res.json({
    year_month: yearMonth,
    timezone,
    period_start_utc: range.fromUtc,
    period_end_utc: range.toUtc,
    totals,
    rows: legacyRows.detail_rows.map((row) => ({
      ...row,
      reason_code: normalizeReviewReasonCode(row.reason_code || REVIEW_REASON_CODES.OTHER),
      reason_label: reasonCodeLabelJa(row.reason_code || REVIEW_REASON_CODES.OTHER),
    })),
    invoice_rows: invoiceRows,
    refund_rows: legacyRows.refund_rows,
    legacy_row_attribution: "invoice_primary_rows_are_used_for_totals_and_csv_refunds_are_aggregated_by_refund_request_id",
  });
});

app.post("/api/v1/settlement-exports", requirePermission("settlement.export"), (req, res) => {
  const actorId = req.session.staff_user_id;
  return idempotent(req, res, "POST:/api/v1/settlement-exports", actorId, () => {
    const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(req.session.store_id);
    if (!store) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Store not found" } } };

    const defaultDate = DateTime.now().setZone(store.timezone || "Asia/Tokyo").toISODate();
    const businessDate = String(req.body?.business_date || defaultDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "business_date must be YYYY-MM-DD" } } };
    }
    const format = String(req.body?.format || "json").trim().toLowerCase();
    if (!["json", "csv"].includes(format)) {
      return { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "format must be json or csv" } } };
    }
    const range = utcRangeForBusinessDate(businessDate, store.timezone || "Asia/Tokyo");
    if (range.error) {
      return {
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: "Invalid business_date for timezone", details: range.details || {} } },
      };
    }
    const integrityHeld = listIntegrityHeldInvoices(req.session.store_id, range);
    if (integrityHeld.length > 0) return integrityHoldApiResult(integrityHeld, "settlement export");

    let result;
    try {
      result = db.transaction(() => {
        const snapshot = createSettlementExportSnapshot({
          businessDate,
          store,
          terminalId: null,
          actorId,
          requestId: requestIdFromReq(req),
          idempotencyKey: req.header("Idempotency-Key"),
          ip: req.ip,
          range,
        });
        const artifact = persistSettlementExportArtifact({
          businessDate,
          format,
          store,
          actorId,
          range,
          snapshot,
        });
        return {
          status: 201,
          body: {
            export_id: artifact.exportId,
            export_run_id: artifact.exportRunId,
            contract_version: SETTLEMENT_EXPORT_CONTRACT_V2,
            business_date: businessDate,
            format,
            generated_at: artifact.generatedAt,
            output_path: artifact.outputPath,
            accounting_summary: artifact.metadata.totals,
            refund_manifest: artifact.metadata._refund_manifest,
            refund_totals: artifact.metadata._refund_totals,
            row_count: artifact.rows.length,
            content_hash: artifact.metadata.content_hash,
            content_hashes: artifact.metadata.content_hashes,
          },
        };
      })();
    } catch (error) {
      if (error?.code === "REFUND_LEDGER_INTEGRITY_ERROR") return refundLedgerIntegrityApiResult(error);
      throw error;
    }

    return result;
  });
});

app.get("/api/v1/settlement-exports/:id", requirePermission("settlement.export"), (req, res) => {
  const exportRow = db
    .prepare(`SELECT * FROM settlement_exports WHERE id = ? AND store_id = ?`)
    .get(String(req.params.id || ""), req.session.store_id);
  if (!exportRow) return jsonError(res, 404, "NOT_FOUND", "Settlement export not found");
  const metadata = parseJsonWithWarning(exportRow.metadata_json, "settlement_exports.metadata_json", {});
  const contractVersion = resolveSettlementExportContractVersion(metadata);
  if (!contractVersion) {
    return jsonError(res, 409, "UNSUPPORTED_SETTLEMENT_EXPORT_CONTRACT", "Settlement export contract version is unsupported");
  }
  const exportRunId = metadata?.export_run_id || null;
  const storedRows = loadSettlementExportRows(exportRunId, contractVersion);
  const rows = contractVersion === SETTLEMENT_EXPORT_CONTRACT_V2
    ? applySettlementExportV2RowAnnotations(storedRows, metadata)
    : storedRows;
  const responseBody = {
    export_id: exportRow.id,
    export_run_id: exportRunId,
    contract_version: contractVersion,
    business_date: exportRow.business_date,
    format: exportRow.format,
    generated_at: exportRow.generated_at,
    output_path: exportRow.output_path,
    content_hash: metadata?.content_hash || null,
    content_hashes: metadata?.content_hashes || null,
    metadata: contractVersion === SETTLEMENT_EXPORT_CONTRACT_V2
      ? publicSettlementExportV2Metadata(metadata)
      : metadata,
    rows,
  };
  if (contractVersion === SETTLEMENT_EXPORT_CONTRACT_V2) {
    responseBody.refund_manifest = metadata._refund_manifest || [];
    responseBody.refund_totals = metadata._refund_totals || null;
  }
  return res.json(responseBody);
});

app.get("/api/v1/settlement-exports/:id/download", requirePermission("settlement.export"), (req, res) => {
  const exportRow = db
    .prepare(`SELECT * FROM settlement_exports WHERE id = ? AND store_id = ?`)
    .get(String(req.params.id || ""), req.session.store_id);
  if (!exportRow) return jsonError(res, 404, "NOT_FOUND", "Settlement export not found");
  const metadata = parseJsonWithWarning(exportRow.metadata_json, "settlement_exports.metadata_json", {});
  const contractVersion = resolveSettlementExportContractVersion(metadata);
  if (!contractVersion) {
    return jsonError(res, 409, "UNSUPPORTED_SETTLEMENT_EXPORT_CONTRACT", "Settlement export contract version is unsupported");
  }
  const exportRunId = metadata?.export_run_id || null;
  const storedRows = loadSettlementExportRows(exportRunId, contractVersion);
  const rows = contractVersion === SETTLEMENT_EXPORT_CONTRACT_V2
    ? applySettlementExportV2RowAnnotations(storedRows, metadata)
    : storedRows;
  const format = String(req.query.format || exportRow.format || "json").trim().toLowerCase();
  if (!["json", "csv"].includes(format)) {
    return jsonError(res, 400, "VALIDATION_ERROR", "format must be json or csv");
  }
  const filename = `settlement-export-${exportRow.business_date}-${exportRow.id}.${format}`;
  res.setHeader("content-disposition", `attachment; filename="${filename}"`);
  res.setHeader("x-settlement-export-contract-version", contractVersion);
  if (contractVersion === SETTLEMENT_EXPORT_CONTRACT_V1) {
    if (format === "csv") {
      res.setHeader("content-type", "text/csv; charset=utf-8");
      return res.send(buildSettlementExportV1SnapshotCsv(rows, { bom: true }));
    }
    const payload = buildSettlementExportV1SnapshotJsonPayload({ exportRow, metadata, rows });
    return res.json({
      ...payload,
      content_hash: metadata?.content_hashes?.json || metadata?.content_hash || null,
      content_hashes: metadata?.content_hashes || null,
    });
  }
  if (format === "csv") {
    const csvDownload = buildSettlementExportV2SnapshotCsv(rows, { bom: true });
    const actualHash = sha256(csvDownload);
    const expectedHash = metadata?.content_hashes?.csv || null;
    if (metadata?.hash_scope?.version !== SETTLEMENT_EXPORT_V2_CANONICAL_HASH_SCOPE || expectedHash !== actualHash) {
      return jsonError(res, 409, "SETTLEMENT_EXPORT_HASH_MISMATCH", "stored CSV hash does not match frozen snapshot bytes");
    }
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("x-content-sha256", actualHash);
    return res.send(csvDownload);
  }
  const payload = buildSettlementExportV2SnapshotJsonPayload({ exportRow, metadata, rows });
  const jsonDownload = JSON.stringify(payload);
  const actualHash = sha256(jsonDownload);
  const expectedHash = metadata?.content_hashes?.json || null;
  if (metadata?.hash_scope?.version !== SETTLEMENT_EXPORT_V2_CANONICAL_HASH_SCOPE || expectedHash !== actualHash) {
    return jsonError(res, 409, "SETTLEMENT_EXPORT_HASH_MISMATCH", "stored JSON hash does not match frozen snapshot bytes");
  }
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("x-content-sha256", actualHash);
  return res.send(jsonDownload);
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
    monitor_until: invoice.monitor_until || null,
    integrity_hold: Number(invoice.integrity_hold || 0) === 1,
    integrity_hold_reason: invoice.integrity_hold_reason || null,
    fulfillment_hold: Number(invoice.integrity_hold || 0) === 1 || invoice.status === "review_required",
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
  const buildStreamSnapshot = (row) => ({
    invoiceId: row.id,
    status: row.status,
    status_reason: row.status_reason,
    paid_tx_hash: row.paid_tx_hash,
    monitor_until: row.monitor_until || null,
    integrity_hold: Number(row.integrity_hold || 0) === 1,
    integrity_hold_reason: row.integrity_hold_reason || null,
    fulfillment_hold: Number(row.integrity_hold || 0) === 1 || row.status === "review_required",
    status_version: row.updated_at || null,
    last_event_id: req.header("last-event-id") || null,
  });
  let lastStreamSnapshot = JSON.stringify(buildStreamSnapshot(invoice));
  const writeStreamSnapshotIfChanged = () => {
    if (res.writableEnded) return;
    try {
      const latest = db
        .prepare(
          `SELECT id, status, status_reason, paid_tx_hash, monitor_until,
                  integrity_hold, integrity_hold_reason, updated_at
           FROM invoices
           WHERE id = ? AND terminal_id = ?`
        )
        .get(invoiceId, terminalId);
      if (!latest) return;
      const payload = buildStreamSnapshot(latest);
      const serialized = JSON.stringify(payload);
      if (serialized === lastStreamSnapshot) return;
      lastStreamSnapshot = serialized;
      res.write(`event: invoice.updated\ndata: ${serialized}\n\n`);
      res.write(`event: status_changed\ndata: ${serialized}\n\n`);
    } catch (error) {
      console.warn(
        JSON.stringify({
          ts: nowIso(),
          level: "warn",
          type: "sse.snapshot_refresh_failed",
          terminal_id: terminalId,
          invoice_id: invoiceId,
          message: String(error.message || error),
        })
      );
    }
  };
  try {
    const snapshotPayload = buildStreamSnapshot(invoice);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshotPayload)}\n\n`);
    res.write(`event: invoice.updated\ndata: ${JSON.stringify(snapshotPayload)}\n\n`);
  } catch (error) {
    return jsonError(res, 500, "SSE_SNAPSHOT_FAILED", String(error.message || error));
  }
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, 30_000);
  // chain-monitor is a separate process and updates SQLite directly. Poll the
  // row while the stream is open so an integrity hold is pushed to the terminal
  // without waiting for a user action or relying on the API process to emit an
  // in-process event.
  const snapshotTimer = setInterval(writeStreamSnapshotIfChanged, 2_000);

  const cleanup = () => {
    clearInterval(heartbeatTimer);
    clearInterval(snapshotTimer);
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
  return res.json({
    app_env: APP_ENV,
    commercial_go_mode: commercial.commercial_go_mode,
    commercial_verdict: commercial.commercial_verdict,
    demo_controls_enabled: DEMO_CONTROLS_ENABLED,
    public_payment_simulation_enabled: ENABLE_PUBLIC_PAYMENT_SIMULATION,
    diagnostic_mode_enabled: DIAGNOSTIC_MODE_ENABLED,
    wallet_adapter: WALLET_ADAPTER
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
  const officialPaymentChain = getSupportedPaymentChain(invoice.chain_id);
  let policySnapshot = null;
  try {
    policySnapshot = invoice.policy_snapshot_json ? JSON.parse(invoice.policy_snapshot_json) : null;
  } catch (_error) {
    policySnapshot = null;
  }
  const paymentEvidenceTimestamps = findInvoicePaymentEvidenceTimestamps(invoice);
  const serverNow = nowIso();
  res.json({
    invoice_id: invoice.id,
    invoice_no: invoice.invoice_no,
    amount_jpy: invoice.amount_jpy,
    amount_jpyc: invoice.amount_jpyc,
    amount_jpyc_base: invoice.amount_jpyc_base,
    status: invoice.status,
    monitor_until: invoice.monitor_until || null,
    integrity_hold: Number(invoice.integrity_hold || 0) === 1,
    integrity_hold_reason: invoice.integrity_hold_reason || null,
    fulfillment_hold: Number(invoice.integrity_hold || 0) === 1 || invoice.status === "review_required",
    status_version: invoice.updated_at,
    issued_at: invoice.created_at,
    created_at: invoice.created_at,
    server_now: serverNow,
    expires_at: invoice.expires_at,
    ttl_remaining_sec: computeTtlRemainingSec(invoice.expires_at, new Date(serverNow).getTime()),
    paid_tx_hash: invoice.paid_tx_hash || null,
    confirmed_at: paymentEvidenceTimestamps.confirmedAt,
    chain_recorded_at: paymentEvidenceTimestamps.chainRecordedAt,
    chain_id: invoice.chain_id,
    native_symbol: officialPaymentChain?.native_symbol || null,
    token_contract: invoice.token_contract,
    official_token_contract: officialPaymentChain?.token_contract || null,
    recipient_address: invoice.recipient_address,
    store_name: store?.name || "JPYC Store",
    policy_urls: policySnapshot?.urls || null,
    policy_versions: policySnapshot?.versions || null,
    policy_hashes: policySnapshot?.hashes || null,
    public_payment_simulation_enabled: ENABLE_PUBLIC_PAYMENT_SIMULATION,
    payment_url: invoice.payment_url,
    pay_url: invoice.payment_url,
    customer_payment_mode: providerSummary.customer_payment_mode,
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
  const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId);
  if (!invoice) return jsonError(res, 404, "NOT_FOUND", "Invoice not found");
  const store = db.prepare(`SELECT * FROM stores WHERE id = ?`).get(invoice.store_id);
  let policySnapshot = null;
  try {
    policySnapshot = invoice.policy_snapshot_json ? JSON.parse(invoice.policy_snapshot_json) : null;
  } catch (_error) {
    policySnapshot = null;
  }
  const policyGate = policySnapshot
    ? evaluatePolicySnapshot(policySnapshot)
    : {
        ok: false,
        values: {},
        versions: {},
        hashes: {},
        missing_keys: ["terms", "privacy", "refund"],
        missing_version_keys: ["terms_version", "privacy_version", "refund_policy_version"],
        missing_hash_keys: ["terms_hash", "privacy_hash", "refund_policy_hash"],
        content_verification_ok: false,
        snapshot_missing: true,
      };
  if (!policyGate.ok) {
    return jsonError(res, 503, "POLICY_CONFIGURATION_NOT_READY", "Published customer policy configuration is not ready", {
      missing_keys: policyGate.missing_keys,
      missing_version_keys: policyGate.missing_version_keys,
      missing_hash_keys: policyGate.missing_hash_keys,
      content_verification_ok: policyGate.content_verification_ok
        ?? policyGate.content_verification?.ok
        ?? false,
      snapshot_missing: policyGate.snapshot_missing === true,
    });
  }
  const body = req.body || {};
  const versionSubmission = validatePolicyVersionSubmission(policyGate.versions, body);
  if (!versionSubmission.ok) {
    return jsonError(res, 409, "POLICY_VERSION_MISMATCH", "Submitted policy versions do not match the published versions", {
      missing_keys: versionSubmission.missing_keys,
      mismatch_keys: versionSubmission.mismatch_keys,
      unexpected_keys: versionSubmission.unexpected_keys,
    });
  }
  const termsVersion = policyGate.versions.terms_version;
  const privacyVersion = policyGate.versions.privacy_version;
  const refundPolicyVersion = policyGate.versions.refund_policy_version;
  const consentedAt = nowIso();
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
      terms_version: termsVersion,
      privacy_version: privacyVersion,
      refund_policy_version: refundPolicyVersion,
      policy_hashes: policyGate.hashes,
      consented_at: consentedAt,
    },
    ip: req.ip,
  });
  return res.json({ ok: true, recorded_at: consentedAt });
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
      path: redactUrlForLogs(req.originalUrl || req.path),
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
  const onListening = () => {
    console.log(`JPYC production server started on ${APP_HOST} (port ${PORT})`);
    console.log(`Bind host: ${APP_BIND_HOST || "runtime default"}`);
    console.log(`DB path: ${DB_PATH}`);
  };
  serverInstance = APP_BIND_HOST
    ? app.listen(PORT, APP_BIND_HOST, onListening)
    : app.listen(PORT, onListening);
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
