#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildWalletLaunchPayload } from "../../src/wallet-adapter.mjs";
import {
  OFFICIAL_JPYC_CONTRACT_ADDRESS,
  parseEnabledPaymentChainIds,
  getSupportedPaymentChain,
  validateOfficialJpycContract,
} from "../../src/jpyc-contract-policy.mjs";
import {
  fetchPinnedPublicHttps,
  validatePublicHttpsUrl,
} from "../../src/public-endpoint-security.mjs";
import {
  convertBaseUnitsBetweenDecimals,
  parseDecimalToBaseUnits,
  scaleToDecimals,
} from "../../src/amounts.mjs";
import {
  APPROVED_LEDGER_BASE_UNIT_SCALE,
  APPROVED_TOKEN_DECIMALS,
  tokenMetadataPolicyFromEnv,
  verifyRpcTokenMetadataEndpoints,
} from "../../src/token-metadata.mjs";
import {
  DEPLOYMENT_TOPOLOGY_VALUES,
  DEPLOYMENT_TOPOLOGY_LOCAL_STORE_TERMINAL,
  evaluateLocalStoreTerminalIngestOrigin,
  evaluateLocalStoreTerminalListener,
  isLoopbackBindHost,
  isLoopbackHost,
  resolvePublicPolicyOrigin,
} from "../../src/deployment-topology.mjs";

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.split("=", 2);
    if (inlineValue != null) {
      args.set(key.slice(2), inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key.slice(2), next);
      i += 1;
      continue;
    }
    args.set(key.slice(2), "true");
  }
  return args;
}

function loadEnvFile(envFilePath) {
  const values = {};
  if (!envFilePath) return values;
  const raw = fs.readFileSync(envFilePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

const LOCAL_TOPOLOGY_DISABLED_CONTROLS = Object.freeze([
  ["ENABLE_PUBLIC_PAYMENT_SIMULATION", "enable_public_payment_simulation"],
  ["DEMO_CONTROLS_ENABLED", "demo_controls"],
  ["ALLOW_MANUAL_PAYMENT_INGEST", "manual_payment_ingest"],
  ["ENABLE_PROVIDER_RAIL_MOCK", "provider_rail_mock"],
  ["DIAGNOSTIC_MODE_ENABLED", "diagnostic_mode"],
]);

function boolFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isLoopbackHttpOrigin(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:"
      && isLoopbackHost(parsed.hostname)
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function isPublicHttpsOriginOnly(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && parsed.port === ""
      && parsed.hostname.includes(".")
      && !isLoopbackHost(parsed.hostname)
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function approvedRefPresent(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  return !["placeholder", "todo", "changeme", "change-me", "example", "sample", "draft"]
    .some((word) => normalized.toLowerCase().includes(word));
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function ensure(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function toSummary(status, checks, extra = {}) {
  return {
    ok: status === "ok",
    status,
    generated_at: new Date().toISOString(),
    checks,
    ...extra,
  };
}

async function rpcRequest(url, method, params, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = JSON.stringify({
        jsonrpc: "2.0",
        id: `${method}-${Date.now()}`,
        method,
        params,
      });
    const response = url.startsWith("https:")
      ? await fetchPinnedPublicHttps(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          timeoutMs,
        })
      : await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
          redirect: "error",
        }).then(async (raw) => ({ status: raw.status, body: await raw.text() }));
    const payload = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    if (response.status < 200 || response.status >= 300) throw new Error(`http_${response.status}`);
    if (payload.error) {
      throw new Error(payload.error.message || "rpc_error");
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeRpcUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}/[redacted]`;
  } catch {
    return "[invalid-rpc-url]";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = args.get("env-file") ? path.resolve(process.cwd(), args.get("env-file")) : null;
  const allowEmpty = boolFlag(args.get("allow-empty"));
  const skipRpc = boolFlag(args.get("skip-rpc"));
  const expectedAppEnv = String(args.get("app-env") || process.env.APP_ENV || "production").trim().toLowerCase();
  const fileEnv = loadEnvFile(envFile);
  const env = { ...fileEnv, ...process.env };
  const checks = [];

  function record(name, ok, details = {}) {
    checks.push({ name, ok, ...details });
  }

  try {
    const appEnv = String(env.APP_ENV || expectedAppEnv).trim().toLowerCase();
    const deploymentStage = String(env.DEPLOYMENT_STAGE || "").trim().toLowerCase();
    const productionChecks = appEnv === "production"
      || ["pilot", "commercial"].includes(deploymentStage)
      || boolFlag(env.COMMERCIAL_GO_MODE);
    const deploymentTopologyRaw = String(
      args.get("deployment-topology")
      || env.DEPLOYMENT_TOPOLOGY
      || "public_cloud"
    ).trim().toLowerCase();
    ensure(DEPLOYMENT_TOPOLOGY_VALUES.includes(deploymentTopologyRaw),
      "DEPLOYMENT_TOPOLOGY must be public_cloud or local_store_terminal",
      { actual: deploymentTopologyRaw });
    const localStoreTerminal = deploymentTopologyRaw === DEPLOYMENT_TOPOLOGY_LOCAL_STORE_TERMINAL;
    record("deployment_topology", true, { value: deploymentTopologyRaw });
    // PUBLIC_POLICY_ORIGIN is the official policy/Site origin key for the
    // local topology; PUBLIC_BASE_URL stays valid as a compatible fallback.
    const resolvedLocalPolicyOrigin = localStoreTerminal
      ? resolvePublicPolicyOrigin(env)?.origin || ""
      : "";
    const publicBaseUrl = String((localStoreTerminal
      ? resolvedLocalPolicyOrigin
      : env.PUBLIC_BASE_URL || env.APP_HOST || env.PAY_BASE_URL) || "").trim();
    const appHost = String((localStoreTerminal
      ? env.APP_HOST
      : env.APP_HOST || env.PUBLIC_BASE_URL || env.PAY_BASE_URL
        || (productionChecks ? "" : "http://127.0.0.1:4173")) || "").trim();
    const payBaseUrl = String((localStoreTerminal
      ? env.PAY_BASE_URL
      : env.PAY_BASE_URL || env.APP_HOST || env.PUBLIC_BASE_URL || appHost) || "").trim();
    const dbPath = String(env.DB_PATH || "").trim();
    const workerStateDbPath = String(env.WORKER_STATE_DB_PATH || "").trim();
    const corsOrigins = String(env.CORS_ALLOW_ORIGINS || "")
      .split(",")
      .map((value) => localStoreTerminal ? value.trim() : value.trim().replace(/\/$/, ""))
      .filter(Boolean);
    const chainId = String(env.CHAIN_ID || "137").trim();
    const enabledChainIds = parseEnabledPaymentChainIds(env.ENABLED_PAYMENT_CHAIN_IDS || "1,43114,137");
    const tokenContract = normalizeAddress(env.TOKEN_CONTRACT);
    const approvedTokenContract = normalizeAddress(env.APPROVED_JPYC_TOKEN_CONTRACT);
    const tokenDecimals = Number(env.TOKEN_DECIMALS || APPROVED_TOKEN_DECIMALS);
    const ledgerBaseUnitScale = String(env.LEDGER_BASE_UNIT_SCALE || env.JPYC_BASE_UNIT_SCALE || APPROVED_LEDGER_BASE_UNIT_SCALE).trim();
    const configuredLedgerDecimals = env.LEDGER_DECIMALS == null || String(env.LEDGER_DECIMALS).trim() === ""
      ? null
      : Number(env.LEDGER_DECIMALS);
    let ledgerDecimals = null;
    try {
      ledgerDecimals = scaleToDecimals(ledgerBaseUnitScale);
    } catch (_error) {
      ensure(false, "LEDGER_BASE_UNIT_SCALE must be a positive power of 10", { value: ledgerBaseUnitScale });
    }
    if (configuredLedgerDecimals != null) {
      ensure(Number.isInteger(configuredLedgerDecimals) && configuredLedgerDecimals === ledgerDecimals,
        "LEDGER_DECIMALS must match LEDGER_BASE_UNIT_SCALE",
        { ledger_decimals: configuredLedgerDecimals, scale_decimals: ledgerDecimals });
    }
    const rpcUrls = String(env[`RPC_URLS_${chainId}`] || env.RPC_URLS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const trustProxy = boolFlag(env.TRUST_PROXY);
    const trustProxyHops = String(env.TRUST_PROXY_HOPS || "").trim();
    const trustProxyCidrs = String(env.TRUST_PROXY_CIDRS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    record("app_env", appEnv === expectedAppEnv, {
      expected: expectedAppEnv,
      actual: appEnv,
    });

    if (productionChecks && !allowEmpty && !localStoreTerminal) {
      ensure(String(env.APP_BIND_HOST || "").trim(), "APP_BIND_HOST must be explicit for production", {});
      record("app_bind_host_explicit", true, { value: String(env.APP_BIND_HOST).trim() });
      ensure(trustProxy && (/^\d+$/.test(trustProxyHops) || trustProxyCidrs.length > 0),
        "production TRUST_PROXY requires TRUST_PROXY_HOPS or TRUST_PROXY_CIDRS",
        { trust_proxy_hops: trustProxyHops || null, trust_proxy_cidrs: trustProxyCidrs });
      record("trusted_proxy_boundary", true, {
        hops: trustProxyHops || null,
        cidrs: trustProxyCidrs,
      });
    } else {
      record("app_bind_host_explicit", true, { skipped: true, reason: "allow-empty" });
      record("trusted_proxy_boundary", true, { skipped: true, reason: "allow-empty" });
    }

    if (localStoreTerminal) {
      // Structural local_store_terminal requirements run even with
      // --allow-empty: they define the exposure boundary of the terminal.
      const bindHost = String(env.APP_BIND_HOST || "").trim();
      ensure(isLoopbackBindHost(bindHost),
        "local_store_terminal requires APP_BIND_HOST to be a loopback address (127.0.0.1, ::1, or localhost)",
        { value: bindHost || null });
      record("topology_local_loopback_bind", true, { value: bindHost });

      ensure(isPublicHttpsOriginOnly(publicBaseUrl),
        "local_store_terminal requires PUBLIC_POLICY_ORIGIN as an origin-only public HTTPS policy/Site origin (PUBLIC_BASE_URL stays accepted as a fallback)",
        { value: publicBaseUrl || null });
      record("topology_local_public_policy_origin", true, { value: publicBaseUrl });

      const fallbackPolicyOrigin = String(env.PUBLIC_BASE_URL || "").trim();
      if (fallbackPolicyOrigin) {
        ensure(isPublicHttpsOriginOnly(fallbackPolicyOrigin)
          && new URL(fallbackPolicyOrigin).origin === new URL(publicBaseUrl).origin,
          "local_store_terminal PUBLIC_BASE_URL must match the resolved PUBLIC_POLICY_ORIGIN", {});
      }

      // The signed public payment page is structurally absent in this
      // topology; the flag must be explicitly false (fail closed).
      const publicPaymentPageEnabledRaw = String(env.PUBLIC_PAYMENT_PAGE_ENABLED ?? "").trim().toLowerCase();
  ensure(publicPaymentPageEnabledRaw === "false",
        "local_store_terminal requires PUBLIC_PAYMENT_PAGE_ENABLED=false",
        { value: publicPaymentPageEnabledRaw || null });
      record("topology_local_public_payment_page_disabled", true, {});

      for (const [name, raw] of [["APP_HOST", appHost], ["PAY_BASE_URL", payBaseUrl]]) {
        ensure(isLoopbackHttpOrigin(raw),
          `local_store_terminal requires ${name} to be an explicit loopback http://127.0.0.1 origin`,
          { value: raw || null });
      }
      const loopbackOrigin = new URL(appHost).origin;
      ensure(loopbackOrigin === new URL(payBaseUrl).origin,
        "local_store_terminal requires APP_HOST and PAY_BASE_URL to use the same loopback origin", {});
      ensure(loopbackOrigin !== new URL(publicBaseUrl).origin,
        "local_store_terminal requires the loopback app origin to differ from PUBLIC_BASE_URL", {});
      record("topology_local_no_public_payment_origin", true, { value: loopbackOrigin });

      const listener = evaluateLocalStoreTerminalListener(env);
      ensure(listener.ok, "local_store_terminal origins must match APP_BIND_HOST and APP_PORT", { blockers: listener.blockers });
      record("topology_local_listener_origin_match", true, {});

      const localIngest = evaluateLocalStoreTerminalIngestOrigin(env);
      ensure(localIngest.ok, "local_store_terminal INTERNAL_APP_ORIGIN must be a loopback HTTP origin matching APP_HOST", {
        blockers: localIngest.blockers,
      });
      record("topology_local_internal_app_origin", true, { value: new URL(env.INTERNAL_APP_ORIGIN).origin });

      ensure(!trustProxy && !trustProxyHops && trustProxyCidrs.length === 0,
        "local_store_terminal serves the loopback listener directly; TRUST_PROXY/TRUST_PROXY_HOPS/TRUST_PROXY_CIDRS must stay disabled",
        { trust_proxy: trustProxy, hops: trustProxyHops || null, cidrs: trustProxyCidrs });
      record("topology_local_direct_loopback_no_trusted_proxy", true, {});

      for (const [envKey, label] of LOCAL_TOPOLOGY_DISABLED_CONTROLS) {
        ensure(!boolFlag(env[envKey]),
          `local_store_terminal requires ${envKey}=false`,
          { flag: envKey, value: boolFlag(env[envKey]) });
        record(`topology_local_${label}_disabled`, true, {});
      }

      const walletAdapterType = String(env.WALLET_ADAPTER_TYPE || "mock").trim().toLowerCase();
      ensure(["wallet_deeplink", "hashport_deeplink"].includes(walletAdapterType),
        "local_store_terminal requires WALLET_ADAPTER_TYPE=wallet_deeplink or hashport_deeplink",
        { actual: walletAdapterType });

      const configuredRecipient = normalizeAddress(env.RECIPIENT_ADDRESS);
      ensure(/^0x[0-9a-f]{40}$/.test(configuredRecipient) && configuredRecipient !== `0x${"0".repeat(40)}`,
        "local_store_terminal requires an explicitly approved RECIPIENT_ADDRESS", {});
      record("topology_local_recipient_approval_input", true, { value: configuredRecipient });

      ensure(chainId === "137", "local_store_terminal requires CHAIN_ID=137", { actual: chainId });
      ensure(enabledChainIds.length === 1 && enabledChainIds.includes("137"),
        "local_store_terminal requires ENABLED_PAYMENT_CHAIN_IDS to enable only 137",
        { enabled_chain_ids: enabledChainIds });

      const chainRpcConfigured = String(env.RPC_URLS_137 || env.RPC_URLS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean).length > 0;
      ensure(chainRpcConfigured, "local_store_terminal requires RPC_URLS_137 (or RPC_URLS) endpoints", {});
      record("topology_local_chain_rpc_configured", true, {});

      ensure(String(env.BACKUP_DIR || "").trim(), "local_store_terminal requires BACKUP_DIR for local backup separation", {});
      record("topology_local_backup_dir", true, { value: String(env.BACKUP_DIR).trim() });

      ensure(workerStateDbPath,
        "local_store_terminal requires WORKER_STATE_DB_PATH for worker separation", {});
      if (workerStateDbPath && dbPath) {
        ensure(path.resolve(process.cwd(), workerStateDbPath) !== path.resolve(process.cwd(), dbPath),
          "WORKER_STATE_DB_PATH must differ from DB_PATH", {});
      }
      record("topology_local_worker_state_db_separation", true, {
        db_path: dbPath || null,
        worker_state_db_path: workerStateDbPath || null,
      });

      const macReadinessRef = String(env.LOCAL_TERMINAL_OPERATOR_READINESS_REF || "").trim();
      ensure(approvedRefPresent(macReadinessRef),
        "local_store_terminal requires LOCAL_TERMINAL_OPERATOR_READINESS_REF referencing the completed Mac operational readiness checklist", {});
      record("topology_local_mac_readiness_reference", true, { reference_configured: true });
    }

    if (productionChecks && !allowEmpty) {
      ensure(dbPath, "DB_PATH must be explicit for production", {});
      ensure(workerStateDbPath, "WORKER_STATE_DB_PATH must be explicit for production", {});
      ensure(
        path.resolve(process.cwd(), dbPath) !== path.resolve(process.cwd(), workerStateDbPath),
        "WORKER_STATE_DB_PATH must differ from DB_PATH",
        { db_path: dbPath, worker_state_db_path: workerStateDbPath },
      );
      record("financial_worker_state_db_separation", true, {
        db_path: dbPath,
        worker_state_db_path: workerStateDbPath,
      });
    } else {
      record("financial_worker_state_db_separation", true, { skipped: true, reason: "allow-empty-or-non-production" });
    }

    const paymentChain = getSupportedPaymentChain(chainId);
    ensure(paymentChain && enabledChainIds.includes(chainId), "CHAIN_ID must be an enabled JPYC chain (1, 43114, or 137)", {
      actual: chainId,
      enabled_chain_ids: enabledChainIds,
    });
    record("payment_chain_enabled", true, { value: chainId, network: paymentChain.network });

    ensure(tokenDecimals === APPROVED_TOKEN_DECIMALS, "TOKEN_DECIMALS must match the approved JPYC token decimals", {
      expected: APPROVED_TOKEN_DECIMALS,
      actual: tokenDecimals,
    });
    ensure(ledgerBaseUnitScale === APPROVED_LEDGER_BASE_UNIT_SCALE, "LEDGER_BASE_UNIT_SCALE must remain the approved ledger scale", {
      expected: APPROVED_LEDGER_BASE_UNIT_SCALE,
      actual: ledgerBaseUnitScale,
    });
    record("token_ledger_amount_contract", true, {
      token_decimals: tokenDecimals,
      ledger_base_unit_scale: ledgerBaseUnitScale,
      ledger_decimals: ledgerDecimals,
    });

    ensure(validateOfficialJpycContract(tokenContract, "TOKEN_CONTRACT").ok, "TOKEN_CONTRACT must be the official funds-transfer JPYC contract", {
      token_contract: tokenContract,
      expected: OFFICIAL_JPYC_CONTRACT_ADDRESS,
    });

    const approvedTokenName = String(env.APPROVED_TOKEN_NAME || "").trim();
    const approvedTokenCodeHash = String(env.APPROVED_TOKEN_CODE_HASH || "").trim().toLowerCase();
    const approvedImplementationCodeHash = String(env.APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH || "").trim().toLowerCase();
    if (productionChecks && !allowEmpty) {
      ensure(approvedTokenName, "APPROVED_TOKEN_NAME is required for production metadata verification", {});
      ensure(/^0x[0-9a-f]{64}$/.test(approvedTokenCodeHash),
        "APPROVED_TOKEN_CODE_HASH must be a 32-byte code hash for production metadata verification", {});
      ensure(/^0x[0-9a-f]{64}$/.test(approvedImplementationCodeHash),
        "APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH must be a 32-byte proxy implementation hash for production metadata verification", {});
      record("token_metadata_approval_pins", true, {
        token_name: approvedTokenName,
        token_code_hash: approvedTokenCodeHash,
        implementation_code_hash: approvedImplementationCodeHash,
      });
    } else {
      record("token_metadata_approval_pins", true, { skipped: true, reason: "allow-empty" });
    }

    if (approvedTokenContract) {
      ensure(tokenContract === approvedTokenContract, "TOKEN_CONTRACT must match APPROVED_JPYC_TOKEN_CONTRACT", {
        token_contract: tokenContract,
        approved_jpyc_token_contract: approvedTokenContract,
      });
      record("token_contract_fixed", true, { token_contract: tokenContract });
    } else {
      ensure(!productionChecks || allowEmpty, "APPROVED_JPYC_TOKEN_CONTRACT is required for production drift checks");
      record("token_contract_fixed", true, { skipped: true, reason: "approved_token_not_configured" });
    }

    if (localStoreTerminal) {
      // Public-origin requirements are replaced by the loopback topology
      // checks recorded above; the policy origin was already validated.
      record("app_host_https_fqdn", true, { skipped: true, reason: "local_store_terminal_loopback" });
      record("public_base_url_https_fqdn", true, { value: publicBaseUrl });
      record("pay_base_url_https_fqdn", true, { skipped: true, reason: "local_store_terminal_loopback" });
      record("public_origins_match", true, { skipped: true, reason: "local_store_terminal_separated_origins" });
    } else if (productionChecks && (!allowEmpty || appHost)) {
      const parsed = new URL(appHost);
      ensure(parsed.protocol === "https:", "APP_HOST must use https", { value: appHost });
      ensure(!/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname), "APP_HOST must use a public FQDN", { hostname: parsed.hostname });
      record("app_host_https_fqdn", true, { value: appHost });
    } else {
      record("app_host_https_fqdn", true, { skipped: true, reason: "allow-empty" });
    }

    if (!localStoreTerminal && productionChecks && (!allowEmpty || publicBaseUrl)) {
      const parsed = new URL(publicBaseUrl);
      ensure(parsed.protocol === "https:", "PUBLIC_BASE_URL must use https", { value: publicBaseUrl });
      ensure(!/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname), "PUBLIC_BASE_URL must use a public FQDN", { hostname: parsed.hostname });
      record("public_base_url_https_fqdn", true, { value: publicBaseUrl });
    } else if (!localStoreTerminal) {
      record("public_base_url_https_fqdn", true, { skipped: true, reason: "allow-empty" });
    }

    if (!localStoreTerminal && productionChecks && (!allowEmpty || payBaseUrl)) {
      const parsed = new URL(payBaseUrl);
      ensure(parsed.protocol === "https:", "PAY_BASE_URL must use https", { value: payBaseUrl });
      ensure(!/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname), "PAY_BASE_URL must use a public FQDN", { hostname: parsed.hostname });
      record("pay_base_url_https_fqdn", true, { value: payBaseUrl });
    } else if (!localStoreTerminal) {
      record("pay_base_url_https_fqdn", true, { skipped: true, reason: "allow-empty" });
    }

    if (!localStoreTerminal && productionChecks && appHost && publicBaseUrl && payBaseUrl) {
      const normalizedOrigins = [appHost, publicBaseUrl, payBaseUrl].map((value) => new URL(value).toString().replace(/\/$/, ""));
      ensure(new Set(normalizedOrigins).size === 1, "APP_HOST, PUBLIC_BASE_URL, and PAY_BASE_URL must match exactly", {
        app_host: appHost,
        public_base_url: publicBaseUrl,
        pay_base_url: payBaseUrl,
      });
      record("public_origins_match", true, { value: normalizedOrigins[0] });
    } else if (!localStoreTerminal) {
      record("public_origins_match", true, { skipped: true, reason: "allow-empty" });
    }

    if (localStoreTerminal || (productionChecks && (!allowEmpty || corsOrigins.length > 0))) {
      ensure(corsOrigins.length > 0, "CORS_ALLOW_ORIGINS must not be empty", {});
      ensure(!corsOrigins.some((origin) => origin === "*" || origin.includes("*")), "CORS_ALLOW_ORIGINS wildcard is not allowed", {
        cors_allow_origins: corsOrigins,
      });
      const appOrigin = new URL(appHost).toString().replace(/\/$/, "");
      ensure(corsOrigins.includes(appOrigin), "CORS_ALLOW_ORIGINS must include APP_HOST", {
        app_host: appOrigin,
        cors_allow_origins: corsOrigins,
      });
      record("cors_origins_include_app_host", true, { cors_allow_origins: corsOrigins });
    } else if (!localStoreTerminal) {
      record("cors_origins_include_app_host", true, { skipped: true, reason: "allow-empty" });
    }

    const oneJpyLedgerBase = parseDecimalToBaseUnits("1", ledgerDecimals);
    const oneJpyTokenAtomic = convertBaseUnitsBetweenDecimals(oneJpyLedgerBase, ledgerDecimals, tokenDecimals);
    ensure(oneJpyTokenAtomic.exact, "1 JPYC ledger amount must convert exactly to token atomic units", {
      ledger_base_amount: oneJpyLedgerBase,
      ledger_decimals: ledgerDecimals,
      token_decimals: tokenDecimals,
    });
    const deeplinkPayload = buildWalletLaunchPayload({
      env,
      chainId,
      network: paymentChain.network,
      tokenSymbol: "JPYC",
      tokenContract: tokenContract || OFFICIAL_JPYC_CONTRACT_ADDRESS,
      tokenDecimals,
      receiveAddress: String(env.RECIPIENT_ADDRESS || (localStoreTerminal ? "" : "0x2222222222222222222222222222222222222222")),
      expectedAmountAtomic: oneJpyTokenAtomic.value,
      amountJpy: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      payUrl: localStoreTerminal ? appHost : publicBaseUrl || "https://pay.miyamibu.xyz/pay?ref=test",
    });
    ensure(deeplinkPayload.network === paymentChain.network, "wallet payload network must match CHAIN_ID", {
      network: deeplinkPayload.network,
    });
    record("wallet_payload_chain", true, {
      network: deeplinkPayload.network,
      payment_uri: deeplinkPayload.payment_uri,
      expected_amount_atomic: oneJpyTokenAtomic.value,
    });

    if (localStoreTerminal) {
      const paymentUri = String(deeplinkPayload.payment_uri || "");
      let uriParams = null;
      try {
        const match = paymentUri.match(/^ethereum:[^@]+@(\d+)\/transfer\?(.*)$/);
        if (match) uriParams = { chainId: match[1], searchParams: new URLSearchParams(match[2]) };
      } catch (_error) {
        uriParams = null;
      }
      ensure(Boolean(uriParams), "local_store_terminal wallet payload must be an EIP-681 ERC-20 transfer URI", {
        payment_uri_prefix: paymentUri.split("?")[0] || null,
      });
      ensure(uriParams.chainId === "137", "local_store_terminal wallet transfer QR must target chain 137", {
        chain_id: uriParams?.chainId || null,
      });
      ensure((uriParams.searchParams.get("address") || "").toLowerCase() === normalizeAddress(env.RECIPIENT_ADDRESS),
        "local_store_terminal wallet transfer QR must pay the configured approved recipient", {});
      ensure(uriParams.searchParams.get("uint256") === oneJpyTokenAtomic.value,
        "local_store_terminal wallet transfer QR must carry the exact invoice amount in atomic units", {
          expected_amount_atomic: oneJpyTokenAtomic.value,
        });
      record("local_topology_wallet_transfer_qr_exactness", true, {
        chain_id: 137,
        recipient_configured: true,
        expected_amount_atomic: oneJpyTokenAtomic.value,
      });
    }

    if (String(env.WALLET_DEEPLINK_TEMPLATE || env.HASHPORT_WALLET_DEEPLINK_TEMPLATE || "").trim()) {
      ensure(Boolean(deeplinkPayload.wallet_url), "wallet deeplink template must expand to a launch URL");
      record("wallet_deeplink_template", true, {
        wallet_url: deeplinkPayload.wallet_url,
      });
    } else {
      record("wallet_deeplink_template", true, { skipped: true, reason: "template_not_configured" });
    }

    const forbiddenSecretEnv = Object.entries(env)
      .filter(([key, value]) => /(?:private[_-]?key|seed|mnemonic|keystore)/i.test(key) && String(value || "").trim())
      .map(([key]) => key);
    ensure(forbiddenSecretEnv.length === 0, "forbidden signing secret env vars are present", { keys: forbiddenSecretEnv });
    record("forbidden_secret_env_absent", true);

    if (skipRpc) {
      ensure(!productionChecks || allowEmpty, "--skip-rpc is not allowed for non-template production validation", {});
      record("rpc_reachability", true, { skipped: true, reason: "skip-rpc" });
      record("rpc_token_metadata", true, { skipped: true, reason: "skip-rpc" });
    } else {
      if (!productionChecks && rpcUrls.length === 0) {
        record("rpc_reachability", true, { skipped: true, reason: "rpc_not_configured_non_production" });
        record("rpc_token_metadata", true, { skipped: true, reason: "rpc_not_configured_non_production" });
      } else {
        ensure(rpcUrls.length > 0, "RPC_URLS must not be empty", {});
        for (const rpcUrl of rpcUrls) {
          const rpcUrlValidation = validatePublicHttpsUrl(rpcUrl);
          if (productionChecks) {
            ensure(rpcUrlValidation.ok, "production RPC_URLS must be public HTTPS endpoints on port 443", {
              rpc_url: sanitizeRpcUrl(rpcUrl),
              errors: rpcUrlValidation.errors,
            });
          }
        }
        const rpcMetadata = await verifyRpcTokenMetadataEndpoints({
          rpcUrls,
          rpcRequest,
          policy: tokenMetadataPolicyFromEnv({
            ...env,
            CHAIN_ID: chainId,
            TOKEN_CONTRACT: tokenContract,
            TOKEN_DECIMALS: String(tokenDecimals),
            REQUIRE_TOKEN_METADATA_PINS: productionChecks && !allowEmpty ? "true" : "false",
          }),
        });
        ensure(rpcMetadata.ok, "RPC token metadata validation failed; quarantined endpoints cannot be used", {
          configured_count: rpcMetadata.configured_count,
          verified_count: rpcMetadata.verified_count,
          quarantined_count: rpcMetadata.quarantined_count,
          endpoints: rpcMetadata.endpoints,
        });
        record("rpc_reachability", true, {
          configured_count: rpcMetadata.configured_count,
          verified_count: rpcMetadata.verified_count,
        });
        record("rpc_token_metadata", true, {
          configured_count: rpcMetadata.configured_count,
          verified_count: rpcMetadata.verified_count,
          endpoints: rpcMetadata.endpoints,
        });
      }
    }

    console.log(JSON.stringify(toSummary("ok", checks, { env_file: envFile }), null, 2));
  } catch (error) {
    const failedCheck = {
      name: "production_config_validation",
      ok: false,
      message: String(error.message || error),
      details: error.details || {},
    };
    checks.push(failedCheck);
    console.log(JSON.stringify(toSummary("error", checks, { env_file: envFile }), null, 2));
    process.exit(1);
  }
}

main();
