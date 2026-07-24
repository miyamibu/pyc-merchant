import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  ingestManualPayment,
  loginAs,
  parsePaymentUrl,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";
import { buildServiceAuthHeaders } from "./helpers/service-auth.mjs";

const CWD = process.cwd();

async function importReceiveAddresses(baseUrl, token, count = 20, offset = 100) {
  const addresses = Array.from({ length: count }, (_value, index) =>
    `0x${String(offset + index).padStart(40, "0")}`
  );
  const res = await apiRequest(baseUrl, "/api/v1/admin/receive-addresses:import", {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `provider-pool-${Date.now()}-${offset}`,
    }),
    body: JSON.stringify({ source_label: "provider_test_pool", addresses }),
  });
  assert.equal(res.status, 201);
}

function businessDateJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function ingestProviderEvent(baseUrl, env, body, suffix = "evt") {
  const idem = `provider-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return apiRequest(baseUrl, "/api/v1/provider-rail/mock/events:ingest", {
    method: "POST",
    headers: buildServiceAuthHeaders(env, body, idem),
    body: JSON.stringify(body),
  });
}

async function ingestProviderSettlement(baseUrl, env, body, suffix = "settlement") {
  const idem = `provider-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return apiRequest(baseUrl, "/api/v1/provider-rail/mock/settlements:ingest", {
    method: "POST",
    headers: buildServiceAuthHeaders(env, body, idem),
    body: JSON.stringify(body),
  });
}

async function startProviderTestServer() {
  const env = baseServerEnv({
    ENABLE_PROVIDER_RAIL_MOCK: "true",
  });
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  await importReceiveAddresses(started.baseUrl, admin.token, 24, 200);
  return { env, started, db, admin };
}

async function readStreamUntil(reader, pattern, timeoutMs = 4000) {
  const startedAt = Date.now();
  let buffer = "";
  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = Math.max(timeoutMs - (Date.now() - startedAt), 1);
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`stream timeout waiting for ${pattern}`)), remainingMs)),
    ]);
    if (done) break;
    buffer += Buffer.from(value || []).toString("utf8");
    if (pattern.test(buffer)) {
      return buffer;
    }
  }
  throw new Error(`stream pattern not found: ${pattern}`);
}

test("provider presentation suppresses fixed QR until staff explicitly resumes QR", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1180, `provider-present-${Date.now()}`);
  assert.equal(created.status, 201);

  const presented = await apiRequest(
    ctx.started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/provider-sessions:present`,
    {
      method: "POST",
      headers: authHeaders(ctx.admin.token, {
        "content-type": "application/json",
        "idempotency-key": `provider-present-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(presented.status, 200);
  assert.equal(presented.data.provider_summary.payment_session_status, "presented");
  assert.equal(presented.data.provider_summary.qr_available, false);
  assert.equal(presented.data.provider_summary.operator_state.code, "waiting_customer");
  assert.equal(presented.data.customer_payment_mode.mode, "tap_only");

  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.provider_summary.payment_session_status, "presented");
  assert.equal(detail.data.provider_summary.qr_available, false);

  const publicEntry = await apiRequest(
    ctx.started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(ctx.admin.publicEntryToken)}`
  );
  assert.equal(publicEntry.status, 200);
  assert.equal(publicEntry.data.status, "tap_presented");

  const fixedEntry = await fetch(`${ctx.started.baseUrl}/t/${encodeURIComponent(ctx.admin.publicEntryToken)}`, {
    redirect: "manual",
  });
  assert.equal(fixedEntry.status, 302);
  assert.match(String(fixedEntry.headers.get("location") || ""), /\/terminal-entry\.html\?token=/);

  const signed = parsePaymentUrl(created.data.payment_url);
  const publicInvoice = await apiRequest(
    ctx.started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(created.data.invoice_id)}?sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`
  );
  assert.equal(publicInvoice.status, 200);
  assert.equal(publicInvoice.data.customer_payment_mode.mode, "tap_only");

  const resumed = await apiRequest(
    ctx.started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/provider-sessions:cancel`,
    {
      method: "POST",
      headers: authHeaders(ctx.admin.token, {
        "content-type": "application/json",
        "idempotency-key": `provider-resume-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.provider_summary.payment_session_status, "cancelled");
  assert.equal(resumed.data.provider_summary.qr_available, true);

  const fixedEntryAfterResume = await fetch(`${ctx.started.baseUrl}/t/${encodeURIComponent(ctx.admin.publicEntryToken)}`, {
    redirect: "manual",
  });
  assert.equal(fixedEntryAfterResume.status, 302);
  assert.match(String(fixedEntryAfterResume.headers.get("location") || ""), /\/terminal-entry\.html\?token=/);

  const publicEntryAfterResume = await apiRequest(
    ctx.started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(ctx.admin.publicEntryToken)}`
  );
  assert.equal(publicEntryAfterResume.status, 200);
  assert.equal(publicEntryAfterResume.data.status, "ready");
  assert.equal(publicEntryAfterResume.data.pay_url, created.data.payment_url);
});

test("provider authorized updates provider_summary and terminal SSE refreshes", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1190, `provider-sse-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  assert.equal(detail.status, 200);

  const presented = await apiRequest(
    ctx.started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/provider-sessions:present`,
    {
      method: "POST",
      headers: authHeaders(ctx.admin.token, {
        "content-type": "application/json",
        "idempotency-key": `provider-sse-present-${Date.now()}`,
      }),
      body: "{}",
    }
  );
  assert.equal(presented.status, 200);

  const sseTokenRes = await apiRequest(
    ctx.started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/sse-token`,
    {
      method: "POST",
      headers: authHeaders(ctx.admin.token, {
        "content-type": "application/json",
      }),
      body: "{}",
    }
  );
  assert.equal(sseTokenRes.status, 200);

  const streamResponse = await fetch(
    `${ctx.started.baseUrl}/api/v1/streams/terminals/${encodeURIComponent(ctx.admin.terminalId)}?invoice_id=${encodeURIComponent(created.data.invoice_id)}&sse_token=${encodeURIComponent(sseTokenRes.data.token)}`
  );
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body.getReader();
  const initial = await readStreamUntil(reader, /event: snapshot/);
  assert.match(initial, /invoice\.updated/);

  const ingest = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-sse-auth-${Date.now()}`,
    provider_payment_id: `pay-sse-auth-${Date.now()}`,
    provider_session_id: `sess-sse-auth-${Date.now()}`,
    invoice_id: created.data.invoice_id,
    event_type: "authorized",
    provider_status: "authorized",
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  }, "authorized-sse");
  assert.equal(ingest.status, 200);

  const streamChunk = await readStreamUntil(reader, /event: invoice\.updated/);
  assert.match(streamChunk, /invoice\.updated/);
  assert.match(streamChunk, /status_changed/);
  await reader.cancel();

  const after = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  assert.equal(after.status, 200);
  assert.equal(after.data.status, "payment_detected");
  assert.equal(after.data.provider_summary.payment_session_status, "accepted");
  assert.equal(after.data.provider_summary.provider_status, "authorized");
  assert.equal(after.data.provider_summary.operator_state.code, "fulfillment_ok");
  assert.equal(after.data.provider_summary.fulfillment_decision, "allow_fulfillment");
  assert.notEqual(after.data.status, "paid");
});

test("provider authorized does not become paid and blocks close until settlement", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1200, `provider-auth-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  assert.equal(detail.status, 200);

  const ingest = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-auth-${Date.now()}`,
    provider_payment_id: `pay-auth-${Date.now()}`,
    provider_session_id: `sess-auth-${Date.now()}`,
    invoice_id: created.data.invoice_id,
    event_type: "authorized",
    provider_status: "authorized",
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  }, "authorized");
  assert.equal(ingest.status, 200);

  const invoiceAfter = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  assert.equal(invoiceAfter.status, 200);
  assert.equal(invoiceAfter.data.status, "payment_detected");
  assert.notEqual(invoiceAfter.data.status, "paid");

  const closeRes = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `provider-close-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst() }),
  });
  assert.equal(closeRes.status, 409);
  assert.equal(closeRes.data.error.code, "ACTIVE_INVOICES_BLOCK_CLOSE");
});

test("provider captured without tx_hash does not pollute paid amount or bypass close", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1300, `provider-captured-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);

  const ingest = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-cap-${Date.now()}`,
    provider_payment_id: `pay-cap-${Date.now()}`,
    provider_session_id: `sess-cap-${Date.now()}`,
    invoice_id: created.data.invoice_id,
    event_type: "captured",
    provider_status: "captured",
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  }, "captured-no-tx");
  assert.equal(ingest.status, 200);

  const invoiceAfter = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  assert.equal(invoiceAfter.data.status, "payment_detected");
  assert.equal(String(invoiceAfter.data.amounts.paid_amount_jpyc_base), "0");

  const closeRes = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `provider-close-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst() }),
  });
  assert.equal(closeRes.status, 409);
  assert.equal(closeRes.data.error.code, "ACTIVE_INVOICES_BLOCK_CLOSE");
});

test("provider captured with tx_hash stays non-paid until existing payment ingest verifies it", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1400, `provider-cap-tx-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  const txHash = randomTxHash("provider-cap-tx");

  const ingest = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-cap-tx-${Date.now()}`,
    provider_payment_id: `pay-cap-tx-${Date.now()}`,
    provider_session_id: `sess-cap-tx-${Date.now()}`,
    invoice_id: created.data.invoice_id,
    event_type: "captured",
    provider_status: "captured",
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
    tx_hash: txHash,
  }, "captured-with-tx");
  assert.equal(ingest.status, 200);

  const invoiceAfterProvider = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  assert.equal(invoiceAfterProvider.data.status, "confirming");
  assert.notEqual(invoiceAfterProvider.data.status, "paid");
  assert.equal(String(invoiceAfterProvider.data.amounts.paid_amount_jpyc_base), "0");

  const paid = await ingestManualPayment(
    ctx.started.baseUrl,
    ctx.admin.token,
    {
      invoice_id: created.data.invoice_id,
      amount_jpyc: 1400,
      amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
      chain_id: ctx.env.CHAIN_ID,
      token_contract: ctx.env.TOKEN_CONTRACT,
      to_address: detail.data.chain.recipient_address,
      confirmations: 2,
      tx_hash: txHash,
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    `provider-manual-paid-${Date.now()}`
  );
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, "paid");
});

test("provider amount mismatch routes to review and settlement remains exception_pending", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1500, `provider-mismatch-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);

  const mismatch = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-mismatch-${Date.now()}`,
    provider_payment_id: `pay-mismatch-${Date.now()}`,
    provider_session_id: `sess-mismatch-${Date.now()}`,
    invoice_id: created.data.invoice_id,
    event_type: "authorized",
    provider_status: "authorized",
    amount_jpyc_base: String(BigInt(detail.data.amounts.amount_jpyc_base) - 100n),
    occurred_at: new Date().toISOString(),
  }, "mismatch");
  assert.equal(mismatch.status, 200);

  const invoiceAfter = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  assert.equal(invoiceAfter.data.status, "review_required");
  assert.equal(invoiceAfter.data.status_reason, "provider_amount_mismatch");

  const closeRes = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `provider-close-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst(), admin_approval: true }),
  });
  assert.equal(closeRes.status, 200);
  const row = ctx.db
    .prepare(`SELECT * FROM settlement_export_rows WHERE export_run_id = ? AND invoice_id = ?`)
    .get(closeRes.data.export_run_id, created.data.invoice_id);
  assert.equal(row.accounting_status, "exception_pending");
});

test("provider batch settlement does not auto-pay and daily close separates wallet cash from provider receivable", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const walletInvoice = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1600, `wallet-paid-${Date.now()}`);
  assert.equal(walletInvoice.status, 201);
  const walletDetail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, walletInvoice.data.invoice_id);
  const walletPaid = await ingestManualPayment(
    ctx.started.baseUrl,
    ctx.admin.token,
    {
      invoice_id: walletInvoice.data.invoice_id,
      amount_jpyc: 1600,
      chain_id: ctx.env.CHAIN_ID,
      token_contract: ctx.env.TOKEN_CONTRACT,
      to_address: walletDetail.data.chain.recipient_address,
      confirmations: 2,
      tx_hash: randomTxHash("wallet-direct-paid"),
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    `wallet-paid-ingest-${Date.now()}`
  );
  assert.equal(walletPaid.status, 200);

  const providerInvoice = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1700, `provider-batch-${Date.now()}`);
  assert.equal(providerInvoice.status, 201);
  const providerDetail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, providerInvoice.data.invoice_id);
  const providerPaymentId = `pay-batch-${Date.now()}`;
  const providerEvent = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-batch-${Date.now()}`,
    provider_payment_id: providerPaymentId,
    provider_session_id: `sess-batch-${Date.now()}`,
    invoice_id: providerInvoice.data.invoice_id,
    event_type: "authorized",
    provider_status: "authorized",
    amount_jpyc_base: providerDetail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  }, "batch-auth");
  assert.equal(providerEvent.status, 200);

  const blockedBeforeSettlement = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `provider-close-before-settlement-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst() }),
  });
  assert.equal(blockedBeforeSettlement.status, 409);
  assert.equal(blockedBeforeSettlement.data.error.code, "ACTIVE_INVOICES_BLOCK_CLOSE");

  const settlement = await ingestProviderSettlement(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_settlement_id: `settlement-${Date.now()}`,
    batch_reference: `batch-${Date.now()}`,
    settlement_status: "reported",
    settlement_amount_jpyc_base: providerDetail.data.amounts.amount_jpyc_base,
    allocations: [
      {
        provider_payment_id: providerPaymentId,
        invoice_id: providerInvoice.data.invoice_id,
        allocated_amount_jpyc_base: providerDetail.data.amounts.amount_jpyc_base,
        allocation_status: "matched",
      },
    ],
  }, "batch-settlement");
  assert.equal(settlement.status, 200);

  const providerAfter = await getInvoice(ctx.started.baseUrl, ctx.admin.token, providerInvoice.data.invoice_id);
  assert.notEqual(providerAfter.data.status, "paid");

  const closeRes = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `provider-close-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst() }),
  });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.data.accounting_summary.onchain_cash_confirmed.count, 1);
  assert.equal(closeRes.data.accounting_summary.provider_receivable.count, 0);
  assert.equal(closeRes.data.accounting_summary.provider_settlement_pending.count, 1);
  assert.equal(closeRes.data.totals.total_paid_jpyc_base, "1600000000");
});

test("provider reported batch without clean allocation exports as provider_settled_unallocated", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1750, `provider-unallocated-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  const providerPaymentId = `pay-unallocated-${Date.now()}`;

  const providerEvent = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-unallocated-${Date.now()}`,
    provider_payment_id: providerPaymentId,
    provider_session_id: `sess-unallocated-${Date.now()}`,
    invoice_id: created.data.invoice_id,
    event_type: "captured",
    provider_status: "captured",
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  }, "unallocated-captured");
  assert.equal(providerEvent.status, 200);

  const settlement = await ingestProviderSettlement(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_settlement_id: `settlement-unallocated-${Date.now()}`,
    batch_reference: `batch-unallocated-${Date.now()}`,
    settlement_status: "confirmed",
    settlement_amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    allocations: [
      {
        provider_payment_id: providerPaymentId,
        allocated_amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
        allocation_status: "reported",
      },
    ],
  }, "unallocated-settlement");
  assert.equal(settlement.status, 200);

  const closeRes = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `provider-close-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst() }),
  });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.data.accounting_summary.provider_settled_unallocated.count, 1);
  assert.equal(closeRes.data.accounting_summary.provider_settlement_pending.count, 0);

  const row = ctx.db
    .prepare(`SELECT * FROM settlement_export_rows WHERE export_run_id = ? AND invoice_id = ?`)
    .get(closeRes.data.export_run_id, created.data.invoice_id);
  assert.equal(row.accounting_status, "provider_settled_unallocated");
  assert.equal(row.cash_recognition_status, "batch_confirmed");
  assert.equal(Number(row.provider_receivable_amount_jpyc_base), Number(detail.data.amounts.amount_jpyc_base));
});

test("private provider fields are rejected, void is not refund, and duplicate provider_event_id is idempotent", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const privateInvoice = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1800, `provider-private-${Date.now()}`);
  assert.equal(privateInvoice.status, 201);
  const privateDetail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, privateInvoice.data.invoice_id);

  const rejected = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-private-${Date.now()}`,
    provider_payment_id: `pay-private-${Date.now()}`,
    invoice_id: privateInvoice.data.invoice_id,
    event_type: "authorized",
    provider_status: "authorized",
    amount_jpyc_base: privateDetail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
    payer_ref_hash: "forbidden",
  }, "private-rejected");
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.error.code, "PRIVATE_PROVIDER_FIELD_NOT_ALLOWED");

  const auditLogs = await apiRequest(ctx.started.baseUrl, "/api/v1/audit-logs?limit=200", {
    headers: authHeaders(ctx.admin.token),
  });
  assert.equal(auditLogs.status, 200);
  const actions = auditLogs.data.audit_logs.map((row) => row.action);
  assert.ok(actions.includes("private_provider_payload_rejected"));

  const voidInvoice = privateInvoice;
  const voidDetail = privateDetail;
  const duplicateEventId = `evt-dup-${Date.now()}`;
  const providerPaymentId = `pay-dup-${Date.now()}`;
  const duplicateBody = {
    provider_code: "mock_provider",
    provider_event_id: duplicateEventId,
    provider_payment_id: providerPaymentId,
    provider_session_id: `sess-dup-${Date.now()}`,
    invoice_id: voidInvoice.data.invoice_id,
    event_type: "authorized",
    provider_status: "authorized",
    amount_jpyc_base: voidDetail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  };
  const first = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, duplicateBody, "dup-a");
  assert.equal(first.status, 200);

  const second = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, duplicateBody, "dup-b");
  assert.equal(second.status, 200);
  assert.equal(second.data.duplicate, true);
  const eventCount = ctx.db
    .prepare(`SELECT COUNT(*) AS count FROM provider_payment_events WHERE provider_code = 'mock_provider' AND provider_event_id = ?`)
    .get(duplicateEventId);
  assert.equal(eventCount.count, 1);

  const voided = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-void-${Date.now()}`,
    provider_payment_id: providerPaymentId,
    provider_session_id: `sess-dup-${Date.now()}`,
    invoice_id: voidInvoice.data.invoice_id,
    event_type: "voided",
    provider_status: "voided",
    amount_jpyc_base: voidDetail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  }, "voided");
  assert.equal(voided.status, 200);

  const voidInvoiceAfter = await getInvoice(ctx.started.baseUrl, ctx.admin.token, voidInvoice.data.invoice_id);
  assert.notEqual(voidInvoiceAfter.data.status, "cancelled");

  const closeRes = await apiRequest(ctx.started.baseUrl, "/api/v1/settlements/daily:close", {
    method: "POST",
    headers: authHeaders(ctx.admin.token, {
      "content-type": "application/json",
      "idempotency-key": `provider-close-${Date.now()}`,
    }),
    body: JSON.stringify({ business_date: businessDateJst() }),
  });
  assert.equal(closeRes.status, 200);
  const row = ctx.db
    .prepare(`SELECT * FROM settlement_export_rows WHERE export_run_id = ? AND invoice_id = ?`)
    .get(closeRes.data.export_run_id, voidInvoice.data.invoice_id);
  assert.equal(row.accounting_status, "voided");
  assert.equal(Number(row.refund_amount_jpyc_base), 0);
  assert.ok(Number(row.void_amount_jpyc_base) > 0);
  assert.equal(row.export_excluded_private_data, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "payer_ref_hash"), false);
});

test("provider settlement allocation identity and payload conflicts fail closed", async (t) => {
  const ctx = await startProviderTestServer();
  t.after(async () => {
    ctx.db.close();
    await stopServerProcess(ctx.started.proc);
  });

  const created = await createInvoice(ctx.started.baseUrl, ctx.admin.token, 1250, `provider-settlement-id-${Date.now()}`);
  assert.equal(created.status, 201);
  const detail = await getInvoice(ctx.started.baseUrl, ctx.admin.token, created.data.invoice_id);
  const providerPaymentId = `pay-settlement-id-${Date.now()}`;
  const providerEvent = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-settlement-id-${Date.now()}`,
    provider_payment_id: providerPaymentId,
    provider_session_id: `sess-settlement-id-${Date.now()}`,
    invoice_id: created.data.invoice_id,
    event_type: "authorized",
    provider_status: "authorized",
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  }, "settlement-id-event");
  assert.equal(providerEvent.status, 200);

  const settlementId = `settlement-id-${Date.now()}`;
  const body = {
    provider_code: "mock_provider",
    provider_settlement_id: settlementId,
    settlement_status: "confirmed",
    settlement_amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    reported_at: "2026-07-24T00:00:00.000Z",
    allocations: [{
      provider_payment_id: providerPaymentId,
      invoice_id: created.data.invoice_id,
      allocated_amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
      allocation_status: "matched",
    }],
  };
  const first = await ingestProviderSettlement(ctx.started.baseUrl, ctx.env, body, "settlement-id-first");
  assert.equal(first.status, 200);
  assert.equal(first.data.disputed, false);
  const replay = await ingestProviderSettlement(ctx.started.baseUrl, ctx.env, body, "settlement-id-replay");
  assert.equal(replay.status, 200);
  assert.equal(replay.data.disputed, false);
  const allocationCount = ctx.db
    .prepare(`SELECT COUNT(*) AS count FROM provider_settlement_allocations WHERE provider_settlement_id = (SELECT id FROM provider_settlements WHERE provider_settlement_id = ?)`)
    .get(settlementId);
  assert.equal(allocationCount.count, 1);

  const conflict = await ingestProviderSettlement(ctx.started.baseUrl, ctx.env, {
    ...body,
    batch_reference: "conflicting-payload",
  }, "settlement-id-conflict");
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, "PROVIDER_SETTLEMENT_PAYLOAD_CONFLICT");
  const conflictedSettlement = ctx.db
    .prepare(`SELECT settlement_status FROM provider_settlements WHERE provider_settlement_id = ?`)
    .get(settlementId);
  assert.equal(conflictedSettlement.settlement_status, "disputed");

  const duplicateProviderPaymentId = `pay-settlement-dup-${Date.now()}`;
  const duplicateProviderEvent = await ingestProviderEvent(ctx.started.baseUrl, ctx.env, {
    provider_code: "mock_provider",
    provider_event_id: `evt-settlement-dup-${Date.now()}`,
    provider_payment_id: duplicateProviderPaymentId,
    provider_session_id: `sess-settlement-dup-${Date.now()}`,
    invoice_id: created.data.invoice_id,
    event_type: "authorized",
    provider_status: "authorized",
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    occurred_at: new Date().toISOString(),
  }, "settlement-dup-event");
  assert.equal(duplicateProviderEvent.status, 200);
  const duplicateSettlementId = `settlement-id-in-payload-${Date.now()}`;
  const duplicate = await ingestProviderSettlement(ctx.started.baseUrl, ctx.env, {
    ...body,
    provider_settlement_id: duplicateSettlementId,
    settlement_amount_jpyc_base: String(BigInt(detail.data.amounts.amount_jpyc_base) * 2n),
    allocations: [{
      provider_payment_id: duplicateProviderPaymentId,
      invoice_id: created.data.invoice_id,
      allocated_amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
      allocation_status: "matched",
    }, {
      provider_payment_id: duplicateProviderPaymentId,
      invoice_id: created.data.invoice_id,
      allocated_amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
      allocation_status: "matched",
    }],
  }, "settlement-id-duplicate-payload");
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.disputed, true);
  const duplicateAllocationCount = ctx.db
    .prepare(`SELECT COUNT(*) AS count FROM provider_settlement_allocations WHERE provider_settlement_id = (SELECT id FROM provider_settlements WHERE provider_settlement_id = ?)`)
    .get(duplicateSettlementId);
  assert.equal(duplicateAllocationCount.count, 1);
});
