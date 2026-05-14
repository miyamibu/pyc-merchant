import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  ingestManualPayment,
  loginAs,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

async function importReceiveAddresses(baseUrl, token, count = 8, offset = 700) {
  const addresses = Array.from({ length: count }, (_value, index) => ({
    address: `0x${String(offset + index).padStart(40, "0")}`,
    control_proof_type: "external_approval",
    approval_ref: `ADDR-EXPORT-${offset + index}`,
    audit_evidence_ref: `AUDIT-EXPORT-${offset + index}`,
  }));
  const res = await apiRequest(baseUrl, "/api/v1/admin/receive-addresses:import", {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `export-addresses-${Date.now()}-${offset}`,
    }),
    body: JSON.stringify({ source_label: "export-tests", addresses }),
  });
  assert.equal(res.status, 201);
}

async function startExportServer(t, overrides = {}) {
  const env = baseServerEnv(overrides);
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });
  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  await importReceiveAddresses(started.baseUrl, admin.token);
  return { env, started, db, admin };
}

function businessDateJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test("open and expired unpaid invoices are not exported as cancelled", async (t) => {
  const ctx = await startExportServer(t);
  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1000, `open-export-${Date.now()}`);
  assert.equal(created.status, 201);
  const date = businessDateJst();

  const exported = await apiRequest(ctx.started.baseUrl, `/api/v1/settlements/daily:export?business_date=${date}&format=json`, {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.rows.some((row) => row.invoice_id === created.data.invoice_id), false);

  ctx.db.prepare(`UPDATE invoices SET status = 'expired', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), created.data.invoice_id);
  const expired = await apiRequest(ctx.started.baseUrl, `/api/v1/settlements/daily:export?business_date=${date}&format=json`, {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(expired.status, 200);
  assert.equal(expired.data.rows.some((row) => row.invoice_id === created.data.invoice_id && row.accounting_status === "cancelled"), false);
});

test("monthly export preserves row-specific business_date values", async (t) => {
  const ctx = await startExportServer(t);
  const first = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1100, `monthly-a-${Date.now()}`);
  assert.equal(first.status, 201);
  const firstDetail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, first.data.invoice_id);
  await ingestManualPayment(ctx.started.baseUrl, ctx.admin.token, {
    invoice_id: first.data.invoice_id,
    amount_jpyc_base: firstDetail.data.amounts.amount_jpyc_base,
    chain_id: ctx.env.CHAIN_ID,
    token_contract: ctx.env.TOKEN_CONTRACT,
    to_address: firstDetail.data.chain.recipient_address,
    confirmations: 2,
    tx_hash: randomTxHash("monthly-a"),
    from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }, `monthly-a-pay-${Date.now()}`);

  const second = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1200, `monthly-b-${Date.now()}`);
  assert.equal(second.status, 201);
  const secondDetail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, second.data.invoice_id);
  await ingestManualPayment(ctx.started.baseUrl, ctx.admin.token, {
    invoice_id: second.data.invoice_id,
    amount_jpyc_base: secondDetail.data.amounts.amount_jpyc_base,
    chain_id: ctx.env.CHAIN_ID,
    token_contract: ctx.env.TOKEN_CONTRACT,
    to_address: secondDetail.data.chain.recipient_address,
    confirmations: 2,
    tx_hash: randomTxHash("monthly-b"),
    from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }, `monthly-b-pay-${Date.now()}`);

  ctx.db.prepare(`UPDATE invoices SET created_at = ?, updated_at = ? WHERE id = ?`).run("2026-05-02T03:00:00.000Z", "2026-05-02T03:01:00.000Z", first.data.invoice_id);
  ctx.db.prepare(`UPDATE payment_events SET block_timestamp = ? WHERE invoice_id = ?`).run("2026-05-02T03:00:30.000Z", first.data.invoice_id);
  ctx.db.prepare(`UPDATE invoices SET created_at = ?, updated_at = ? WHERE id = ?`).run("2026-05-20T04:00:00.000Z", "2026-05-20T04:01:00.000Z", second.data.invoice_id);
  ctx.db.prepare(`UPDATE payment_events SET block_timestamp = ? WHERE invoice_id = ?`).run("2026-05-20T04:00:30.000Z", second.data.invoice_id);

  const exported = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/monthly:export?year_month=2026-05&format=json", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(exported.status, 200);
  const dates = new Set(exported.data.rows.map((row) => row.business_date));
  assert.ok(dates.has("2026-05-02"));
  assert.ok(dates.has("2026-05-20"));
  assert.equal(dates.has("2026-05-01"), false);
});

test("settlement_export_rows payload_json satisfies required v1 fields and audit_log_refs resolve", async (t) => {
  const ctx = await startExportServer(t);
  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1300, `payload-json-${Date.now()}`);
  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  await ingestManualPayment(ctx.started.baseUrl, ctx.admin.token, {
    invoice_id: created.data.invoice_id,
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    chain_id: ctx.env.CHAIN_ID,
    token_contract: ctx.env.TOKEN_CONTRACT,
    to_address: detail.data.chain.recipient_address,
    confirmations: 2,
    tx_hash: randomTxHash("payload-json"),
    from_address: "0xcccccccccccccccccccccccccccccccccccccccc",
  }, `payload-json-pay-${Date.now()}`);

  const close = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `payload-json-close-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst() }),
  });
  assert.equal(close.status, 200);

  const schema = JSON.parse(fs.readFileSync(path.join(CWD, "docs/contracts/settlement-export-v1.schema.json"), "utf8"));
  const rows = ctx.db.prepare(`SELECT payload_json FROM settlement_export_rows WHERE export_run_id = ?`).all(close.data.export_run_id);
  assert.ok(rows.length > 0);
  for (const { payload_json: payloadJson } of rows) {
    const payload = JSON.parse(payloadJson);
    for (const key of schema.required) assert.ok(Object.prototype.hasOwnProperty.call(payload, key), key);
    for (const auditId of payload.audit_log_refs) {
      const audit = ctx.db.prepare(`SELECT id FROM audit_logs WHERE id = ?`).get(auditId);
      assert.ok(audit, `audit_log_refs entry must resolve: ${auditId}`);
    }
  }
});
