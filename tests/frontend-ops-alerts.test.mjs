import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

// P0-UX-01: Payment conditions card shown before payment (MATIC, split, chain warnings)
test("P0-UX-01 mobile shows payment conditions card with MATIC and refund warnings before payment", () => {
  const mobileHtml = read("public/mobile.html");
  const mobileJs = read("public/mobile.js");

  assert.match(mobileHtml, /id="paymentConditionsCard"/);
  assert.match(mobileHtml, /MATIC/);
  assert.match(mobileHtml, /分割送金/);
  assert.match(mobileHtml, /返金対応外/);

  assert.match(mobileJs, /renderPaymentConditions/);
  assert.match(mobileJs, /paymentConditionsCard/);
  assert.match(mobileJs, /WAITING_STATUSES/);
  assert.match(mobileJs, /MATIC/);
});

// P0-UX-02: Receipt card shown after payment with tx hash and copy button
test("P0-UX-02 mobile shows receipt card after payment with all fields and copy button", () => {
  const mobileHtml = read("public/mobile.html");
  const mobileJs = read("public/mobile.js");

  assert.match(mobileHtml, /id="receiptCard"/);
  assert.match(mobileHtml, /id="receiptStoreName"/);
  assert.match(mobileHtml, /id="receiptAmount"/);
  assert.match(mobileHtml, /id="receiptInvoiceId"/);
  assert.match(mobileHtml, /id="receiptTxHash"/);
  assert.match(mobileHtml, /id="copyReceiptBtn"/);
  assert.match(mobileHtml, /お支払い確認書/);

  assert.match(mobileJs, /renderReceiptCard/);
  assert.match(mobileJs, /receiptCard/);
  assert.match(mobileJs, /receiptTxHash/);
  assert.match(mobileJs, /copyReceiptBtn/);
  assert.match(mobileJs, /handleCopyReceipt/);
});

// P0-UX-03: confirming state explicitly warns against double-send
test("P0-UX-03 mobile confirming state warns against double-send", () => {
  const mobileJs = read("public/mobile.js");

  assert.match(mobileJs, /confirming/);
  assert.match(mobileJs, /二重送/);
});

// P0-OPS-01: terminal has address pool threshold and count display
test("P0-OPS-01 terminal has address pool warning threshold and count display", () => {
  const terminalJs = read("public/terminal.js");
  const terminalHtml = read("public/terminal.html");

  assert.match(terminalJs, /ADDRESS_POOL_WARN_THRESHOLD/);
  assert.match(terminalJs, /address_pool_available_count/);
  assert.match(terminalJs, /opsAddressPoolCount/);
  assert.match(terminalHtml, /id="opsAddressPoolCount"/);
  assert.match(terminalHtml, /受取アドレス残数/);
});

// P0-OPS-02: terminal has worker staleness detection
test("P0-OPS-02 terminal has worker staleness detection using worker:last_cycle_at", () => {
  const terminalJs = read("public/terminal.js");
  const terminalHtml = read("public/terminal.html");

  assert.match(terminalJs, /WORKER_STALE_WARN_SEC/);
  assert.match(terminalJs, /worker:last_cycle_at/);
  assert.match(terminalJs, /detectWorkerStaleSec/);
  assert.match(terminalJs, /opsWorkerStatus/);
  assert.match(terminalHtml, /id="opsWorkerStatus"/);
  assert.match(terminalHtml, /状態更新/);
});

// P0-OPS-03: terminal HTML and JS both reference the ops metrics elements
test("P0-OPS-03 terminal HTML and JS are consistent for new ops metric elements", () => {
  const terminalJs = read("public/terminal.js");
  const terminalHtml = read("public/terminal.html");

  assert.match(terminalHtml, /id="opsAddressPoolCount"/);
  assert.match(terminalHtml, /id="opsWorkerStatus"/);
  assert.match(terminalJs, /opsAddressPoolCount/);
  assert.match(terminalJs, /opsWorkerStatus/);
});

// P0-OPS-04: terminal auto-refreshes ops snapshot periodically
test("P0-OPS-04 terminal has startOpsAutoRefresh and stopOpsAutoRefresh wired into lifecycle", () => {
  const terminalJs = read("public/terminal.js");

  assert.match(terminalJs, /startOpsAutoRefresh/);
  assert.match(terminalJs, /stopOpsAutoRefresh/);
  assert.match(terminalJs, /autoRefreshTimer/);
  assert.match(terminalJs, /OPS_AUTO_REFRESH_INTERVAL_MS/);
  assert.match(terminalJs, /setInterval/);
  assert.match(terminalJs, /clearInterval/);
  assert.match(terminalJs, /beforeunload[\s\S]{0,200}stopOpsAutoRefresh/);
});

// P0-OPS-05: server chain-monitor/status includes address_pool_available_count
test("P0-OPS-05 server chain-monitor/status endpoint returns address_pool_available_count", () => {
  const server = read("src/server.mjs");

  const statusEndpointMatch = server.match(
    /app\.get\("\/api\/v1\/chain-monitor\/status"[\s\S]{0,2000}?}\s*\);/
  );
  assert.ok(statusEndpointMatch, "chain-monitor/status endpoint not found");

  const endpointBody = statusEndpointMatch[0];
  assert.match(endpointBody, /address_pool_available_count/);
  assert.match(endpointBody, /receive_addresses.*status.*available/);
});
