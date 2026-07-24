import test from "node:test";
import assert from "node:assert/strict";
import { Interface, keccak256 } from "ethers";
import {
  convertBaseUnitsBetweenDecimals,
  parseDecimalToBaseUnits,
  scaleToDecimals,
} from "../src/amounts.mjs";
import { buildEip681PaymentUri } from "../src/wallet-adapter.mjs";
import {
  APPROVED_LEDGER_BASE_UNIT_SCALE,
  APPROVED_TOKEN_DECIMALS,
  assessTokenMetadataSnapshot,
  verifyRpcEndpointTokenMetadata,
  verifyRpcTokenMetadataEndpoints,
} from "../src/token-metadata.mjs";

const tokenContract = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const recipient = "0x2222222222222222222222222222222222222222";
const implementationAddress = "0x3333333333333333333333333333333333333333";
const tokenCode = "0x6001600055";
const implementationCode = "0x6002600055";
const metadataInterface = new Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

function policy(overrides = {}) {
  return {
    chainId: "137",
    tokenContract,
    decimals: APPROVED_TOKEN_DECIMALS,
    symbol: "JPYC",
    name: "JPY Coin",
    codeHash: keccak256(tokenCode),
    ...overrides,
  };
}

function rpcHandler(overrides = {}) {
  const values = {
    chainId: "0x89",
    latestBlock: "0x64",
    decimals: 18,
    symbol: "JPYC",
    name: "JPY Coin",
    tokenCode,
    implementationAddress,
    implementationCode,
    ...overrides,
  };
  return async (_rpcUrl, method, params) => {
    if (values.errorMethod === method) throw new Error("secret-bearing upstream error text");
    if (method === "eth_chainId") return values.chainId;
    if (method === "eth_blockNumber") return values.latestBlock;
    if (method === "eth_getCode") {
      return String(params?.[0] || "").toLowerCase() === implementationAddress.toLowerCase()
        ? values.implementationCode
        : values.tokenCode;
    }
    if (method === "eth_getStorageAt") {
      if (!values.implementationAddress) return "0x0";
      return `0x${values.implementationAddress.slice(2).padStart(64, "0")}`;
    }
    if (method === "eth_call") {
      const selector = String(params?.[0]?.data || "").slice(0, 10);
      if (selector === metadataInterface.getFunction("decimals").selector) {
        return metadataInterface.encodeFunctionResult("decimals", [values.decimals]);
      }
      if (selector === metadataInterface.getFunction("symbol").selector) {
        return metadataInterface.encodeFunctionResult("symbol", [values.symbol]);
      }
      if (selector === metadataInterface.getFunction("name").selector) {
        return metadataInterface.encodeFunctionResult("name", [values.name]);
      }
    }
    throw new Error(`unsupported test method: ${method}`);
  };
}

test("RPC token metadata verifies chain, ERC-20 metadata, code, and approved implementation hash", async () => {
  const result = await verifyRpcEndpointTokenMetadata({
    rpcUrl: "https://user:secret@polygon-rpc.example.test/private-key",
    rpcRequest: rpcHandler(),
    policy: policy({ implementationCodeHash: keccak256(implementationCode) }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.endpoint_state, "verified");
  assert.match(result.endpoint_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.observed.chain_id, "137");
  assert.equal(result.observed.decimals, 18);
  assert.equal(result.observed.symbol, "JPYC");
  assert.equal(result.observed.name, "JPY Coin");
  assert.equal(result.observed.code_hash, keccak256(tokenCode).toLowerCase());
  assert.equal(result.observed.implementation_code_hash, keccak256(implementationCode).toLowerCase());
  assert.doesNotMatch(JSON.stringify(result), /user|secret|private-key/);
});

test("endpoint assessment quarantines every material metadata mismatch", () => {
  const baseSnapshot = {
    endpoint_id: "sha256:test",
    chain_id: "137",
    latest_block: "100",
    token_contract: tokenContract,
    decimals: 18,
    symbol: "JPYC",
    name: "JPY Coin",
    code: tokenCode,
  };
  const scenarios = [
    ["chain_id", "1", "CHAIN_ID_MISMATCH"],
    ["decimals", 6, "TOKEN_DECIMALS_MISMATCH"],
    ["symbol", "FAKE", "TOKEN_SYMBOL_MISMATCH"],
    ["name", "", "TOKEN_NAME_EMPTY"],
    ["code", "0x", "TOKEN_CODE_MISSING"],
  ];
  for (const [field, value, expectedCode] of scenarios) {
    const result = assessTokenMetadataSnapshot({ ...baseSnapshot, [field]: value }, policy());
    assert.equal(result.endpoint_state, "quarantined", field);
    assert.ok(result.failures.some((failure) => failure.code === expectedCode), field);
  }
});

test("implementation code hash is compared only when an approved value is configured", async () => {
  const unpinned = await verifyRpcEndpointTokenMetadata({
    rpcUrl: "https://polygon-a.example.test",
    rpcRequest: rpcHandler(),
    policy: policy(),
  });
  assert.equal(unpinned.ok, true);
  assert.ok(unpinned.warnings.some((warning) => warning.code === "IMPLEMENTATION_CODE_HASH_NOT_PINNED"));

  const missingCode = await verifyRpcEndpointTokenMetadata({
    rpcUrl: "https://polygon-missing-implementation.example.test",
    rpcRequest: rpcHandler({ implementationCode: "0x" }),
    policy: policy(),
  });
  assert.equal(missingCode.ok, false);
  assert.ok(missingCode.failures.some((failure) => failure.code === "IMPLEMENTATION_CODE_MISSING"));

  const missingProxy = await verifyRpcEndpointTokenMetadata({
    rpcUrl: "https://polygon-missing-proxy.example.test",
    rpcRequest: rpcHandler({ implementationAddress: null }),
    policy: policy({ implementationCodeHash: keccak256(implementationCode) }),
  });
  assert.equal(missingProxy.ok, false);
  assert.ok(missingProxy.failures.some((failure) => failure.code === "IMPLEMENTATION_ADDRESS_MISSING"));

  const mismatch = await verifyRpcEndpointTokenMetadata({
    rpcUrl: "https://polygon-b.example.test",
    rpcRequest: rpcHandler(),
    policy: policy({ implementationCodeHash: `0x${"f".repeat(64)}` }),
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.failures.some((failure) => failure.code === "IMPLEMENTATION_CODE_HASH_MISMATCH"));
});

test("batch verification exposes verified and quarantined endpoint counts without raw URLs", async () => {
  const handlers = new Map([
    ["https://polygon-good.example.test/key-a", rpcHandler()],
    ["https://ethereum-wrong.example.test/key-b", rpcHandler({ chainId: "0x1" })],
  ]);
  const result = await verifyRpcTokenMetadataEndpoints({
    rpcUrls: [
      "https://polygon-good.example.test/key-a",
      "https://polygon-good.example.test/key-a",
      "https://ethereum-wrong.example.test/key-b",
    ],
    rpcRequest: (url, method, params) => handlers.get(url)(url, method, params),
    policy: policy(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.configured_count, 3);
  assert.equal(result.verified_count, 2);
  assert.equal(result.quarantined_count, 1);
  assert.doesNotMatch(JSON.stringify(result), /key-a|key-b|polygon-good|ethereum-wrong/);
});

test("RPC query failures are quarantined without leaking upstream error text", async () => {
  const result = await verifyRpcEndpointTokenMetadata({
    rpcUrl: "https://account:credential@polygon.example.test/secret-path",
    rpcRequest: rpcHandler({ errorMethod: "eth_getCode" }),
    policy: policy(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.endpoint_state, "quarantined");
  assert.deepEqual(result.failures, [{ code: "RPC_METADATA_QUERY_FAILED", field: "code" }]);
  assert.doesNotMatch(JSON.stringify(result), /credential|secret-path|upstream error/);
});

test("EIP-681 boundaries convert the 1e6 ledger scale to 18-decimal token atomic amounts exactly", () => {
  const ledgerDecimals = scaleToDecimals(APPROVED_LEDGER_BASE_UNIT_SCALE);
  for (const amount of ["1", "1000", "100000000"]) {
    const ledgerBase = parseDecimalToBaseUnits(amount, ledgerDecimals);
    const tokenAtomic = convertBaseUnitsBetweenDecimals(ledgerBase, ledgerDecimals, APPROVED_TOKEN_DECIMALS);
    assert.equal(tokenAtomic.exact, true, amount);
    assert.equal(tokenAtomic.value, (BigInt(amount) * 10n ** 18n).toString(), amount);
    const uri = buildEip681PaymentUri({
      chainId: "137",
      tokenContract,
      receiveAddress: recipient,
      expectedAmountAtomic: tokenAtomic.value,
    });
    assert.match(uri, new RegExp(`uint256=${tokenAtomic.value}$`), amount);
    assert.deepEqual(
      convertBaseUnitsBetweenDecimals(tokenAtomic.value, APPROVED_TOKEN_DECIMALS, ledgerDecimals),
      { value: ledgerBase, exact: true },
      amount
    );
  }

  assert.equal(convertBaseUnitsBetweenDecimals("1", 18, 6).exact, false);
});
