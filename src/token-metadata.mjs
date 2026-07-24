import crypto from "node:crypto";
import { Interface, keccak256 } from "ethers";

export const APPROVED_TOKEN_DECIMALS = 18;
export const APPROVED_LEDGER_BASE_UNIT_SCALE = "1000000";
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const metadataInterface = new Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeAddress(value) {
  const normalized = normalizeString(value).toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : "";
}

function normalizeHash(value) {
  const normalized = normalizeString(value).toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalized) ? normalized : "";
}

function normalizeBytecode(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(normalized) || normalized === "0x") return "";
  return normalized;
}

function normalizeUnsignedInteger(value) {
  const raw = normalizeString(value).toLowerCase();
  try {
    if (/^0x[0-9a-f]+$/.test(raw) || /^\d+$/.test(raw)) return BigInt(raw).toString();
  } catch (_error) {
    // The caller receives an empty normalized value and quarantines the endpoint.
  }
  return "";
}

function normalizeDecimals(value) {
  if (value == null || normalizeString(value) === "") return null;
  const raw = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isInteger(raw) && raw >= 0 && raw <= 255 ? raw : null;
}

function normalizeBlockTag(value) {
  const normalized = normalizeUnsignedInteger(value);
  return normalized ? `0x${BigInt(normalized).toString(16)}` : "";
}

function normalizeStorageWord(value) {
  const raw = normalizeString(value).toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(raw)) return "";
  const digits = raw.slice(2);
  if (digits.length > 64) return "";
  return `0x${digits.padStart(64, "0")}`;
}

function implementationAddressFromStorage(value) {
  const storageWord = normalizeStorageWord(value);
  if (!storageWord) return "";
  const address = `0x${storageWord.slice(-40)}`;
  return /^0x0{40}$/.test(address) ? "" : normalizeAddress(address);
}

function endpointId(rpcUrl) {
  return `sha256:${crypto.createHash("sha256").update(normalizeString(rpcUrl)).digest("hex")}`;
}

function bytecodeHash(bytecode) {
  const normalized = normalizeBytecode(bytecode);
  return normalized ? keccak256(normalized).toLowerCase() : "";
}

function policyValue(policy, camelKey, snakeKey, fallback = "") {
  return policy?.[camelKey] ?? policy?.[snakeKey] ?? fallback;
}

export function tokenMetadataPolicyFromEnv(env = process.env) {
  return {
    chainId: normalizeString(env.CHAIN_ID || "137"),
    tokenContract: normalizeString(env.TOKEN_CONTRACT),
    decimals: Number(env.TOKEN_DECIMALS || APPROVED_TOKEN_DECIMALS),
    symbol: normalizeString(env.TOKEN_SYMBOL || "JPYC"),
    name: normalizeString(env.APPROVED_TOKEN_NAME),
    codeHash: normalizeString(env.APPROVED_TOKEN_CODE_HASH),
    implementationCodeHash: normalizeString(env.APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH),
    requireApprovalPins: ["1", "true", "yes", "on"].includes(
      normalizeString(env.REQUIRE_TOKEN_METADATA_PINS).toLowerCase()
    ),
  };
}

/**
 * Purely assesses already-collected metadata. Raw RPC URLs and RPC error text are
 * intentionally excluded so the result is safe to persist as release evidence.
 */
export function assessTokenMetadataSnapshot(snapshot = {}, policy = {}) {
  const failures = [];
  const warnings = [];
  const expectedChainId = normalizeUnsignedInteger(policyValue(policy, "chainId", "chain_id"));
  const expectedTokenContract = normalizeAddress(policyValue(policy, "tokenContract", "token_contract"));
  const expectedDecimals = normalizeDecimals(policyValue(policy, "decimals", "token_decimals"));
  const expectedSymbol = normalizeString(policyValue(policy, "symbol", "token_symbol"));
  const expectedName = normalizeString(policyValue(policy, "name", "token_name"));
  const configuredCodeHash = normalizeString(policyValue(policy, "codeHash", "code_hash"));
  const configuredImplementationCodeHash = normalizeString(
    policyValue(policy, "implementationCodeHash", "implementation_code_hash")
  );
  const expectedCodeHash = normalizeHash(configuredCodeHash);
  const expectedImplementationCodeHash = normalizeHash(configuredImplementationCodeHash);
  const requireApprovalPins = policyValue(policy, "requireApprovalPins", "require_approval_pins", false) === true;

  if (!expectedChainId) failures.push({ code: "INVALID_POLICY_CHAIN_ID", field: "chain_id" });
  if (!expectedTokenContract) failures.push({ code: "INVALID_POLICY_TOKEN_CONTRACT", field: "token_contract" });
  if (expectedDecimals == null) failures.push({ code: "INVALID_POLICY_TOKEN_DECIMALS", field: "decimals" });
  if (!expectedSymbol) failures.push({ code: "INVALID_POLICY_TOKEN_SYMBOL", field: "symbol" });
  if (configuredCodeHash && !expectedCodeHash) failures.push({ code: "INVALID_POLICY_CODE_HASH", field: "code_hash" });
  if (configuredImplementationCodeHash && !expectedImplementationCodeHash) {
    failures.push({ code: "INVALID_POLICY_IMPLEMENTATION_CODE_HASH", field: "implementation_code_hash" });
  }
  if (requireApprovalPins && !expectedName) failures.push({ code: "TOKEN_NAME_PIN_MISSING", field: "name" });
  if (requireApprovalPins && !expectedCodeHash) failures.push({ code: "TOKEN_CODE_HASH_PIN_MISSING", field: "code_hash" });
  if (requireApprovalPins && !expectedImplementationCodeHash) {
    failures.push({ code: "IMPLEMENTATION_CODE_HASH_PIN_MISSING", field: "implementation_code_hash" });
  }

  const observed = {
    chain_id: normalizeUnsignedInteger(snapshot.chain_id ?? snapshot.chainId),
    latest_block: normalizeUnsignedInteger(snapshot.latest_block ?? snapshot.latestBlock),
    token_contract: normalizeAddress(snapshot.token_contract ?? snapshot.tokenContract),
    decimals: normalizeDecimals(snapshot.decimals),
    symbol: normalizeString(snapshot.symbol),
    name: normalizeString(snapshot.name),
    code_present: Boolean(normalizeBytecode(snapshot.code)),
    code_hash: normalizeHash(snapshot.code_hash ?? snapshot.codeHash) || bytecodeHash(snapshot.code),
    implementation_address: normalizeAddress(snapshot.implementation_address ?? snapshot.implementationAddress) || null,
    implementation_code_present: Boolean(normalizeBytecode(snapshot.implementation_code ?? snapshot.implementationCode)),
    implementation_code_hash:
      normalizeHash(snapshot.implementation_code_hash ?? snapshot.implementationCodeHash)
      || bytecodeHash(snapshot.implementation_code ?? snapshot.implementationCode)
      || null,
  };

  if (!observed.chain_id || observed.chain_id !== expectedChainId) {
    failures.push({ code: "CHAIN_ID_MISMATCH", field: "chain_id", expected: expectedChainId, actual: observed.chain_id || null });
  }
  if (!observed.latest_block) failures.push({ code: "LATEST_BLOCK_INVALID", field: "latest_block" });
  if (!observed.token_contract || observed.token_contract !== expectedTokenContract) {
    failures.push({
      code: "TOKEN_CONTRACT_MISMATCH",
      field: "token_contract",
      expected: expectedTokenContract || null,
      actual: observed.token_contract || null,
    });
  }
  if (observed.decimals == null || observed.decimals !== expectedDecimals) {
    failures.push({ code: "TOKEN_DECIMALS_MISMATCH", field: "decimals", expected: expectedDecimals, actual: observed.decimals });
  }
  if (!observed.symbol || observed.symbol !== expectedSymbol) {
    failures.push({ code: "TOKEN_SYMBOL_MISMATCH", field: "symbol", expected: expectedSymbol || null, actual: observed.symbol || null });
  }
  if (!observed.name) failures.push({ code: "TOKEN_NAME_EMPTY", field: "name" });
  if (expectedName && observed.name !== expectedName) {
    failures.push({ code: "TOKEN_NAME_MISMATCH", field: "name", expected: expectedName, actual: observed.name || null });
  }
  if (!observed.code_present || !observed.code_hash) failures.push({ code: "TOKEN_CODE_MISSING", field: "code" });
  if (expectedCodeHash && observed.code_hash !== expectedCodeHash) {
    failures.push({ code: "TOKEN_CODE_HASH_MISMATCH", field: "code_hash", expected: expectedCodeHash, actual: observed.code_hash || null });
  }
  if (expectedImplementationCodeHash && observed.implementation_code_hash !== expectedImplementationCodeHash) {
    failures.push({
      code: "IMPLEMENTATION_CODE_HASH_MISMATCH",
      field: "implementation_code_hash",
      expected: expectedImplementationCodeHash,
      actual: observed.implementation_code_hash,
    });
  }
  if (expectedImplementationCodeHash && !observed.implementation_address) {
    failures.push({ code: "IMPLEMENTATION_ADDRESS_MISSING", field: "implementation_address" });
  }
  if (observed.implementation_address && !observed.implementation_code_present) {
    failures.push({ code: "IMPLEMENTATION_CODE_MISSING", field: "implementation_code" });
  }

  if (!expectedName && !requireApprovalPins) warnings.push({ code: "TOKEN_NAME_NOT_PINNED", field: "name" });
  if (!expectedCodeHash && !requireApprovalPins) warnings.push({ code: "TOKEN_CODE_HASH_NOT_PINNED", field: "code_hash" });
  if (observed.implementation_address && !expectedImplementationCodeHash && !requireApprovalPins) {
    warnings.push({ code: "IMPLEMENTATION_CODE_HASH_NOT_PINNED", field: "implementation_code_hash" });
  }

  return {
    ok: failures.length === 0,
    endpoint_state: failures.length === 0 ? "verified" : "quarantined",
    endpoint_id: normalizeString(snapshot.endpoint_id ?? snapshot.endpointId) || null,
    observed,
    failures,
    warnings,
  };
}

async function queryField(field, query) {
  try {
    return await query();
  } catch (_error) {
    throw Object.assign(new Error("RPC metadata query failed"), { field });
  }
}

async function callMetadataFunction(rpcRequest, rpcUrl, tokenContract, functionName, blockTag) {
  const data = metadataInterface.encodeFunctionData(functionName);
  const encoded = await rpcRequest(rpcUrl, "eth_call", [{ to: tokenContract, data }, blockTag]);
  const [value] = metadataInterface.decodeFunctionResult(functionName, encoded);
  return value;
}

async function collectRpcTokenMetadata({ rpcUrl, rpcRequest, policy }) {
  const tokenContract = normalizeAddress(policyValue(policy, "tokenContract", "token_contract"));
  if (!tokenContract) throw Object.assign(new Error("invalid token contract policy"), { field: "token_contract" });

  const latestBlock = await queryField("latest_block", () => rpcRequest(rpcUrl, "eth_blockNumber", []));
  const blockTag = normalizeBlockTag(latestBlock);
  if (!blockTag) throw Object.assign(new Error("invalid latest block"), { field: "latest_block" });
  const [chainId, code, decimals, symbol, name, implementationStorage] = await Promise.all([
    queryField("chain_id", () => rpcRequest(rpcUrl, "eth_chainId", [])),
    queryField("code", () => rpcRequest(rpcUrl, "eth_getCode", [tokenContract, blockTag])),
    queryField("decimals", () => callMetadataFunction(rpcRequest, rpcUrl, tokenContract, "decimals", blockTag)),
    queryField("symbol", () => callMetadataFunction(rpcRequest, rpcUrl, tokenContract, "symbol", blockTag)),
    queryField("name", () => callMetadataFunction(rpcRequest, rpcUrl, tokenContract, "name", blockTag)),
    queryField("implementation_slot", () => rpcRequest(rpcUrl, "eth_getStorageAt", [
      tokenContract,
      ERC1967_IMPLEMENTATION_SLOT,
      blockTag,
    ])),
  ]);
  const implementationAddress = implementationAddressFromStorage(implementationStorage);
  const implementationCode = implementationAddress
    ? await queryField("implementation_code", () => rpcRequest(rpcUrl, "eth_getCode", [implementationAddress, blockTag]))
    : "";

  return {
    endpoint_id: endpointId(rpcUrl),
    chain_id: chainId,
    latest_block: latestBlock,
    token_contract: tokenContract,
    decimals,
    symbol,
    name,
    code,
    implementation_address: implementationAddress,
    implementation_code: implementationCode,
  };
}

/**
 * Queries one endpoint and always returns a safe verified/quarantined result.
 * It never returns the raw URL or an RPC error message that may contain secrets.
 */
export async function verifyRpcEndpointTokenMetadata({ rpcUrl, rpcRequest, policy } = {}) {
  const safeEndpointId = endpointId(rpcUrl);
  if (typeof rpcRequest !== "function") {
    return {
      ok: false,
      endpoint_state: "quarantined",
      endpoint_id: safeEndpointId,
      observed: null,
      failures: [{ code: "RPC_REQUEST_HANDLER_MISSING", field: "rpc_request" }],
      warnings: [],
    };
  }
  try {
    const snapshot = await collectRpcTokenMetadata({ rpcUrl, rpcRequest, policy });
    return assessTokenMetadataSnapshot(snapshot, policy);
  } catch (error) {
    return {
      ok: false,
      endpoint_state: "quarantined",
      endpoint_id: safeEndpointId,
      observed: null,
      failures: [{ code: "RPC_METADATA_QUERY_FAILED", field: normalizeString(error?.field) || "rpc_metadata" }],
      warnings: [],
    };
  }
}

export async function verifyRpcTokenMetadataEndpoints({ rpcUrls = [], rpcRequest, policy } = {}) {
  // Preserve positional correspondence with the caller's provider list so the
  // returned endpoint state can be used as a quarantine mask.
  const configured = (Array.isArray(rpcUrls) ? rpcUrls : []).map((value) => normalizeString(value)).filter(Boolean);
  const endpoints = await Promise.all(
    configured.map((rpcUrl) => verifyRpcEndpointTokenMetadata({ rpcUrl, rpcRequest, policy }))
  );
  const verified = endpoints.filter((endpoint) => endpoint.endpoint_state === "verified");
  const quarantined = endpoints.filter((endpoint) => endpoint.endpoint_state === "quarantined");
  return {
    ok: configured.length > 0 && quarantined.length === 0,
    configured_count: configured.length,
    verified_count: verified.length,
    quarantined_count: quarantined.length,
    endpoints,
  };
}
