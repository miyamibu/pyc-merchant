import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  ingestManualPayment,
  loginAs,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

function runNode(scriptPath, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(
      "node",
      [scriptPath, ...args],
      {
        cwd: CWD,
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
}

test("settlement evidence pack script emits required files and columns", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const paidInvoice = await createInvoice(started.baseUrl, admin.token, 1200, `pack-paid-${Date.now()}`);
  assert.equal(paidInvoice.status, 201);
  const paidIngest = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: paidInvoice.data.invoice_id,
      amount_jpyc: 1200,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("pack-paid"),
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    `pack-paid-ingest-${Date.now()}`
  );
  assert.equal(paidIngest.status, 200);

  const reviewInvoice = await createInvoice(started.baseUrl, admin.token, 1300, `pack-review-${Date.now()}`);
  assert.equal(reviewInvoice.status, 201);
  const overpay = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: reviewInvoice.data.invoice_id,
      amount_jpyc: 1400,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("pack-overpay"),
      from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    `pack-overpay-ingest-${Date.now()}`
  );
  assert.equal(overpay.status, 200);

  const businessDateJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const close = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `pack-close-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst, admin_approval: true }),
  });
  assert.equal(close.status, 409);
  assert.equal(close.data.error.code, "SETTLEMENT_HARD_GATE_BLOCKED");
  assert.ok(close.data.error.details.blockers.some((blocker) => blocker.code === "OPEN_REVIEW_INCIDENTS"));

  // Seed a closed settlement and its frozen export row after the blocked-close
  // assertion. The evidence generator must use this snapshot only and must
  // not discover the live review invoice through joins.
  const settlementId = randomUUID();
  const exportRunId = randomUUID();
  const rowId = randomUUID();
  const createdAt = new Date().toISOString();
  const frozenEvidence = {
    payment_attempts: [],
    payment_events: [],
    review_incidents: [],
    review_incident_events: [],
    refunds: [],
    adjustments: [],
  };
  const payload = {
    id: rowId,
    settlement_id: settlementId,
    settlement_export_run_id: exportRunId,
    export_run_id: exportRunId,
    business_date: businessDateJst,
    store_id: "store-001",
    invoice_id: paidInvoice.data.invoice_id,
    invoice_no: paidInvoice.data.invoice_no || null,
    checkout_session_id: null,
    payment_session_id: null,
    terminal_id: null,
    operator_id: null,
    invoice_status: "paid",
    accounting_status: "onchain_cash_confirmed",
    cash_recognition_status: "onchain_confirmed",
    receivable_status: "none",
    invoice_amount_jpyc_base: "1200000000",
    onchain_cash_amount_jpyc_base: "1200000000",
    provider_receivable_amount_jpyc_base: "0",
    exception_amount_jpyc_base: "0",
    refund_amount_jpyc_base: "0",
    void_amount_jpyc_base: "0",
    primary_tx_hash: null,
    evidence_hash: "frozen-evidence-test",
    frozen_evidence: frozenEvidence,
  };
  const db = new Database(env.DB_PATH);
  db.prepare(
    `INSERT INTO settlements
     (id, merchant_id, store_id, business_date, timezone, period_start_utc, period_end_utc,
      invoice_count, total_billed_jpy, total_paid_jpyc, total_paid_jpyc_base, review_count, created_by, created_at)
     VALUES (?, 'merchant-001', 'store-001', ?, 'Asia/Tokyo', ?, ?, 1, 1200, 1200, 1200000000, 0, ?, ?)`
  ).run(
    settlementId,
    businessDateJst,
    `${businessDateJst}T00:00:00.000Z`,
    `${businessDateJst}T23:59:59.999Z`,
    admin.sessionId,
    createdAt,
  );
  db.prepare(
    `INSERT INTO settlement_export_runs
     (id, settlement_id, export_version, business_date, store_id, terminal_id, status, exported_at, created_by, created_at)
     VALUES (?, ?, 'v2', ?, 'store-001', NULL, 'completed', ?, ?, ?)`
  ).run(exportRunId, settlementId, businessDateJst, createdAt, admin.sessionId, createdAt);
  db.prepare(
    `INSERT INTO settlement_export_rows
     (id, export_run_id, export_version, business_date, store_id, terminal_id, operator_id, invoice_id,
      checkout_session_id, payment_session_id, rail_type, provider_code, invoice_amount_jpyc_base,
      invoice_status, accounting_status, cash_recognition_status, receivable_status,
      onchain_cash_amount_jpyc_base, provider_receivable_amount_jpyc_base, exception_amount_jpyc_base,
      refund_amount_jpyc_base, void_amount_jpyc_base, evidence_hash, payload_json,
      payload_schema_version, export_excluded_private_data, created_at)
     VALUES (?, ?, 'v2', ?, 'store-001', NULL, NULL, ?, NULL, NULL, 'wallet_direct', 'self_wallet',
             1200000000, 'paid', 'onchain_cash_confirmed', 'onchain_confirmed', 'none',
             1200000000, 0, 0, 0, 0, ?, ?, 'settlement_export_v2', 1, ?)`
  ).run(rowId, exportRunId, businessDateJst, paidInvoice.data.invoice_id, payload.evidence_hash, JSON.stringify(payload), createdAt);
  db.close();

  const outDir = mkdtempSync(path.join(tmpdir(), "jpyc-settlement-pack-"));
  const result = await runNode("scripts/production-validation/generate-settlement-evidence-pack.mjs", [
    "--db-path",
    env.DB_PATH,
    "--store-id",
    "store-001",
    "--settlement-id",
    settlementId,
    "--settlement-export-run-id",
    exportRunId,
    "--business-date",
    businessDateJst,
    "--output-dir",
    outDir,
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);

  for (const file of [
    "settlement-summary.json",
    "settlement-summary.csv",
    "invoices.csv",
    "payment-attempts.csv",
    "review-incidents.csv",
    "refunds.csv",
    "payment-events.csv",
    "adjustments.csv",
    "audit-chain-verification.json",
    "manifest.json",
    "README.md",
  ]) {
    assert.equal(fs.existsSync(path.join(outDir, file)), true, file);
  }

  const invoicesCsv = fs.readFileSync(path.join(outDir, "invoices.csv"), "utf8");
  assert.match(invoicesCsv, /settlement_id/);
  assert.match(invoicesCsv, /settlement_export_run_id/);
  assert.match(invoicesCsv, /invoice_id/);
});
