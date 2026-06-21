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

test("payment-chain-config allows only the three official funds-transfer JPYC chains", () => {
  const chains = listSupportedPaymentChains();
  assert.deepEqual(chains.map((chain) => chain.chain_id), ["1", "43114", "137"]);
  for (const chain of chains) {
    assert.equal(chain.token_contract, OFFICIAL_JPYC_CONTRACT_ADDRESS_LOWER);
    assert.equal(validateOfficialJpycContract(chain.token_contract).ok, true);
  }
  assert.equal(paymentChainForInvoiceRequest("1", "1,43114,137").chain.network, "Ethereum Mainnet");
  assert.equal(paymentChainForInvoiceRequest("43114", "1,43114,137").chain.network, "Avalanche C-Chain");
  assert.equal(paymentChainForInvoiceRequest("137", "1,43114,137").chain.network, "Polygon");
  assert.equal(paymentChainForInvoiceRequest("999").error.code, "UNSUPPORTED_PAYMENT_CHAIN");
});

test("deployment allowlist defaults invoice issuance to Polygon only", () => {
  assert.deepEqual(listEnabledPaymentChains().map((chain) => chain.chain_id), ["137"]);
  assert.equal(paymentChainForInvoiceRequest("137").chain.network, "Polygon");
  assert.equal(paymentChainForInvoiceRequest("1").error.code, "PAYMENT_CHAIN_DISABLED");
  assert.equal(paymentChainForInvoiceRequest("43114").error.code, "PAYMENT_CHAIN_DISABLED");
  assert.equal(paymentChainForInvoiceRequest("1", "1,137").chain.network, "Ethereum Mainnet");
});

test("JPYC Prepaid/v2 contract is denylisted and not present in payment UI", () => {
  assert.ok(JPYC_PREPAID_DENYLIST_CONTRACTS.includes(PREPAID_CONTRACT.toLowerCase()));
  assert.equal(validateOfficialJpycContract(PREPAID_CONTRACT).code, "DENIED_JPYC_PREPAID_CONTRACT");
  for (const relativePath of ["public/terminal.html", "public/mobile.html", "public/terminal.js", "public/mobile.js"]) {
    assert.doesNotMatch(read(relativePath), new RegExp(PREPAID_CONTRACT, "i"), `${relativePath} must not surface prepaid JPYC`);
  }
});

test("invoice API stays server-controlled and requires payment_chain_id", () => {
  const server = read("src/server.mjs");
  assert.match(server, /payment_chain_id is required/);
  assert.match(server, /paymentChainForInvoiceRequest\(paymentChainId,\s*ENABLED_PAYMENT_CHAIN_IDS\)/);
  assert.match(server, /INVOICE_FORBIDDEN_FIELDS[\s\S]*"chain_id"[\s\S]*"token_contract"[\s\S]*"recipient_address"/);
  assert.match(read("src/jpyc-contract-policy.mjs"), new RegExp(OFFICIAL_JPYC_CONTRACT_ADDRESS, "i"));
});

test("manual and refund on-chain verification use the invoice or refund chain", () => {
  const server = read("src/server.mjs");
  assert.match(server, /RPC_URLS_1/);
  assert.match(server, /RPC_URLS_43114/);
  assert.match(server, /RPC_URLS_137/);
  assert.match(server, /function rpcProvidersForChain\(chainId\)/);
  assert.match(server, /expectedChainId = String\(invoice\.chain_id \|\| CHAIN_ID\)/);
  assert.match(server, /chain_id: expectedChainId/);
  assert.match(server, /expectedChainId: String\(refund\.refund_chain_id \|\| refund\.chain_id \|\| CHAIN_ID\)/);
  assert.doesNotMatch(server, /String\(rpcChainId\) !== String\(CHAIN_ID\)/);
});

test("startup denylist scan covers direct and payload contract evidence", () => {
  const server = read("src/server.mjs");
  for (const table of [
    "stores",
    "invoices",
    "receive_addresses",
    "payment_events",
    "chain_unmatched_events",
    "refund_requests",
  ]) {
    assert.match(server, new RegExp(`table: "${table}"`), `${table} must be denylist-scanned`);
  }
  for (const table of [
    "payment_attempts",
    "chain_dead_letters",
    "suspicious_activity_logs",
    "settlement_export_rows",
  ]) {
    assert.match(server, new RegExp(`table: "${table}"`), `${table} payload must be denylist-scanned`);
  }
});

test("terminal issued invoice view shows selected chain and official contract", () => {
  const terminalHtml = read("public/terminal.html");
  const terminalJs = read("public/terminal.js");
  assert.match(terminalHtml, /id="paymentChainText"/);
  assert.match(terminalHtml, /id="paymentContractText"/);
  assert.match(terminalJs, /paymentChainText: document\.getElementById\("paymentChainText"\)/);
  assert.match(terminalJs, /paymentContractText: document\.getElementById\("paymentContractText"\)/);
  assert.match(terminalJs, /selectedChainMeta\.token_contract_display/);
});

test("settlement export contract requires chain and official token trace fields", () => {
  const schema = JSON.parse(read("docs/contracts/settlement-export-v1.schema.json"));
  for (const field of ["chain_id", "network", "token_contract", "recipient_address"]) {
    assert.ok(schema.required.includes(field), `${field} must be required`);
    assert.ok(schema.properties[field], `${field} must have schema`);
  }
  assert.deepEqual(schema.properties.chain_id.enum, ["1", "43114", "137"]);
  assert.match(schema.properties.token_contract.pattern, /\[Ee\]7/);
});
