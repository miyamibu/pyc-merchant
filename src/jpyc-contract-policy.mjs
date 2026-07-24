export const OFFICIAL_JPYC_CONTRACT_ADDRESS = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
export const OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER = OFFICIAL_JPYC_CONTRACT_ADDRESS.toLowerCase();

export const JPYC_CONTRACT_REFERENCE = Object.freeze({
  checked_at: "2026-07-24",
  source_url: "https://corporate.jpyc.co.jp/news/posts/Notice",
  note: "JPYC official fake-token warning lists this contract for Ethereum, Avalanche C-Chain, and Polygon.",
});

export const JPYC_PREPAID_DENYLIST_CONTRACTS = Object.freeze([
  "0x431D5dfF03120AFA4bDf332c61A6e1766eF37BDB".toLowerCase(),
]);

export const SUPPORTED_JPYC_PAYMENT_CHAINS = Object.freeze([
  Object.freeze({
    chain_id: "1",
    network: "Ethereum Mainnet",
    short_name: "Ethereum",
    native_symbol: "ETH",
    token_contract: OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER,
    token_symbol: "JPYC",
    customer_note: "Ethereumはガス代が高くなる場合があります。",
  }),
  Object.freeze({
    chain_id: "43114",
    network: "Avalanche C-Chain",
    short_name: "Avalanche",
    native_symbol: "AVAX",
    token_contract: OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER,
    token_symbol: "JPYC",
    customer_note: "Avalanche C-Chainで送金してください。",
  }),
  Object.freeze({
    chain_id: "137",
    network: "Polygon",
    short_name: "Polygon",
    native_symbol: "POL",
    token_contract: OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER,
    token_symbol: "JPYC",
    customer_note: "Polygonネットワークで送金してください。",
  }),
]);

const PAYMENT_CHAIN_BY_ID = new Map(SUPPORTED_JPYC_PAYMENT_CHAINS.map((chain) => [chain.chain_id, chain]));
const DENYLIST_SET = new Set(JPYC_PREPAID_DENYLIST_CONTRACTS);
const DEFAULT_ENABLED_PAYMENT_CHAIN_IDS = Object.freeze(["137"]);

export function normalizeJpycPolicyAddress(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : "";
}

export function getSupportedPaymentChain(chainId) {
  return PAYMENT_CHAIN_BY_ID.get(String(chainId || "").trim()) || null;
}

export function listSupportedPaymentChains() {
  return SUPPORTED_JPYC_PAYMENT_CHAINS.map((chain) => ({ ...chain }));
}

export function parseEnabledPaymentChainIds(value = "137") {
  const raw = String(value || "").trim();
  const requested = raw
    ? raw.split(",").map((item) => item.trim()).filter(Boolean)
    : DEFAULT_ENABLED_PAYMENT_CHAIN_IDS;
  const enabled = [...new Set(requested)].filter((chainId) => PAYMENT_CHAIN_BY_ID.has(chainId));
  return enabled.length > 0 ? enabled : [...DEFAULT_ENABLED_PAYMENT_CHAIN_IDS];
}

export function listEnabledPaymentChains(enabledChainIds = DEFAULT_ENABLED_PAYMENT_CHAIN_IDS) {
  const raw = Array.isArray(enabledChainIds) ? enabledChainIds.join(",") : enabledChainIds;
  return parseEnabledPaymentChainIds(raw)
    .map((chainId) => getSupportedPaymentChain(chainId))
    .filter(Boolean)
    .map((chain) => ({ ...chain }));
}

export function networkLabelForChainId(chainId) {
  return getSupportedPaymentChain(chainId)?.network || String(chainId || "").trim() || "Unknown";
}

export function isDeniedJpycContract(value) {
  const normalized = normalizeJpycPolicyAddress(value);
  return normalized ? DENYLIST_SET.has(normalized) : false;
}

export function validateOfficialJpycContract(value, label = "JPYC contract") {
  const normalized = normalizeJpycPolicyAddress(value);
  if (!normalized) {
    return { ok: false, code: "INVALID_JPYC_CONTRACT", message: `${label} must be a 0x-prefixed EVM address` };
  }
  if (isDeniedJpycContract(normalized)) {
    return {
      ok: false,
      code: "DENIED_JPYC_PREPAID_CONTRACT",
      message: `${label} is JPYC Prepaid and cannot be used for funds-transfer JPYC payments`,
    };
  }
  if (normalized !== OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER) {
    return {
      ok: false,
      code: "UNOFFICIAL_JPYC_CONTRACT",
      message: `${label} must match the official funds-transfer JPYC contract`,
    };
  }
  return { ok: true, value: normalized };
}

export function paymentChainForInvoiceRequest(paymentChainId, enabledChainIds = DEFAULT_ENABLED_PAYMENT_CHAIN_IDS) {
  const chain = getSupportedPaymentChain(paymentChainId);
  const enabled = parseEnabledPaymentChainIds(Array.isArray(enabledChainIds) ? enabledChainIds.join(",") : enabledChainIds);
  if (!chain) {
    return {
      error: {
        code: "UNSUPPORTED_PAYMENT_CHAIN",
        message: "payment_chain_id must be one of the supported JPYC payment chain IDs",
        details: { supported_chain_ids: listSupportedPaymentChains().map((item) => item.chain_id) },
      },
    };
  }
  if (!enabled.includes(chain.chain_id)) {
    return {
      error: {
        code: "PAYMENT_CHAIN_DISABLED",
        message: "payment_chain_id is supported but not enabled for this deployment",
        details: { enabled_chain_ids: enabled },
      },
    };
  }
  return { chain };
}

export function publicPaymentChain(chain, extra = {}) {
  return {
    chain_id: chain.chain_id,
    network: chain.network,
    short_name: chain.short_name,
    native_symbol: chain.native_symbol,
    token_symbol: chain.token_symbol,
    token_contract: chain.token_contract,
    token_contract_display: OFFICIAL_JPYC_CONTRACT_ADDRESS,
    customer_note: chain.customer_note,
    reference_checked_at: JPYC_CONTRACT_REFERENCE.checked_at,
    reference_url: JPYC_CONTRACT_REFERENCE.source_url,
    ...extra,
  };
}
