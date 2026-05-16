import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
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
  assert.equal(close.status, 200);

  const outDir = mkdtempSync(path.join(tmpdir(), "jpyc-settlement-pack-"));
  const result = await runNode("scripts/production-validation/generate-settlement-evidence-pack.mjs", [
    "--db-path",
    env.DB_PATH,
    "--store-id",
    "store-001",
    "--business-date",
    businessDateJst,
    "--output-dir",
    outDir,
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);

  for (const file of [
    "settlement-summary.json",
    "settlement-summary.csv",
    "settlement-export-v1.jsonl",
    "settlement-export-v1.csv",
    "settlement-export-v1.schema-validation.json",
    "settlement-export-v1-traceability-check.json",
    "invoices.csv",
    "payment-attempts.csv",
    "review-cases.csv",
    "refunds.csv",
    "audit-chain-verification.json",
    "README.md",
  ]) {
    assert.equal(fs.existsSync(path.join(outDir, file)), true, file);
  }

  const invoicesCsv = fs.readFileSync(path.join(outDir, "invoices.csv"), "utf8");
  assert.match(invoicesCsv, /reason_code/);
  assert.match(invoicesCsv, /block_timestamp/);
  assert.match(invoicesCsv, /detected_at/);
  assert.match(invoicesCsv, /refund_status/);
  assert.match(invoicesCsv, /audit_ref/);
  const schemaValidation = JSON.parse(fs.readFileSync(path.join(outDir, "settlement-export-v1.schema-validation.json"), "utf8"));
  assert.equal(schemaValidation.ok, true);
  assert.ok(schemaValidation.row_count > 0);
  const traceability = JSON.parse(fs.readFileSync(path.join(outDir, "settlement-export-v1-traceability-check.json"), "utf8"));
  assert.equal(traceability.ok, true);
  const v1Jsonl = fs.readFileSync(path.join(outDir, "settlement-export-v1.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(v1Jsonl.every((row) => row.export_version === "v1" && row.payload_schema_version === "settlement_export_v1"));

  const db = new Database(env.DB_PATH);
  try {
    db.prepare(`UPDATE settlement_export_rows SET payload_json = NULL WHERE export_run_id = ?`).run(close.data.export_run_id);
  } finally {
    db.close();
  }
  const legacyOutDir = mkdtempSync(path.join(tmpdir(), "jpyc-settlement-pack-legacy-"));
  const legacyResult = await runNode("scripts/production-validation/generate-settlement-evidence-pack.mjs", [
    "--db-path",
    env.DB_PATH,
    "--store-id",
    "store-001",
    "--business-date",
    businessDateJst,
    "--output-dir",
    legacyOutDir,
  ]);
  assert.equal(legacyResult.code, 0, legacyResult.stderr || legacyResult.stdout);
  const legacyValidation = JSON.parse(fs.readFileSync(path.join(legacyOutDir, "settlement-export-v1.schema-validation.json"), "utf8"));
  assert.equal(legacyValidation.ok, false);
  assert.ok(legacyValidation.errors.some((error) => error.error === "invalid_payload_schema_version"));
  const legacyJsonl = fs.readFileSync(path.join(legacyOutDir, "settlement-export-v1.jsonl"), "utf8");
  assert.match(legacyJsonl, /missing_payload_json/);
});
