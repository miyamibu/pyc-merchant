// Deployment topology policy.
//
// `public_cloud` is the historical default: the app is published behind a
// reverse proxy on a public HTTPS origin and customers resolve a signed
// `/pay?ref=...` payment page. All pre-existing requirements stay attached to
// this topology and must not be relaxed.
//
// `local_store_terminal` is additive: the terminal runs on an in-store Mac,
// binds to loopback only, never exposes a public customer payment page or a
// signed public payment URL, and shows the wallet transfer QR (EIP-681)
// generated from the invoice itself. Policy pages must point at the separate
// public Site origin configured via PUBLIC_POLICY_ORIGIN (official key;
// PUBLIC_BASE_URL remains accepted as a compatible fallback).

export const PUBLIC_PAYMENT_PAGE_ENABLED_DEFAULT = "true";

export const DEPLOYMENT_TOPOLOGY_PUBLIC_CLOUD = "public_cloud";
export const DEPLOYMENT_TOPOLOGY_LOCAL_STORE_TERMINAL = "local_store_terminal";
export const DEPLOYMENT_TOPOLOGY_VALUES = Object.freeze([
  DEPLOYMENT_TOPOLOGY_PUBLIC_CLOUD,
  DEPLOYMENT_TOPOLOGY_LOCAL_STORE_TERMINAL,
]);

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const LOOPBACK_BIND_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export function parseDeploymentTopology(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return DEPLOYMENT_TOPOLOGY_PUBLIC_CLOUD;
  return DEPLOYMENT_TOPOLOGY_VALUES.includes(normalized) ? normalized : null;
}

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTNAMES.has(String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, ""));
}

// Listener hosts are raw hostnames, not URL authorities. Bracketed IPv6
// must fail before Node attempts to resolve "[::1]" as a DNS hostname.
export function isLoopbackBindHost(hostname) {
  return LOOPBACK_BIND_HOSTNAMES.has(String(hostname || "").trim());
}

function isLoopbackHttpOrigin(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:"
      && isLoopbackHost(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

// All launchd jobs share this origin. A separate Docker service name or port
// cannot address the standalone Mac listener; canonical origins must match.
export function evaluateLocalStoreTerminalIngestOrigin(env = {}) {
  const blockers = [];
  const internalOrigin = String(env.INTERNAL_APP_ORIGIN || "").trim();
  if (!isLoopbackHttpOrigin(internalOrigin)) {
    blockers.push("topology_local_internal_app_origin_must_be_loopback_http_origin");
  } else if (isLoopbackHttpOrigin(env.APP_HOST)
    && new URL(internalOrigin).origin !== new URL(env.APP_HOST).origin) {
    blockers.push("topology_local_internal_app_origin_must_match_app_host");
  }
  return { ok: blockers.length === 0, blockers };
}

function parseFlag(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || "").trim());
}

function isPublicHttpsOriginOnly(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && parsed.port === ""
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash
      && !isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

// The official key for the public policy/Site origin is PUBLIC_POLICY_ORIGIN.
// PUBLIC_BASE_URL keeps working as a compatible fallback so existing local
// deployments and docs stay valid. Returns null when neither key holds an
// origin-only public HTTPS URL.
export function resolvePublicPolicyOrigin(env = {}) {
  const official = String(env.PUBLIC_POLICY_ORIGIN || "").trim();
  if (official) {
    return isPublicHttpsOriginOnly(official)
      ? { origin: new URL(official).origin, source: "PUBLIC_POLICY_ORIGIN" }
      : null;
  }
  const fallback = String(env.PUBLIC_BASE_URL || "").trim();
  if (fallback) {
    return isPublicHttpsOriginOnly(fallback)
      ? { origin: new URL(fallback).origin, source: "PUBLIC_BASE_URL" }
      : null;
  }
  return null;
}

function approvedRefPresent(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  const guardWords = ["placeholder", "todo", "changeme", "change-me", "example", "sample", "draft"];
  const lowered = normalized.toLowerCase();
  return !guardWords.some((word) => lowered.includes(word));
}

// Structural checks for the local store terminal topology. These run in
// addition to (never instead of) the existing production-like runtime gates.
// Returns blocker codes so callers decide how to fail closed.
export function evaluateLocalStoreTerminalTopology(env = {}) {
  const blockers = [];
  const bindHost = String(env.APP_BIND_HOST || "").trim();
  if (!isLoopbackBindHost(bindHost)) {
    blockers.push("topology_local_requires_loopback_bind_host");
    if (bindHost.includes("[") || bindHost.includes("]")) {
      blockers.push("topology_local_bind_host_must_be_unbracketed");
    }
  }

  const policyOrigin = resolvePublicPolicyOrigin(env);
  if (!policyOrigin) {
    blockers.push("topology_local_requires_public_policy_origin");
  }
  const publicBaseUrl = String(env.PUBLIC_BASE_URL || "").trim();
  if (policyOrigin && publicBaseUrl) {
    if (!isPublicHttpsOriginOnly(publicBaseUrl)
      || new URL(publicBaseUrl).origin !== policyOrigin.origin) {
      blockers.push("topology_local_public_base_url_policy_origin_mismatch");
    }
  }

  // The public customer payment page is structurally absent in this topology.
  // The flag must therefore be explicitly false: missing or truthy values fail
  // closed instead of silently inheriting the public_cloud default.
  if (String(env.PUBLIC_PAYMENT_PAGE_ENABLED ?? "").trim().toLowerCase() !== "false") {
    blockers.push("topology_local_requires_public_payment_page_disabled");
  }

  // The local topology has no public customer payment page. APP_HOST /
  // PAY_BASE_URL may only be explicit loopback origins; falling back to the
  // public Site origin would silently re-create signed public payment URLs.
  const appHost = String(env.APP_HOST || "").trim();
  const payBaseUrl = String(env.PAY_BASE_URL || "").trim();
  for (const [key, raw] of [["APP_HOST", appHost], ["PAY_BASE_URL", payBaseUrl]]) {
    if (!raw) {
      blockers.push(`topology_local_requires_explicit_${key.toLowerCase()}`);
      continue;
    }
    if (!isLoopbackHttpOrigin(raw)) {
      blockers.push(`topology_local_${key.toLowerCase()}_must_be_loopback_http_origin`);
    }
  }
  if (appHost && payBaseUrl) {
    try {
      if (new URL(appHost).origin !== new URL(payBaseUrl).origin) {
        blockers.push("topology_local_app_host_pay_base_url_mismatch");
      }
    } catch {
      // Invalid URLs are already reported above.
    }
  }
  blockers.push(...evaluateLocalStoreTerminalIngestOrigin(env).blockers);
  const corsOrigins = String(env.CORS_ALLOW_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (corsOrigins.some((origin) => origin.includes("*"))) {
    blockers.push("topology_local_cors_allow_origins_wildcard_not_allowed");
  }
  if (isLoopbackHttpOrigin(appHost) && !corsOrigins.includes(new URL(appHost).origin)) {
    blockers.push("topology_local_cors_allow_origins_must_include_app_host");
  }
  if (appHost && policyOrigin) {
    try {
      if (new URL(appHost).origin === new URL(policyOrigin.origin).origin) {
        blockers.push("topology_local_app_host_must_differ_from_public_policy_origin");
      }
    } catch {
      // Invalid URLs are already reported above.
    }
  }

  if (parseFlag(env.TRUST_PROXY, true) || String(env.TRUST_PROXY_HOPS || "").trim() || String(env.TRUST_PROXY_CIDRS || "").trim()) {
    blockers.push("topology_local_requires_direct_loopback_no_trusted_proxy");
  }

  const disabledControls = [
    ["ENABLE_PUBLIC_PAYMENT_SIMULATION", "enable_public_payment_simulation_disabled"],
    ["DEMO_CONTROLS_ENABLED", "demo_controls_disabled"],
    ["ALLOW_MANUAL_PAYMENT_INGEST", "manual_payment_ingest_disabled"],
    ["ENABLE_PROVIDER_RAIL_MOCK", "provider_rail_mock_disabled"],
  ];
  for (const [name, label] of disabledControls) {
    if (parseFlag(env[name], false)) {
      blockers.push(`topology_local_requires_${label}`);
    }
  }

  if (parseFlag(env.DIAGNOSTIC_MODE_ENABLED, false)) {
    blockers.push("topology_local_requires_diagnostic_mode_disabled");
  }

  const walletAdapterType = String(env.WALLET_ADAPTER_TYPE || "mock").trim().toLowerCase();
  if (walletAdapterType === "mock" || !["wallet_deeplink", "hashport_deeplink"].includes(walletAdapterType)) {
    blockers.push("topology_local_requires_reviewed_wallet_deeplink_adapter");
  }

  const recipientAddress = String(env.RECIPIENT_ADDRESS || "").trim();
  if (!isEvmAddress(recipientAddress) || /^0x0{40}$/i.test(recipientAddress)) {
    blockers.push("topology_local_requires_configured_recipient_address");
  }

  const chainId = String(env.CHAIN_ID || "").trim();
  if (chainId !== "137") {
    blockers.push("topology_local_requires_chain_137");
  }
  const enabledChainIds = String(env.ENABLED_PAYMENT_CHAIN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!(enabledChainIds.length === 1 && enabledChainIds[0] === "137")) {
    blockers.push("topology_local_requires_single_chain_137_enabled");
  }

  const chainRpcUrls = String(env[`RPC_URLS_137`] || "").split(",").map((value) => value.trim()).filter(Boolean);
  const genericRpcUrls = String(env.RPC_URLS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (chainRpcUrls.length === 0 && genericRpcUrls.length === 0) {
    blockers.push("topology_local_requires_chain_rpc_endpoints");
  }

  const backupDir = String(env.BACKUP_DIR || "").trim();
  if (!backupDir) {
    blockers.push("topology_local_requires_backup_dir");
  }

  const workerStateDbPath = String(env.WORKER_STATE_DB_PATH || "").trim();
  if (!workerStateDbPath) {
    blockers.push("topology_local_requires_worker_state_db_path");
  }

  const readinessRef = String(env.LOCAL_TERMINAL_OPERATOR_READINESS_REF || "").trim();
  if (!approvedRefPresent(readinessRef)) {
    blockers.push("topology_local_requires_mac_readiness_reference");
  }

  return {
    topology: DEPLOYMENT_TOPOLOGY_LOCAL_STORE_TERMINAL,
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
  };
}
