import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  JPYC_PREPAID_DENYLIST_CONTRACTS,
  OFFICIAL_JPYC_CONTRACT_ADDRESS,
  OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER,
  listEnabledPaymentChains,
  listSupportedPaymentChains,
  paymentChainForInvoiceRequest,
  validateOfficialJpycContract,
} from "../src/jpyc-contract-policy.mjs";

const ROOT = process.cwd();
const PREPAID_CONTRACT = "0x431D5dfF03120AFA4bDf332c61A6e1766eF37BDB";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("payment chain catalog contains the three official funds-transfer JPYC chains", () => {
  const chains = listSupportedPaymentChains();
  assert.deepEqual(chains.map((chain) => chain.chain_id), ["1", "43114", "137"]);
  for (const chain of chains) {
    assert.equal(chain.token_contract, OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER);
    assert.equal(validateOfficialJpycContract(chain.token_contract).ok, true);
  }
});

test("deployment allowlist defaults to Polygon and can explicitly enable all supported chains", () => {
  assert.deepEqual(listEnabledPaymentChains().map((chain) => chain.chain_id), ["137"]);
  assert.equal(paymentChainForInvoiceRequest("137").chain.network, "Polygon");
  assert.equal(paymentChainForInvoiceRequest("1").error.code, "PAYMENT_CHAIN_DISABLED");
  assert.equal(paymentChainForInvoiceRequest("1", "1,43114,137").chain.network, "Ethereum Mainnet");
  assert.equal(paymentChainForInvoiceRequest("43114", "1,43114,137").chain.network, "Avalanche C-Chain");
  assert.equal(paymentChainForInvoiceRequest("999").error.code, "UNSUPPORTED_PAYMENT_CHAIN");
});

test("JPYC Prepaid contract is denied and official source metadata is exposed", () => {
  assert.ok(JPYC_PREPAID_DENYLIST_CONTRACTS.includes(PREPAID_CONTRACT.toLowerCase()));
  assert.equal(validateOfficialJpycContract(PREPAID_CONTRACT).code, "DENIED_JPYC_PREPAID_CONTRACT");
  assert.equal(validateOfficialJpycContract(OFFICIAL_JPYC_CONTRACT_ADDRESS).ok, true);
});

test("invoice API requires payment_chain_id while raw chain/token/recipient remain server controlled", () => {
  const server = read("src/server.mjs");
  assert.match(server, /payment_chain_id is required/);
  assert.match(server, /paymentChainForInvoiceRequest\(paymentChainId, ENABLED_PAYMENT_CHAIN_IDS\)/);
  assert.match(server, /INVOICE_FORBIDDEN_FIELDS[\s\S]*"chain_id"[\s\S]*"token_contract"[\s\S]*"recipient_address"/);
});

test("manual payment and refund verification select RPC providers by invoice or refund chain", () => {
  const server = read("src/server.mjs");
  assert.match(server, /const rpcProvidersByChain = new Map/);
  assert.match(server, /invoiceChainId = String\(invoice\.chain_id \|\| CHAIN_ID\)/);
  assert.match(server, /chainId: String\(refund\.refund_chain_id \|\| CHAIN_ID\)/);
  assert.doesNotMatch(server, /String\(rpcChainId\) !== String\(CHAIN_ID\)/);
});

test("startup denylist scan covers direct and payload contract evidence", () => {
  const server = read("src/server.mjs");
  for (const table of ["stores", "invoices", "receive_addresses", "payment_events", "chain_unmatched_events", "refund_requests"]) {
    assert.match(server, new RegExp(`table: "${table}"`));
  }
  for (const table of ["payment_attempts", "chain_dead_letters", "suspicious_activity_logs", "settlement_export_rows"]) {
    assert.match(server, new RegExp(`table: "${table}"`));
  }
});
