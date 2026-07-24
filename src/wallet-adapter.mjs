import { createHash } from "node:crypto";

const WALLET_TEMPLATE_KEYS = new Set([
  "payment_uri",
  "payment_uri_encoded",
  "receive_address",
  "receive_address_encoded",
  "expected_amount_atomic",
  "expected_amount_atomic_encoded",
  "token_contract",
  "token_contract_encoded",
  "token_symbol",
  "token_symbol_encoded",
  "chain_id",
  "chain_id_encoded",
  "network",
  "network_encoded",
  "pay_url",
  "pay_url_encoded",
]);
const BLOCKED_WALLET_PROTOCOLS = new Set(["data:", "file:", "http:", "javascript:"]);
const WALLET_CAPABILITY_LABELS = Object.freeze({
  environmentTested: "検証済み環境",
  launch: "起動導線あり",
  manual: "手動送金のみ",
  unverified: "未検証",
});
const WALLET_QUERY_BINDING_PARAMETERS = Object.freeze({
  payment_uri: ["uri", "payment_uri", "request"],
  receive_address: ["recipient", "receive_address", "address", "to"],
  expected_amount_atomic: ["amount", "expected_amount_atomic", "uint256", "value"],
  token_contract: ["token", "token_contract", "contract"],
  token_symbol: ["token", "token_symbol", "symbol"],
  chain_id: ["chain", "chain_id", "network_id"],
  network: ["network"],
  pay_url: ["pay_url", "return_url", "callback_url"],
});

function parseFlag(value, fallback = false) {
  if (value == null) return fallback;
  return String(value).toLowerCase() === "true";
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function hasApprovedProjectId(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return false;
  return ![
    ["def", "ault"].join(""),
    ["place", "holder"].join(""),
    ["to", "do"].join(""),
    ["change", "me"].join(""),
    ["exam", "ple"].join(""),
    ["sam", "ple"].join(""),
    ["tb", "d"].join(""),
  ].some(
    (word) => normalized === word || normalized.includes(word)
  );
}

function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(normalizeString(value));
}

function normalizeWalletList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeRegistryList(value) {
  if (Array.isArray(value)) return uniq(value.map(normalizeString));
  return normalizeWalletList(value);
}

function getTemplatePlaceholders(template) {
  return [...normalizeString(template).matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)]
    .map((match) => String(match[1] || "").toLowerCase());
}

function templatePlaceholderSemantic(placeholder) {
  return String(placeholder || "").toLowerCase().replace(/_encoded$/, "");
}

function isAllowedQueryBinding(parameter, semantic) {
  const allowed = WALLET_QUERY_BINDING_PARAMETERS[semantic] || [];
  return allowed.includes(String(parameter || "").toLowerCase());
}

function hasDuplicateQueryParameters(searchParams) {
  const seen = new Set();
  for (const [parameter] of searchParams.entries()) {
    const normalized = String(parameter || "").toLowerCase();
    if (seen.has(normalized)) return true;
    seen.add(normalized);
  }
  return false;
}

function queryValuesCaseInsensitive(searchParams, expectedParameter) {
  const normalizedExpected = String(expectedParameter || "").toLowerCase();
  const values = [];
  for (const [parameter, value] of searchParams.entries()) {
    if (String(parameter || "").toLowerCase() === normalizedExpected) values.push(value);
  }
  return values;
}

function analyzeWalletTemplateBindings(template) {
  const normalizedTemplate = normalizeString(template);
  const placeholders = getTemplatePlaceholders(normalizedTemplate);
  if (/^\{\{\s*payment_uri\s*\}\}$/i.test(normalizedTemplate)) {
    return { ok: true, mode: "payment_uri_root", bindings: [] };
  }

  const markerPayload = {};
  for (const key of WALLET_TEMPLATE_KEYS) {
    const semantic = templatePlaceholderSemantic(key);
    markerPayload[semantic] = `wallet_binding_${semantic}`;
  }
  const markerTarget = applyTemplate(normalizedTemplate, markerPayload);
  let parsed;
  try {
    parsed = new URL(markerTarget);
  } catch (_error) {
    return { ok: false, status: "template_url_invalid" };
  }
  if (parsed.hash) return { ok: false, status: "template_fragment_not_allowed" };
  if (hasDuplicateQueryParameters(parsed.searchParams)) {
    return { ok: false, status: "template_duplicate_parameter" };
  }

  const bindings = [];
  for (const placeholder of placeholders) {
    const semantic = templatePlaceholderSemantic(placeholder);
    const marker = `wallet_binding_${semantic}`;
    const matches = [...parsed.searchParams.entries()]
      .filter(([, value]) => value === marker);
    if (matches.length !== 1) {
      return { ok: false, status: "template_parameter_binding_missing" };
    }
    const [parameter] = matches[0];
    if (!isAllowedQueryBinding(parameter, semantic)) {
      return { ok: false, status: "template_parameter_binding_invalid" };
    }
    if (semantic === "payment_uri" && placeholder !== "payment_uri_encoded") {
      return { ok: false, status: "template_payment_uri_encoding_required" };
    }
    bindings.push({ parameter, semantic });
  }

  // The approved wrapper may only carry values that are explicitly bound to
  // reviewed placeholders. Static or unbound query values could override the
  // transfer data a wallet actually consumes.
  if ([...parsed.searchParams.entries()].length !== bindings.length) {
    return { ok: false, status: "template_unbound_parameter_not_allowed" };
  }
  if (new Set(bindings.map((binding) => binding.parameter.toLowerCase())).size !== bindings.length) {
    return { ok: false, status: "template_duplicate_parameter" };
  }

  const semantics = new Set(bindings.map((binding) => binding.semantic));
  const hasPaymentUri = semantics.has("payment_uri");
  const hasDirectTransfer = [
    "receive_address",
    "expected_amount_atomic",
    "chain_id",
    "token_contract",
  ].every((semantic) => semantics.has(semantic));
  if (!hasPaymentUri && !hasDirectTransfer) {
    return { ok: false, status: "template_transfer_binding_missing" };
  }
  return {
    ok: true,
    mode: hasPaymentUri ? "payment_uri_query" : "direct_transfer_query",
    bindings,
  };
}

function parseWalletAdapterRegistry(env) {
  const raw = normalizeString(env.WALLET_ADAPTER_REGISTRY_JSON);
  if (!raw) return { configured: false, entries: [], error: null };
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : parsed?.adapters;
    if (!Array.isArray(entries)) {
      return { configured: true, entries: [], error: "registry_not_array" };
    }
    return { configured: true, entries, error: null };
  } catch (_error) {
    return { configured: true, entries: [], error: "registry_invalid_json" };
  }
}

function validateRegistryEntry(entry, template, requestedAdapterId = "") {
  const adapterId = normalizeString(entry?.adapter_id);
  const walletName = normalizeString(entry?.wallet_name);
  const entryTemplate = normalizeString(entry?.template);
  const approvalRef = normalizeString(entry?.approval_ref);
  const approvedAt = normalizeString(entry?.approved_at);
  const revokedAt = normalizeString(entry?.revoked_at);
  const expectedHash = normalizeString(entry?.template_sha256).toLowerCase();
  const allowedSchemes = normalizeRegistryList(entry?.allowed_scheme)
    .map((scheme) => scheme.toLowerCase().replace(/:$/, ""));
  const allowedHttpsHosts = normalizeRegistryList(entry?.allowed_https_hosts)
    .map((host) => host.toLowerCase());

  if (!adapterId || !walletName || !approvalRef || !approvedAt) {
    return { ok: false, status: "registry_metadata_incomplete" };
  }
  if (requestedAdapterId && adapterId !== requestedAdapterId) {
    return { ok: false, status: "adapter_id_mismatch" };
  }
  if (revokedAt) return { ok: false, status: "adapter_revoked" };
  if (!Number.isFinite(Date.parse(approvedAt))) {
    return { ok: false, status: "adapter_approval_invalid" };
  }
  if (!hasApprovedProjectId(approvalRef)) {
    return { ok: false, status: "adapter_approval_missing" };
  }
  if (!entryTemplate || entryTemplate !== template) {
    return { ok: false, status: "registry_template_mismatch" };
  }
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || expectedHash !== sha256(template)) {
    return { ok: false, status: "registry_template_hash_mismatch" };
  }
  if (allowedSchemes.length === 0) {
    return { ok: false, status: "registry_scheme_missing" };
  }

  const placeholders = getTemplatePlaceholders(template);
  if (placeholders.length === 0 || placeholders.some((key) => !WALLET_TEMPLATE_KEYS.has(key))) {
    return { ok: false, status: "template_placeholder_invalid" };
  }
  const transferBindings = analyzeWalletTemplateBindings(template);
  if (!transferBindings.ok) return transferBindings;

  const samplePayload = {
    payment_uri: "ethereum:0x1111111111111111111111111111111111111111@137/transfer?address=0x2222222222222222222222222222222222222222&uint256=987654321",
    receive_address: "0x2222222222222222222222222222222222222222",
    expected_amount_atomic: "987654321",
    token_contract: "0x1111111111111111111111111111111111111111",
    token_symbol: "JPYC",
    chain_id: "137",
    network: "Polygon",
    pay_url: "https://terminal.example.jp/pay?ref=registry-validation",
  };
  const expanded = applyTemplate(template, samplePayload);
  if (!expanded) return { ok: false, status: "template_expansion_failed" };
  let parsed;
  try {
    parsed = new URL(expanded);
  } catch (_error) {
    return { ok: false, status: "template_url_invalid" };
  }
  const protocol = parsed.protocol.toLowerCase();
  const scheme = protocol.replace(/:$/, "");
  if (BLOCKED_WALLET_PROTOCOLS.has(protocol) || !allowedSchemes.includes(scheme)) {
    return { ok: false, status: "template_scheme_not_allowed" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, status: "template_credentials_not_allowed" };
  }
  if (protocol === "https:" && !allowedHttpsHosts.includes(parsed.hostname.toLowerCase())) {
    return { ok: false, status: "template_https_host_not_allowed" };
  }
  const sampleValidation = validateExpandedWalletTarget(expanded, {
    allowed_schemes: allowedSchemes,
    allowed_https_hosts: allowedHttpsHosts,
    transfer_bindings: transferBindings,
  }, samplePayload);
  if (!sampleValidation.ok) {
    return {
      ok: false,
      status: sampleValidation.status.replace(/^expanded_target_/, "template_"),
    };
  }

  const testedIosVersions = normalizeRegistryList(entry?.tested_ios_versions);
  const testedAndroidVersions = normalizeRegistryList(entry?.tested_android_versions);
  const testedWalletVersions = normalizeRegistryList(entry?.tested_wallet_versions);
  const capabilityLevel = testedWalletVersions.length > 0
    && (testedIosVersions.length > 0 || testedAndroidVersions.length > 0)
    ? "environment_scoped_tested"
    : "launch";
  return {
    ok: true,
    status: "ready",
    adapter_id: adapterId,
    wallet_name: walletName,
    approval_ref: approvalRef,
    approved_at: approvedAt,
    capability_level: capabilityLevel,
    allowed_schemes: allowedSchemes,
    allowed_https_hosts: allowedHttpsHosts,
    transfer_bindings: transferBindings,
    tested_environments: {
      ios_versions: testedIosVersions,
      android_versions: testedAndroidVersions,
      wallet_versions: testedWalletVersions,
    },
  };
}

function resolveApprovedAdapter(env, template) {
  const registry = parseWalletAdapterRegistry(env);
  if (!registry.configured) return { ok: false, status: "missing_approved_adapter_registry" };
  if (registry.error) return { ok: false, status: registry.error };
  const requestedAdapterId = normalizeString(env.WALLET_ADAPTER_ID);
  const candidates = registry.entries.filter((entry) => {
    if (requestedAdapterId) return normalizeString(entry?.adapter_id) === requestedAdapterId;
    return normalizeString(entry?.template) === template;
  });
  if (candidates.length !== 1) {
    return { ok: false, status: candidates.length === 0 ? "approved_adapter_not_found" : "approved_adapter_ambiguous" };
  }
  return validateRegistryEntry(candidates[0], template, requestedAdapterId);
}

function formatApprovedWalletCapability(adapter) {
  const tested = adapter?.tested_environments || {};
  const platformScopes = [];
  if (tested.ios_versions?.length > 0) {
    platformScopes.push(`iOS ${tested.ios_versions.join(" / ")}`);
  }
  if (tested.android_versions?.length > 0) {
    platformScopes.push(`Android ${tested.android_versions.join(" / ")}`);
  }
  if (platformScopes.length > 0 && tested.wallet_versions?.length > 0) {
    const scope = `${platformScopes.join(" / ")} / ウォレット ${tested.wallet_versions.join(" / ")}`;
    return `${WALLET_CAPABILITY_LABELS.environmentTested}（${scope}）: ${adapter.wallet_name}`;
  }
  return `${WALLET_CAPABILITY_LABELS.launch}（OS・ウォレット版は未検証）: ${adapter.wallet_name}`;
}

function formatWalletCapability(level, walletName) {
  return `${WALLET_CAPABILITY_LABELS[level] || WALLET_CAPABILITY_LABELS.unverified}: ${walletName}`;
}

export function getSupportedWallets(env = process.env) {
  const configured = normalizeWalletList(env.SUPPORTED_WALLETS);
  const template = normalizeString(env.HASHPORT_WALLET_DEEPLINK_TEMPLATE) || normalizeString(env.WALLET_DEEPLINK_TEMPLATE);
  const approvedAdapter = template ? resolveApprovedAdapter(env, template) : null;
  const defaults = configured.length > 0 ? configured : ["HashPort Wallet", "WalletConnect", "Injected Wallet"];
  const labels = defaults.map((walletName) => {
    if (approvedAdapter?.ok && walletName.toLowerCase() === approvedAdapter.wallet_name.toLowerCase()) {
      return formatApprovedWalletCapability(approvedAdapter);
    }
    return formatWalletCapability("unverified", walletName);
  });
  if (!approvedAdapter?.ok) labels.push(formatWalletCapability("manual", "支払い情報コピー"));
  return uniq(labels);
}

function buildTemplateContext(payload) {
  return {
    payment_uri: payload.payment_uri || "",
    payment_uri_encoded: encodeURIComponent(payload.payment_uri || ""),
    receive_address: payload.receive_address || "",
    receive_address_encoded: encodeURIComponent(payload.receive_address || ""),
    expected_amount_atomic: payload.expected_amount_atomic || "",
    expected_amount_atomic_encoded: encodeURIComponent(payload.expected_amount_atomic || ""),
    token_contract: payload.token_contract || "",
    token_contract_encoded: encodeURIComponent(payload.token_contract || ""),
    token_symbol: payload.token_symbol || "",
    token_symbol_encoded: encodeURIComponent(payload.token_symbol || ""),
    chain_id: String(payload.chain_id || ""),
    chain_id_encoded: encodeURIComponent(String(payload.chain_id || "")),
    network: payload.network || "",
    network_encoded: encodeURIComponent(payload.network || ""),
    pay_url: payload.pay_url || "",
    pay_url_encoded: encodeURIComponent(payload.pay_url || ""),
  };
}

function applyTemplate(template, payload) {
  const raw = normalizeString(template);
  if (!raw) return null;
  const context = buildTemplateContext(payload);
  const placeholders = getTemplatePlaceholders(raw);
  if (placeholders.some((key) => !Object.prototype.hasOwnProperty.call(context, key))) return null;
  return raw.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key) => {
    const normalizedKey = String(key || "").toLowerCase();
    return context[normalizedKey];
  });
}

function validateExpandedWalletTarget(target, adapter, payload) {
  const normalizedTarget = normalizeString(target);
  if (!normalizedTarget) return { ok: false, status: "expanded_target_missing" };
  let parsed;
  try {
    parsed = new URL(normalizedTarget);
  } catch (_error) {
    return { ok: false, status: "expanded_target_invalid_url" };
  }
  const protocol = parsed.protocol.toLowerCase();
  const scheme = protocol.replace(/:$/, "");
  const allowedSchemes = normalizeRegistryList(adapter?.allowed_schemes)
    .map((value) => value.toLowerCase().replace(/:$/, ""));
  const allowedHttpsHosts = normalizeRegistryList(adapter?.allowed_https_hosts)
    .map((value) => value.toLowerCase());
  if (BLOCKED_WALLET_PROTOCOLS.has(protocol) || !allowedSchemes.includes(scheme)) {
    return { ok: false, status: "expanded_target_scheme_not_allowed" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, status: "expanded_target_credentials_not_allowed" };
  }
  if (protocol === "https:" && !allowedHttpsHosts.includes(parsed.hostname.toLowerCase())) {
    return { ok: false, status: "expanded_target_https_host_not_allowed" };
  }
  if (parsed.hash) {
    return { ok: false, status: "expanded_target_fragment_not_allowed" };
  }
  if (hasDuplicateQueryParameters(parsed.searchParams)) {
    return { ok: false, status: "expanded_target_duplicate_parameter" };
  }

  const transferBindings = adapter?.transfer_bindings;
  if (!transferBindings?.ok) {
    return { ok: false, status: "expanded_target_binding_missing" };
  }
  if (transferBindings.mode === "payment_uri_root") {
    return normalizedTarget === normalizeString(payload.payment_uri)
      ? { ok: true, status: "ready" }
      : { ok: false, status: "expanded_target_binding_value_mismatch" };
  }
  if (!["payment_uri_query", "direct_transfer_query"].includes(transferBindings.mode)) {
    return { ok: false, status: "expanded_target_binding_mode_invalid" };
  }

  const context = buildTemplateContext(payload);
  const bindings = Array.isArray(transferBindings.bindings) ? transferBindings.bindings : [];
  for (const binding of bindings) {
    const parameter = normalizeString(binding?.parameter);
    const semantic = normalizeString(binding?.semantic);
    if (!parameter || !Object.prototype.hasOwnProperty.call(context, semantic)) {
      return { ok: false, status: "expanded_target_binding_invalid" };
    }
    const values = queryValuesCaseInsensitive(parsed.searchParams, parameter);
    if (values.length !== 1 || values[0] !== String(context[semantic])) {
      return { ok: false, status: "expanded_target_binding_value_mismatch" };
    }
  }
  if ([...parsed.searchParams.entries()].length !== bindings.length) {
    return { ok: false, status: "expanded_target_unbound_parameter_not_allowed" };
  }
  return { ok: true, status: "ready" };
}

export function buildEip681PaymentUri({
  chainId,
  tokenContract,
  receiveAddress,
  expectedAmountAtomic,
} = {}) {
  const normalizedChainId = normalizeString(chainId);
  const normalizedToken = normalizeString(tokenContract);
  const normalizedReceive = normalizeString(receiveAddress);
  const normalizedAmount = normalizeString(expectedAmountAtomic);
  if (!/^\d+$/.test(normalizedChainId)) return null;
  if (!isEvmAddress(normalizedToken) || !isEvmAddress(normalizedReceive)) return null;
  if (!/^[0-9]+$/.test(normalizedAmount) || normalizedAmount === "0") return null;

  const params = new URLSearchParams({
    address: normalizedReceive,
    uint256: normalizedAmount,
  });
  return `ethereum:${normalizedToken}@${normalizedChainId}/transfer?${params.toString()}`;
}

export function buildWalletLaunchPayload({
  env = process.env,
  chainId,
  network,
  tokenSymbol = "JPYC",
  tokenContract,
  tokenDecimals,
  receiveAddress,
  expectedAmountAtomic,
  amountJpy,
  expiresAt,
  payUrl,
} = {}) {
  const walletAdapter = createWalletAdapter(env);
  const normalizedChainId = normalizeString(chainId);
  const normalizedNetwork = normalizeString(network) || (normalizedChainId === "137" ? "Polygon" : normalizedChainId || "Unknown");
  const normalizedTokenSymbol = normalizeString(tokenSymbol) || "JPYC";
  const normalizedTokenContract = normalizeString(tokenContract);
  const normalizedReceiveAddress = normalizeString(receiveAddress);
  const normalizedExpectedAmountAtomic = normalizeString(expectedAmountAtomic);
  const normalizedPayUrl = normalizeString(payUrl);
  const paymentUri = buildEip681PaymentUri({
    chainId: normalizedChainId,
    tokenContract: normalizedTokenContract,
    receiveAddress: normalizedReceiveAddress,
    expectedAmountAtomic: normalizedExpectedAmountAtomic,
  });

  const templatePayload = {
    payment_uri: paymentUri,
    receive_address: normalizedReceiveAddress,
    expected_amount_atomic: normalizedExpectedAmountAtomic,
    token_contract: normalizedTokenContract,
    token_symbol: normalizedTokenSymbol,
    chain_id: normalizedChainId,
    network: normalizedNetwork,
    pay_url: normalizedPayUrl,
  };

  const walletDeeplinkTemplate =
    normalizeString(env.HASHPORT_WALLET_DEEPLINK_TEMPLATE) || normalizeString(env.WALLET_DEEPLINK_TEMPLATE);
  const expandedTarget = paymentUri && walletAdapter.available
    ? applyTemplate(walletDeeplinkTemplate, templatePayload)
    : null;
  const expandedTargetValidation = walletAdapter.available
    ? paymentUri
      ? validateExpandedWalletTarget(expandedTarget, walletAdapter, templatePayload)
      : { ok: false, status: "payment_payload_invalid" }
    : { ok: false, status: walletAdapter.status };
  const resolvedWalletAdapter = walletAdapter.available && !expandedTargetValidation.ok
    ? {
        ...walletAdapter,
        available: false,
        status: expandedTargetValidation.status,
        expanded_target_validated: false,
        reason: "実際の請求値でウォレット起動先を再検証できないため、支払い情報コピーをご利用ください。",
      }
    : {
        ...walletAdapter,
        expanded_target_validated: walletAdapter.available ? true : false,
      };
  const walletDeeplink = expandedTargetValidation.ok ? expandedTarget : null;
  const walletUrl = normalizeString(walletDeeplink || "");
  const walletHelpUrl = normalizeString(env.WALLET_HELP_URL || resolvedWalletAdapter.wallet_help_url || "");

  return {
    wallet_adapter: resolvedWalletAdapter,
    payment_uri: paymentUri,
    wallet_deeplink: walletDeeplink,
    wallet_url: walletUrl || null,
    wallet_help_url: walletHelpUrl || null,
    supported_wallets: getSupportedWallets(env),
    network: normalizedNetwork,
    chain_id: normalizedChainId,
    token_symbol: normalizedTokenSymbol,
    token_contract: normalizedTokenContract,
    token_decimals: Number.isInteger(Number(tokenDecimals)) ? Number(tokenDecimals) : null,
    receive_address: normalizedReceiveAddress,
    expected_amount_atomic: normalizedExpectedAmountAtomic,
    amount_jpy: Number.isFinite(Number(amountJpy)) ? Number(amountJpy) : null,
    expires_at: normalizeString(expiresAt) || null,
    pay_url: normalizedPayUrl || null,
    copy_fallback: {
      copy_receive_address: normalizedReceiveAddress,
      copy_amount: normalizedExpectedAmountAtomic,
      copy_network: normalizedNetwork,
      copy_token: normalizedTokenSymbol,
    },
  };
}

export function createWalletAdapter(env = process.env) {
  const adapterType = String(env.WALLET_ADAPTER_TYPE || "mock").trim().toLowerCase();
  const reownProjectId = normalizeString(env.REOWN_PROJECT_ID);
  const walletHelpUrl = normalizeString(env.WALLET_HELP_URL || "https://walletconnect.com/");
  const reownEnabled = parseFlag(env.ENABLE_REOWN, false);
  const walletDeeplinkTemplate =
    normalizeString(env.HASHPORT_WALLET_DEEPLINK_TEMPLATE) || normalizeString(env.WALLET_DEEPLINK_TEMPLATE);
  const walletDeeplinkTemplateConfigured = Boolean(walletDeeplinkTemplate);
  const approvedAdapter = walletDeeplinkTemplateConfigured
    ? resolveApprovedAdapter(env, walletDeeplinkTemplate)
    : { ok: false, status: "missing_deeplink_template" };

  const baseConfig = {
    adapter_type: adapterType,
    wallet_help_url: walletHelpUrl,
    reown_project_id_configured: hasApprovedProjectId(reownProjectId),
    wallet_deeplink_template_configured: walletDeeplinkTemplateConfigured,
    adapter_registry_configured: parseWalletAdapterRegistry(env).configured,
  };

  if (adapterType === "reown") {
    return {
      ...baseConfig,
      available: false,
      status: "reown_session_not_implemented",
      reason: "Reown AppKit/WalletConnect session integration is not implemented; use a configured wallet deeplink adapter"
    };
  }

  if (["wallet_deeplink", "hashport_deeplink"].includes(adapterType)) {
    if (!walletDeeplinkTemplateConfigured) {
      return {
        ...baseConfig,
        available: false,
        status: "missing_deeplink_template",
        reason: "A reviewed wallet deeplink template is required"
      };
    }
    if (!approvedAdapter.ok) {
      return {
        ...baseConfig,
        available: false,
        status: approvedAdapter.status,
        reason: "承認済みのウォレット起動設定を確認できないため、支払い情報コピーをご利用ください。"
      };
    }
    return {
      ...baseConfig,
      available: true,
      status: "ready",
      integration: "configured_deeplink",
      adapter_id: approvedAdapter.adapter_id,
      wallet_name: approvedAdapter.wallet_name,
      approval_ref: approvedAdapter.approval_ref,
      approved_at: approvedAdapter.approved_at,
      capability_level: approvedAdapter.capability_level,
      allowed_schemes: approvedAdapter.allowed_schemes,
      allowed_https_hosts: approvedAdapter.allowed_https_hosts,
      transfer_bindings: approvedAdapter.transfer_bindings,
      tested_environments: approvedAdapter.tested_environments,
      reason: null
    };
  }

  return {
    ...baseConfig,
    available: false,
    status: adapterType === "mock" ? "mock_only" : "unsupported_adapter",
    reason: adapterType === "mock"
      ? "Mock adapter active. Real wallet transfer is unavailable."
      : `Unsupported wallet adapter type: ${adapterType}`
  };
}

export function classifyWalletError(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (["insufficient_funds", "insufficient_balance"].includes(normalized)) return "balance_insufficient";
  if (["insufficient_gas", "gas_too_low"].includes(normalized)) return "gas_insufficient";
  if (["wrong_chain", "unsupported_chain"].includes(normalized)) return "wrong_chain";
  if (["user_rejected", "signature_rejected"].includes(normalized)) return "signature_rejected";
  if (["pending", "tx_pending"].includes(normalized)) return "tx_pending";
  return "unknown";
}
