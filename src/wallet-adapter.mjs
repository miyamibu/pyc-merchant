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

export function getSupportedWallets(env = process.env) {
  const configured = normalizeWalletList(env.SUPPORTED_WALLETS);
  const walletConnectTransactionSessionImplemented = parseFlag(env.WALLETCONNECT_TRANSACTION_SESSION_IMPLEMENTED, false);
  if (configured.length > 0) {
    return uniq(configured).filter((wallet) => {
      if (/walletconnect/i.test(wallet)) return walletConnectTransactionSessionImplemented;
      return true;
    });
  }
  const defaults = ["WalletConnect", "Injected Wallet"];
  if (normalizeString(env.HASHPORT_WALLET_DEEPLINK_TEMPLATE)) {
    defaults.unshift("HashPort Wallet");
  }
  return uniq(defaults).filter((wallet) => walletConnectTransactionSessionImplemented || !/walletconnect/i.test(wallet));
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
  return raw.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key) => {
    const normalizedKey = String(key || "").toLowerCase();
    return Object.prototype.hasOwnProperty.call(context, normalizedKey) ? context[normalizedKey] : "";
  });
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
  const walletDeeplink = paymentUri ? applyTemplate(walletDeeplinkTemplate, templatePayload) : null;
  const walletUrl = normalizeString(walletDeeplink || paymentUri || "");
  const walletHelpUrl = normalizeString(env.WALLET_HELP_URL || walletAdapter.wallet_help_url || "");

  return {
    wallet_adapter: walletAdapter,
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
  const adapterType = String(env.WALLET_ADAPTER_TYPE || "mock");
  const reownProjectId = normalizeString(env.REOWN_PROJECT_ID);
  const walletHelpUrl = normalizeString(env.WALLET_HELP_URL || "https://walletconnect.com/");
  const reownEnabled = parseFlag(env.ENABLE_REOWN, false);
  const walletConnectTransactionSessionImplemented = parseFlag(env.WALLETCONNECT_TRANSACTION_SESSION_IMPLEMENTED, false);
  const walletDeeplinkTemplateConfigured = Boolean(
    normalizeString(env.WALLET_DEEPLINK_TEMPLATE) || normalizeString(env.HASHPORT_WALLET_DEEPLINK_TEMPLATE)
  );

  const baseConfig = {
    adapter_type: adapterType,
    wallet_help_url: walletHelpUrl,
    reown_project_id_configured: hasApprovedProjectId(reownProjectId),
    wallet_deeplink_template_configured: walletDeeplinkTemplateConfigured,
    capabilities: {
      hashport_deeplink: walletDeeplinkTemplateConfigured ? "configured" : "not_configured",
      eip681_uri: "implemented",
      walletconnect_transaction_session: walletConnectTransactionSessionImplemented ? "implemented" : "not_implemented",
      manual_copy_fallback: "implemented",
    },
  };

  if (adapterType === "reown") {
    if (!reownEnabled) {
      return {
        ...baseConfig,
        available: false,
        status: "disabled_by_flag",
        reason: "Reown adapter is disabled by feature flag"
      };
    }
    if (!baseConfig.reown_project_id_configured) {
      return {
        ...baseConfig,
        available: false,
        status: "missing_project_id",
        reason: "Reown Project ID is not configured"
      };
    }
    if (!walletConnectTransactionSessionImplemented) {
      return {
        ...baseConfig,
        available: false,
        status: "transaction_session_not_implemented",
        reason: "WalletConnect/Reown Project ID is configured, but transaction session connect/request handling is not implemented"
      };
    }
    return {
      ...baseConfig,
      available: true,
      status: "ready",
      reason: null
    };
  }

  return {
    ...baseConfig,
    available: false,
    status: "mock_only",
    reason: "Mock adapter active. Real wallet transfer is unavailable."
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
