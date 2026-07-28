import crypto from "node:crypto";

const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeUnsigned(value) {
  const raw = normalizeString(value);
  if (!/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw).toString();
  } catch (_error) {
    return null;
  }
}

function normalizeHash(value) {
  const raw = normalizeString(value).toLowerCase();
  return HASH_RE.test(raw) ? raw : null;
}

function normalizeAddress(value) {
  const raw = normalizeString(value).toLowerCase();
  return ADDRESS_RE.test(raw) ? raw : null;
}

export function hashRpcEndpoint(endpoint) {
  return `sha256:${crypto.createHash("sha256").update(normalizeString(endpoint), "utf8").digest("hex")}`;
}

export function buildChainRuntimeRegistryRecord({
  chainId,
  tokenContract,
  tokenDecimals,
  endpoint,
  latestBlockHash = null,
  approvalRef = null,
  verifiedAt,
} = {}) {
  const observed = endpoint?.observed || {};
  const endpointHash = normalizeString(endpoint?.endpoint_id || endpoint?.endpointId) || null;
  const normalizedChainId = normalizeUnsigned(observed.chain_id ?? chainId);
  const normalizedTokenContract = normalizeAddress(observed.token_contract ?? tokenContract);
  const normalizedImplementation = normalizeAddress(observed.implementation_address ?? observed.implementationAddress);
  const normalizedLatestBlock = normalizeUnsigned(observed.latest_block ?? observed.latestBlock);
  const normalizedTipHash = normalizeHash(latestBlockHash ?? observed.latest_block_hash ?? observed.latestBlockHash);
  const metadataVerified = endpoint?.ok === true || endpoint?.endpoint_state === "verified";
  const status = metadataVerified && endpointHash && normalizedChainId && normalizedTokenContract && normalizedLatestBlock && normalizedTipHash
    ? "verified"
    : "quarantined";

  return {
    chain_id: normalizedChainId || normalizeUnsigned(chainId) || null,
    rpc_endpoint_hash: endpointHash || hashRpcEndpoint(endpoint?.rpc_url || ""),
    token_contract: normalizedTokenContract || normalizeAddress(tokenContract) || null,
    token_decimals: Number.isInteger(Number(observed.decimals ?? tokenDecimals))
      ? Number(observed.decimals ?? tokenDecimals)
      : null,
    proxy_implementation: normalizedImplementation,
    proxy_code_hash: normalizeHash(observed.implementation_code_hash ?? observed.implementationCodeHash),
    token_code_hash: normalizeHash(observed.code_hash ?? observed.codeHash),
    latest_block: normalizedLatestBlock,
    latest_block_hash: normalizedTipHash,
    verified_at: normalizeString(verifiedAt) || new Date().toISOString(),
    approval_ref: normalizeString(approvalRef) || null,
    status,
    failure_codes: status === "verified"
      ? []
      : [...new Set([
          ...(endpoint?.failures || []).map((failure) => String(failure?.code || "UNKNOWN")),
          ...(normalizedTipHash ? [] : ["LATEST_BLOCK_HASH_MISSING"]),
        ])],
  };
}

export function assessChainRuntimeRegistry(rows = [], {
  chainId,
  tokenContract,
  tokenDecimals,
  maxTipLag = 3,
} = {}) {
  const expectedChainId = normalizeUnsigned(chainId);
  const expectedTokenContract = normalizeAddress(tokenContract);
  const expectedDecimals = Number(tokenDecimals);
  const configured = Array.isArray(rows) ? rows : [];
  const eligible = configured.filter((row) => {
    if (String(row?.status || "") !== "verified") return false;
    if (expectedChainId && normalizeUnsigned(row.chain_id) !== expectedChainId) return false;
    if (expectedTokenContract && normalizeAddress(row.token_contract) !== expectedTokenContract) return false;
    if (Number.isInteger(expectedDecimals) && Number(row.token_decimals) !== expectedDecimals) return false;
    return Boolean(normalizeHash(row.latest_block_hash)) && Boolean(normalizeUnsigned(row.latest_block));
  });

  const latestBlocks = eligible.map((row) => Number(normalizeUnsigned(row.latest_block))).filter(Number.isFinite);
  const highestBlock = latestBlocks.length > 0 ? Math.max(...latestBlocks) : null;
  const tipDivergence = eligible.filter((row) => {
    const block = Number(normalizeUnsigned(row.latest_block));
    const lag = highestBlock != null && Number.isFinite(block) ? highestBlock - block : Number.POSITIVE_INFINITY;
    const highestTipHash = eligible.find((candidate) => Number(candidate.latest_block) === highestBlock)?.latest_block_hash || "";
    return highestBlock != null
      && Number.isFinite(block)
      && (
        lag > Math.max(0, Number(maxTipLag) || 0)
        || String(row.latest_block_hash).toLowerCase() !== String(highestTipHash).toLowerCase()
      );
  });
  const ok = eligible.length > 0 && tipDivergence.length === 0;
  return {
    ok,
    status: ok ? "ready" : (eligible.length > 0 ? "tip_divergence" : "quarantined"),
    configured_count: configured.length,
    verified_count: eligible.length,
    quarantined_count: configured.length - eligible.length,
    highest_block: highestBlock,
    eligible_endpoint_hashes: eligible.map((row) => row.rpc_endpoint_hash).filter(Boolean),
    divergent_endpoint_hashes: tipDivergence.map((row) => row.rpc_endpoint_hash).filter(Boolean),
  };
}
