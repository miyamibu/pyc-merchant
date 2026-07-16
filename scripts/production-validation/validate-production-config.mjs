#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildWalletLaunchPayload } from "../../src/wallet-adapter.mjs";
import {
  fetchPinnedPublicHttps,
  validatePublicHttpsUrl,
} from "../../src/public-endpoint-security.mjs";

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
    const productionChecks = appEnv === "production";
    const publicBaseUrl = String(env.PUBLIC_BASE_URL || env.APP_HOST || env.PAY_BASE_URL || "").trim();
    const appHost = String(env.APP_HOST || env.PUBLIC_BASE_URL || env.PAY_BASE_URL || (productionChecks ? "" : "http://127.0.0.1:4173")).trim();
    const payBaseUrl = String(env.PAY_BASE_URL || env.APP_HOST || env.PUBLIC_BASE_URL || appHost).trim();
    const corsOrigins = String(env.CORS_ALLOW_ORIGINS || "")
      .split(",")
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean);
    const chainId = String(env.CHAIN_ID || "137").trim();
    const tokenContract = normalizeAddress(env.TOKEN_CONTRACT);
    const approvedTokenContract = normalizeAddress(env.APPROVED_JPYC_TOKEN_CONTRACT);
    const rpcUrls = String(env.RPC_URLS || "")
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

    if (productionChecks && !allowEmpty) {
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

    ensure(chainId === "137", "CHAIN_ID must be 137", { actual: chainId });
    record("chain_id_polygon", true, { value: chainId });

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

    if (productionChecks && (!allowEmpty || appHost)) {
      const parsed = new URL(appHost);
      ensure(parsed.protocol === "https:", "APP_HOST must use https", { value: appHost });
      ensure(!/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname), "APP_HOST must use a public FQDN", { hostname: parsed.hostname });
      record("app_host_https_fqdn", true, { value: appHost });
    } else {
      record("app_host_https_fqdn", true, { skipped: true, reason: "allow-empty" });
    }

    if (productionChecks && (!allowEmpty || publicBaseUrl)) {
      const parsed = new URL(publicBaseUrl);
      ensure(parsed.protocol === "https:", "PUBLIC_BASE_URL must use https", { value: publicBaseUrl });
      ensure(!/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname), "PUBLIC_BASE_URL must use a public FQDN", { hostname: parsed.hostname });
      record("public_base_url_https_fqdn", true, { value: publicBaseUrl });
    } else {
      record("public_base_url_https_fqdn", true, { skipped: true, reason: "allow-empty" });
    }

    if (productionChecks && (!allowEmpty || payBaseUrl)) {
      const parsed = new URL(payBaseUrl);
      ensure(parsed.protocol === "https:", "PAY_BASE_URL must use https", { value: payBaseUrl });
      ensure(!/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname), "PAY_BASE_URL must use a public FQDN", { hostname: parsed.hostname });
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
          const rpcUrlValidation = validatePublicHttpsUrl(rpcUrl);
          if (productionChecks) {
            ensure(rpcUrlValidation.ok, "production RPC_URLS must be public HTTPS endpoints on port 443", {
              rpc_url: sanitizeRpcUrl(rpcUrl),
              errors: rpcUrlValidation.errors,
            });
          }
          const chainIdHex = String(await rpcRequest(rpcUrl, "eth_chainId", []));
          const rpcChainId = chainIdHex.startsWith("0x") ? BigInt(chainIdHex).toString() : chainIdHex;
          const blockHex = String(await rpcRequest(rpcUrl, "eth_blockNumber", []));
          const latestBlock = blockHex.startsWith("0x") ? Number(BigInt(blockHex)) : Number(blockHex);
          rpcChecks.push({ rpc_url: sanitizeRpcUrl(rpcUrl), chain_id: rpcChainId, latest_block: latestBlock });
          ensure(rpcChainId === "137", "RPC chainId drift detected", { rpc_url: sanitizeRpcUrl(rpcUrl), chain_id: rpcChainId });
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
