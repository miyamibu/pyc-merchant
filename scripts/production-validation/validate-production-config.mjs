#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildWalletLaunchPayload } from "../../src/wallet-adapter.mjs";
import { parseEnabledPaymentChainIds } from "../../src/jpyc-contract-policy.mjs";

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

function boolFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

const PLACEHOLDER_WORDS = [
  "example.com",
  "localhost",
  "127.0.0.1",
  "placeholder",
  "draft",
  "dev-",
  "todo",
  "tbd",
  "replace",
  "replace_with",
];

function isPlaceholderLike(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return true;
  return PLACEHOLDER_WORDS.some((word) => raw.includes(word));
}

function isPublicApprovedHttpsUrl(value) {
  if (isPlaceholderLike(value)) return false;
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && !isPlaceholderLike(parsed.hostname);
  } catch (_error) {
    return false;
  }
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
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${method}-${Date.now()}`,
        method,
        params,
      }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    if (payload.error) {
      throw new Error(payload.error.message || "rpc_error");
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
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
	    const productionChecks = appEnv === "production";
	    const policyConfigRequired =
	      productionChecks
	      || boolFlag(env.COMMERCIAL_GO_MODE)
	      || boolFlag(env.LIMITED_PILOT_MODE)
	      || boolFlag(args.get("require-policy-config"));
    const publicBaseUrl = String(env.PUBLIC_BASE_URL || env.APP_HOST || env.PAY_BASE_URL || "").trim();
    const appHost = String(env.APP_HOST || env.PUBLIC_BASE_URL || env.PAY_BASE_URL || (productionChecks ? "" : "http://127.0.0.1:4173")).trim();
	    const payBaseUrl = String(env.PAY_BASE_URL || env.APP_HOST || env.PUBLIC_BASE_URL || appHost).trim();
	    const internalApiBaseUrl = String(env.INTERNAL_API_BASE_URL || (productionChecks ? "" : appHost)).trim();
    const corsOrigins = String(env.CORS_ALLOW_ORIGINS || "")
      .split(",")
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean);
	    const chainId = String(env.CHAIN_ID || "137").trim();
    const enabledChainIds = parseEnabledPaymentChainIds(env.ENABLED_PAYMENT_CHAIN_IDS || "137");
	    const tokenContract = normalizeAddress(env.TOKEN_CONTRACT);
    const approvedTokenContract = normalizeAddress(env.APPROVED_JPYC_TOKEN_CONTRACT);
    const officialJpycContract = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";
    const supportedChainIds = new Set(["1", "43114", "137"]);
    const rpcUrls = String(env.RPC_URLS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    record("app_env", appEnv === expectedAppEnv, {
      expected: expectedAppEnv,
      actual: appEnv,
    });

	    ensure(supportedChainIds.has(chainId), "CHAIN_ID must be one of 1, 43114, 137", { actual: chainId });
	    record("chain_id_supported_jpyc", true, { value: chainId });
    ensure(enabledChainIds.includes(chainId), "CHAIN_ID must be included in ENABLED_PAYMENT_CHAIN_IDS", {
      chain_id: chainId,
      enabled_chain_ids: enabledChainIds,
    });
    ensure(enabledChainIds.every((id) => supportedChainIds.has(id)), "ENABLED_PAYMENT_CHAIN_IDS must only contain supported JPYC chain IDs", {
      enabled_chain_ids: enabledChainIds,
    });
    record("enabled_payment_chain_allowlist", true, { enabled_chain_ids: enabledChainIds });

    if (approvedTokenContract) {
      ensure(tokenContract === officialJpycContract, "TOKEN_CONTRACT must match official funds-transfer JPYC contract", {
        token_contract: tokenContract,
        official_jpyc_contract: officialJpycContract,
      });
      ensure(approvedTokenContract === officialJpycContract, "APPROVED_JPYC_TOKEN_CONTRACT must match official funds-transfer JPYC contract", {
        token_contract: tokenContract,
        approved_jpyc_token_contract: approvedTokenContract,
      });
      record("token_contract_fixed", true, { token_contract: tokenContract });
    } else {
      ensure(!productionChecks || allowEmpty, "APPROVED_JPYC_TOKEN_CONTRACT is required for production drift checks");
      record("token_contract_fixed", true, { skipped: true, reason: "approved_token_not_configured" });
    }

    if (productionChecks) {
      ensure(Number(env.TOKEN_DECIMALS || "18") === 18, "TOKEN_DECIMALS must be 18 for production/commercial JPYC transfers", {
        token_decimals: env.TOKEN_DECIMALS || "",
      });
      ensure(String(env.JPYC_BASE_UNIT_SCALE || "1000000") === "1000000", "JPYC_BASE_UNIT_SCALE must be 1000000 for app accounting scale", {
        jpyc_base_unit_scale: env.JPYC_BASE_UNIT_SCALE || "",
      });
      record("token_decimals_and_app_scale", true, { token_decimals: 18, jpyc_base_unit_scale: "1000000" });
    } else {
      record("token_decimals_and_app_scale", true, { skipped: true, reason: "not production/commercial/limited" });
    }

    if (productionChecks && (!allowEmpty || appHost)) {
      ensure(isPublicApprovedHttpsUrl(appHost), "APP_HOST must use an approved public HTTPS FQDN", { value: appHost });
      record("app_host_https_fqdn", true, { value: appHost });
    } else {
      record("app_host_https_fqdn", true, { skipped: true, reason: "allow-empty" });
    }

    if (productionChecks && (!allowEmpty || publicBaseUrl)) {
      ensure(isPublicApprovedHttpsUrl(publicBaseUrl), "PUBLIC_BASE_URL must use an approved public HTTPS FQDN", { value: publicBaseUrl });
      record("public_base_url_https_fqdn", true, { value: publicBaseUrl });
    } else {
      record("public_base_url_https_fqdn", true, { skipped: true, reason: "allow-empty" });
    }

    if (productionChecks && (!allowEmpty || payBaseUrl)) {
      ensure(isPublicApprovedHttpsUrl(payBaseUrl), "PAY_BASE_URL must use an approved public HTTPS FQDN", { value: payBaseUrl });
      record("pay_base_url_https_fqdn", true, { value: payBaseUrl });
    } else {
      record("pay_base_url_https_fqdn", true, { skipped: true, reason: "allow-empty" });
    }

	    if (productionChecks && appHost && publicBaseUrl && payBaseUrl) {
      const normalizedOrigins = [appHost, publicBaseUrl, payBaseUrl].map((value) => new URL(value).toString().replace(/\/$/, ""));
      ensure(new Set(normalizedOrigins).size === 1, "APP_HOST, PUBLIC_BASE_URL, and PAY_BASE_URL must match exactly", {
        app_host: appHost,
        public_base_url: publicBaseUrl,
        pay_base_url: payBaseUrl,
      });
      record("public_origins_match", true, { value: normalizedOrigins[0] });
    } else {
      record("public_origins_match", true, { skipped: true, reason: "allow-empty" });
	    }
	    if (productionChecks && (!allowEmpty || internalApiBaseUrl)) {
	      const parsed = new URL(internalApiBaseUrl);
	      ensure(["http:", "https:"].includes(parsed.protocol), "INTERNAL_API_BASE_URL must be http(s)", { value: internalApiBaseUrl });
	      ensure(parsed.hostname !== new URL(appHost).hostname || parsed.protocol !== "https:", "INTERNAL_API_BASE_URL must be distinct from public APP_HOST", {
	        internal_api_base_url: internalApiBaseUrl,
	        app_host: appHost,
	      });
	      record("internal_api_base_url_configured", true, { value: internalApiBaseUrl });
	    } else {
	      record("internal_api_base_url_configured", true, { skipped: true, reason: "allow-empty" });
	    }
	    const publicLinkGraceSec = Number(env.PUBLIC_LINK_GRACE_SEC || "900");
	    ensure(Number.isInteger(publicLinkGraceSec) && publicLinkGraceSec >= 0 && publicLinkGraceSec <= 1800, "PUBLIC_LINK_GRACE_SEC must be <= 1800 for payment links", {
	      public_link_grace_sec: publicLinkGraceSec,
	    });
	    record("public_payment_link_grace_short", true, { public_link_grace_sec: publicLinkGraceSec });
	    if (policyConfigRequired) {
		      for (const key of ["TERMS_URL", "PRIVACY_URL", "REFUND_POLICY_URL"]) {
		        ensure(isPublicApprovedHttpsUrl(env[key]), `${key} must be an approved public HTTPS URL`, { value: env[key] || "" });
		      }
		      for (const key of ["TERMS_VERSION", "PRIVACY_VERSION", "REFUND_POLICY_VERSION"]) {
		        ensure(!isPlaceholderLike(env[key]), `${key} must be non-placeholder`, { value: env[key] || "" });
		      }
		      record("policy_config_public_and_versioned", true, { required: true });
		    } else {
		      record("policy_config_public_and_versioned", true, { skipped: true, reason: "not production/commercial/limited" });
		    }

    if (productionChecks && (!allowEmpty || corsOrigins.length > 0)) {
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
    } else {
      record("cors_origins_include_app_host", true, { skipped: true, reason: "allow-empty" });
    }

    const deeplinkPayload = buildWalletLaunchPayload({
      env,
      chainId: "137",
      network: "Polygon",
      tokenSymbol: "JPYC",
      tokenContract: tokenContract || "0x1111111111111111111111111111111111111111",
      tokenDecimals: Number(env.TOKEN_DECIMALS || "18"),
      receiveAddress: String(env.RECIPIENT_ADDRESS || "0x2222222222222222222222222222222222222222"),
      expectedAmountAtomic: "1000000",
      amountJpy: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      payUrl: publicBaseUrl || "https://pay.miyamibu.xyz/pay?ref=test",
    });
    ensure(deeplinkPayload.network === "Polygon", "wallet payload network must resolve to Polygon", {
      network: deeplinkPayload.network,
    });
    record("wallet_payload_polygon", true, {
      network: deeplinkPayload.network,
      payment_uri: deeplinkPayload.payment_uri,
    });

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
      record("rpc_reachability", true, { skipped: true, reason: "skip-rpc" });
    } else {
      if (!productionChecks && rpcUrls.length === 0) {
        record("rpc_reachability", true, { skipped: true, reason: "rpc_not_configured_non_production" });
      } else {
        ensure(rpcUrls.length > 0, "RPC_URLS must not be empty", {});
      const rpcChecks = [];
        for (const rpcUrl of rpcUrls) {
          const chainIdHex = String(await rpcRequest(rpcUrl, "eth_chainId", []));
          const rpcChainId = chainIdHex.startsWith("0x") ? BigInt(chainIdHex).toString() : chainIdHex;
          const blockHex = String(await rpcRequest(rpcUrl, "eth_blockNumber", []));
          const latestBlock = blockHex.startsWith("0x") ? Number(BigInt(blockHex)) : Number(blockHex);
          rpcChecks.push({ rpc_url: rpcUrl, chain_id: rpcChainId, latest_block: latestBlock });
          ensure(rpcChainId === "137", "RPC chainId drift detected", { rpc_url: rpcUrl, chain_id: rpcChainId });
        }
        record("rpc_reachability", true, { providers: rpcChecks });
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
