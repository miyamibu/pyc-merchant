import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  ingestManualPayment,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();
const REFUND_TO_ADDRESS = "0x4444444444444444444444444444444444444444";
const V1_HEADERS = [
  "export_run_id",
  "export_version",
  "business_date",
  "store_id",
  "terminal_id",
  "operator_id",
  "invoice_id",
  "checkout_session_id",
  "payment_session_id",
  "rail_type",
  "provider_code",
  "invoice_amount_jpyc_base",
  "invoice_status",
  "accounting_status",
  "cash_recognition_status",
  "receivable_status",
  "onchain_cash_amount_jpyc_base",
  "provider_receivable_amount_jpyc_base",
  "exception_amount_jpyc_base",
  "refund_amount_jpyc_base",
  "void_amount_jpyc_base",
  "provider_payment_ref",
  "provider_settlement_ref",
  "onchain_transfer_ref",
  "evidence_hash",
  "payload_schema_version",
  "export_excluded_private_data",
  "created_at",
];

function jsonHeaders(token, idempotencyKey) {
  return authHeaders(token, {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  });
}

function escapeLegacyCsvCell(value) {
  const raw = String(value ?? "");
  const firstNonSpace = raw.match(/[^\s]/)?.[0] || "";
  const safe = ["=", "+", "-", "@", "\t", "\r"].includes(firstNonSpace) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function legacyCsvBytes(row) {
  const csv = `${V1_HEADERS.join(",")}\n${V1_HEADERS.map((header) => escapeLegacyCsvCell(row[header])).join(",")}`;
  return Buffer.from(`\uFEFF${csv}`, "utf8");
}

function currentBusinessDateJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function createRefund(baseUrl, token, reviewCaseId, amount, idempotencyKey) {
  return apiRequest(baseUrl, "/api/v1/refunds", {
    method: "POST",
    headers: jsonHeaders(token, idempotencyKey),
    body: JSON.stringify({
      review_case_id: reviewCaseId,
      refund_amount_jpyc: amount,
      refund_to_address: REFUND_TO_ADDRESS,
      refund_chain_id: "137",
      reason: "OVERPAYMENT",
    }),
  });
}

test("Settlement Export v1 compatibility and v2 refund integrity", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const login = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalCode: env.TERMINAL_CODE, staffPin: env.STAFF_PIN }),
  });
  assert.equal(login.status, 201);
  const token = login.data.token;

  await t.test("stored v1 fixture keeps original read and download shapes", async () => {
    const createdAt = "2026-01-02T03:04:05.000Z";
    const runId = "legacy-v1-run";
    const exportId = "legacy-v1-export";
    const row = {
      id: "legacy-v1-row",
      export_run_id: runId,
      export_version: "v1",
      business_date: "2026-01-02",
      store_id: "store-001",
      terminal_id: "terminal-001",
      operator_id: "staff-001",
      invoice_id: "legacy-v1-invoice",
      checkout_session_id: "legacy-v1-checkout",
      payment_session_id: "legacy-v1-payment-session",
      rail_type: "wallet_direct",
      provider_code: "self_wallet",
      invoice_amount_jpyc_base: 1000000,
      invoice_status: "paid",
      accounting_status: "onchain_cash_confirmed",
      cash_recognition_status: "onchain_confirmed",
      receivable_status: "none",
      onchain_cash_amount_jpyc_base: 1000000,
      provider_receivable_amount_jpyc_base: 0,
      exception_amount_jpyc_base: 0,
      refund_amount_jpyc_base: 0,
      void_amount_jpyc_base: 0,
      provider_payment_ref: null,
      provider_settlement_ref: null,
      onchain_transfer_ref: "0xlegacy",
      evidence_hash: "legacy-evidence-hash",
      payload_schema_version: "settlement_export_v1",
      export_excluded_private_data: 1,
      created_at: createdAt,
    };
    const metadata = {
      export_run_id: runId,
      export_version: "v1",
      export_scope: "daily",
      totals: { onchain_cash_confirmed: { count: 1, amount_jpyc_base: "1000000" } },
      timezone: "Asia/Tokyo",
      period_start_utc: "2026-01-01T15:00:00.000Z",
      period_end_utc: "2026-01-02T14:59:59.999Z",
      row_count: 1,
      content_hashes: { json: "legacy-json-hash", csv: "legacy-csv-hash" },
      content_hash: "legacy-json-hash",
    };
    db.prepare(
      `INSERT INTO settlement_export_runs
       (id, export_version, business_date, store_id, terminal_id, status, exported_at, created_by, created_at)
       VALUES (?, 'v1', ?, 'store-001', 'terminal-001', 'completed', ?, 'staff-001', ?)`
    ).run(runId, row.business_date, createdAt, createdAt);
    db.prepare(
      `INSERT INTO settlement_export_rows
       (id, export_run_id, export_version, business_date, store_id, terminal_id, operator_id, invoice_id, checkout_session_id,
        payment_session_id, rail_type, provider_code, invoice_amount_jpyc_base, invoice_status, accounting_status,
        cash_recognition_status, receivable_status, onchain_cash_amount_jpyc_base, provider_receivable_amount_jpyc_base,
        exception_amount_jpyc_base, refund_amount_jpyc_base, void_amount_jpyc_base, provider_payment_ref, provider_settlement_ref,
        onchain_transfer_ref, evidence_hash, payload_schema_version, export_excluded_private_data, created_at)
       VALUES (@id, @export_run_id, @export_version, @business_date, @store_id, @terminal_id, @operator_id, @invoice_id, @checkout_session_id,
        @payment_session_id, @rail_type, @provider_code, @invoice_amount_jpyc_base, @invoice_status, @accounting_status,
        @cash_recognition_status, @receivable_status, @onchain_cash_amount_jpyc_base, @provider_receivable_amount_jpyc_base,
        @exception_amount_jpyc_base, @refund_amount_jpyc_base, @void_amount_jpyc_base, @provider_payment_ref, @provider_settlement_ref,
        @onchain_transfer_ref, @evidence_hash, @payload_schema_version, @export_excluded_private_data, @created_at)`
    ).run(row);
    db.prepare(
      `INSERT INTO settlement_exports
       (id, merchant_id, store_id, settlement_id, business_date, format, output_path, generated_by, generated_at, metadata_json)
       VALUES (?, 'merchant-001', 'store-001', NULL, ?, 'json', ?, 'staff-001', ?, ?)`
    ).run(exportId, row.business_date, `api://settlement-exports/${exportId}.json`, createdAt, JSON.stringify(metadata));

    const read = await apiRequest(started.baseUrl, `/api/v1/settlement-exports/${exportId}`, {
      headers: authHeaders(token),
    });
    assert.equal(read.status, 200);
    assert.equal(read.data.contract_version, "settlement_export_v1");
    assert.deepEqual(read.data.metadata, metadata);
    assert.equal(read.data.rows.length, 1);
    assert.equal(Object.hasOwn(read.data.rows[0], "refund_references"), false);
    assert.equal(Object.hasOwn(read.data.rows[0], "refund_attribution"), false);

    const jsonDownload = await fetch(`${started.baseUrl}/api/v1/settlement-exports/${exportId}/download?format=json`, {
      headers: authHeaders(token),
    });
    assert.equal(jsonDownload.status, 200);
    assert.equal(jsonDownload.headers.get("x-settlement-export-contract-version"), "settlement_export_v1");
    const jsonBody = await jsonDownload.json();
    assert.equal(jsonBody.export_version, "v1");
    assert.equal(Object.hasOwn(jsonBody, "contract_version"), false);
    assert.deepEqual(jsonBody.metadata, metadata);
    assert.equal(jsonBody.content_hash, metadata.content_hashes.json);
    assert.deepEqual(jsonBody.content_hashes, metadata.content_hashes);
    assert.equal(Object.hasOwn(jsonBody.rows[0], "refund_references"), false);

    const csvDownload = await fetch(`${started.baseUrl}/api/v1/settlement-exports/${exportId}/download?format=csv`, {
      headers: authHeaders(token),
    });
    assert.equal(csvDownload.status, 200);
    assert.equal(csvDownload.headers.get("x-settlement-export-contract-version"), "settlement_export_v1");
    const csvBytes = Buffer.from(await csvDownload.arrayBuffer());
    assert.deepEqual(csvBytes, legacyCsvBytes(row));
    assert.doesNotMatch(csvBytes.toString("utf8"), /refund_references_json|refund_attribution/);
  });

  await t.test("v2 counts an invoice refund once across multiple payment sessions and hashes tied rows deterministically", async () => {
    const invoice = await createInvoice(started.baseUrl, token, 1000, `v2-refund-invoice-${Date.now()}`);
    assert.equal(invoice.status, 201);
    const overpay = await ingestManualPayment(
      started.baseUrl,
      token,
      {
        invoice_id: invoice.data.invoice_id,
        amount_jpyc: 1300,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 2,
        tx_hash: randomTxHash("v2-refund-overpay"),
        from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      `v2-refund-payment-${Date.now()}`
    );
    assert.equal(overpay.status, 200);
    assert.equal(overpay.data.status, "review_required");
    const review = db.prepare(`SELECT id FROM review_cases WHERE invoice_id = ?`).get(invoice.data.invoice_id);
    assert.ok(review?.id);
    const refund = await createRefund(started.baseUrl, token, review.id, 300, `v2-refund-${Date.now()}`);
    assert.equal(refund.status, 201);
    const refundTxHash = randomTxHash("v2-refund-success");
    db.prepare(
      `UPDATE refund_requests
       SET status = 'succeeded', refund_tx_hash = ?, verified_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(refundTxHash, new Date().toISOString(), new Date().toISOString(), refund.data.refund_request_id);
    const providerPaymentSessionId = `provider-session-${Date.now()}`;
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO payment_sessions
       (id, invoice_id, rail_type, provider_code, status, fulfillment_decision, created_at, updated_at)
       VALUES (?, ?, 'provider_external', 'mock_provider', 'created', 'none', ?, ?)`
    ).run(providerPaymentSessionId, invoice.data.invoice_id, ts, ts);

    const created = await apiRequest(started.baseUrl, "/api/v1/settlement-exports", {
      method: "POST",
      headers: jsonHeaders(token, `v2-export-${Date.now()}`),
      body: JSON.stringify({ business_date: currentBusinessDateJst(), format: "json" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.contract_version, "settlement_export_v2");
    assert.equal(created.data.refund_manifest.filter((entry) => entry.invoice_id === invoice.data.invoice_id).length, 1);
    const manifest = created.data.refund_manifest.find((entry) => entry.invoice_id === invoice.data.invoice_id);
    assert.equal(manifest.refund_reference_count, 1);
    assert.equal(manifest.refund_succeeded_amount_jpyc_base, 300000000);
    assert.equal(created.data.refund_totals.refund_succeeded_amount_jpyc_base >= 300000000, true);

    const read = await apiRequest(started.baseUrl, `/api/v1/settlement-exports/${created.data.export_id}`, {
      headers: authHeaders(token),
    });
    assert.equal(read.status, 200);
    assert.equal(read.data.contract_version, "settlement_export_v2");
    const invoiceRows = read.data.rows.filter((row) => row.invoice_id === invoice.data.invoice_id);
    assert.equal(invoiceRows.length, 2);
    const primaryRows = invoiceRows.filter((row) => row.refund_attribution === "invoice_primary");
    assert.equal(primaryRows.length, 1);
    assert.equal(primaryRows[0].rail_type, "wallet_direct");
    assert.equal(primaryRows[0].refund_amount_jpyc_base, 300000000);
    assert.equal(primaryRows[0].refund_reference_count, 1);
    const siblingRows = invoiceRows.filter((row) => row.refund_attribution === "invoice_manifest_only");
    assert.equal(siblingRows.length, 1);
    assert.equal(siblingRows[0].refund_amount_jpyc_base, 0);
    assert.equal(siblingRows[0].refund_reference_count, 0);
    assert.deepEqual(siblingRows[0].refund_references, []);
    assert.equal(
      invoiceRows.reduce((sum, row) => sum + Number(row.refund_amount_jpyc_base || 0), 0),
      300000000
    );
    assert.equal(manifest.primary_export_row_id, primaryRows[0].id);
    const timestampCount = db
      .prepare(`SELECT COUNT(DISTINCT created_at) AS count FROM settlement_export_rows WHERE export_run_id = ? AND invoice_id = ?`)
      .get(created.data.export_run_id, invoice.data.invoice_id);
    assert.equal(timestampCount.count, 1);

    const firstDownload = await fetch(
      `${started.baseUrl}/api/v1/settlement-exports/${created.data.export_id}/download?format=json`,
      { headers: authHeaders(token) }
    );
    const firstBytes = Buffer.from(await firstDownload.arrayBuffer());
    const secondDownload = await fetch(
      `${started.baseUrl}/api/v1/settlement-exports/${created.data.export_id}/download?format=json`,
      { headers: authHeaders(token) }
    );
    const secondBytes = Buffer.from(await secondDownload.arrayBuffer());
    assert.equal(firstDownload.status, 200);
    assert.equal(secondDownload.status, 200);
    assert.deepEqual(firstBytes, secondBytes);
    const actualHash = createHash("sha256").update(firstBytes).digest("hex");
    assert.equal(firstDownload.headers.get("x-content-sha256"), actualHash);
    assert.equal(created.data.content_hashes.json, actualHash);
  });

  await t.test("corrupt refund amount blocks refund limits and export creation without partial artifacts", async () => {
    const target = db.prepare(`SELECT id, invoice_id, review_case_id, refund_amount_jpyc_base FROM refund_requests ORDER BY created_at DESC LIMIT 1`).get();
    assert.ok(target?.id);
    db.prepare(`UPDATE refund_requests SET refund_amount_jpyc_base = 'not-a-number' WHERE id = ?`).run(target.id);
    const blockedRefund = await createRefund(
      started.baseUrl,
      token,
      target.review_case_id,
      1,
      `corrupt-refund-limit-${Date.now()}`
    );
    assert.equal(blockedRefund.status, 409);
    assert.equal(blockedRefund.data.error.code, "REFUND_LEDGER_INTEGRITY_ERROR");

    const beforeCounts = {
      runs: db.prepare(`SELECT COUNT(*) AS count FROM settlement_export_runs`).get().count,
      exports: db.prepare(`SELECT COUNT(*) AS count FROM settlement_exports`).get().count,
    };
    const blockedExport = await apiRequest(started.baseUrl, "/api/v1/settlement-exports", {
      method: "POST",
      headers: jsonHeaders(token, `corrupt-refund-export-${Date.now()}`),
      body: JSON.stringify({ business_date: currentBusinessDateJst(), format: "json" }),
    });
    assert.equal(blockedExport.status, 409);
    assert.equal(blockedExport.data.error.code, "REFUND_LEDGER_INTEGRITY_ERROR");
    assert.deepEqual(
      {
        runs: db.prepare(`SELECT COUNT(*) AS count FROM settlement_export_runs`).get().count,
        exports: db.prepare(`SELECT COUNT(*) AS count FROM settlement_exports`).get().count,
      },
      beforeCounts
    );
    db.prepare(`UPDATE refund_requests SET refund_amount_jpyc_base = ? WHERE id = ?`).run(target.refund_amount_jpyc_base, target.id);
  });

  await t.test("repeat close reports a missing legacy binding and never guesses a later export", async () => {
    const businessDate = "1999-01-01";
    const firstClose = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
      method: "POST",
      headers: jsonHeaders(token, `legacy-close-create-${Date.now()}`),
      body: JSON.stringify({ business_date: businessDate, admin_approval: true }),
    });
    assert.equal(firstClose.status, 200);
    assert.equal(firstClose.data.contract_version, "settlement_export_v2");
    db.prepare(`UPDATE settlement_exports SET settlement_id = NULL WHERE id = ?`).run(firstClose.data.export_id);
    const laterExport = await apiRequest(started.baseUrl, "/api/v1/settlement-exports", {
      method: "POST",
      headers: jsonHeaders(token, `legacy-close-later-export-${Date.now()}`),
      body: JSON.stringify({ business_date: businessDate, format: "json" }),
    });
    assert.equal(laterExport.status, 201);
    const repeated = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
      method: "POST",
      headers: jsonHeaders(token, `legacy-close-repeat-${Date.now()}`),
      body: JSON.stringify({ business_date: businessDate, admin_approval: true }),
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.already_closed, true);
    assert.equal(repeated.data.export_binding_status, "legacy_export_missing");
    assert.equal(repeated.data.export_id, null);
    assert.equal(repeated.data.export_run_id, null);
    assert.equal(repeated.data.contract_version, null);
    assert.equal(repeated.data.accounting_summary, null);
    assert.notEqual(repeated.data.export_id, laterExport.data.export_id);
  });
});
