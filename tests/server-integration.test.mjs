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

const CWD = process.cwd();

test("server security integration flows", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);

  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const approver = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.SECOND_ADMIN_PIN,
    staffName: "Demo Approver",
  });

  function releaseRecipientLock() {
    const ts = new Date().toISOString();
    db.prepare(`UPDATE review_cases SET status = 'resolved', updated_at = ?, resolved_at = COALESCE(resolved_at, ?) WHERE status IN ('open', 'in_progress')`).run(
      ts,
      ts
    );
    db.prepare(`UPDATE invoices SET status = 'expired', status_reason = 'test_cleanup', updated_at = ? WHERE status IN ('issued', 'payment_detected', 'confirming')`).run(
      ts
    );
  }

  await t.test("SR-01 forbidden invoice fields are rejected", async () => {
    const res = await apiRequest(started.baseUrl, "/api/v1/invoices", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `inv-forbidden-${Date.now()}`,
      }),
      body: JSON.stringify({
        amount_jpy: 1000,
        chain_id: "1",
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "FIELD_NOT_ALLOWED");

    const created = await createInvoice(started.baseUrl, admin.token, 990, `inv-policy-${Date.now()}`);
    assert.equal(created.status, 201);
    const invoice = await getInvoice(started.baseUrl, admin.token, created.data.invoice_id);
    assert.equal(invoice.status, 200);
    assert.equal(String(invoice.data.chain.chain_id), env.CHAIN_ID);
    assert.equal(String(invoice.data.chain.token_contract).toLowerCase(), env.TOKEN_CONTRACT.toLowerCase());
    assert.equal(String(invoice.data.chain.recipient_address).toLowerCase(), env.RECIPIENT_ADDRESS.toLowerCase());

    await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/expire`, {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `expire-policy-${Date.now()}`,
      }),
      body: "{}",
    });
  });

  await t.test("SR-02 active recipient collision blocks, paid does not block, unresolved review blocks until resolved", async () => {
    const first = await createInvoice(started.baseUrl, admin.token, 1000, `inv-a-${Date.now()}`);
    assert.equal(first.status, 201);

    const secondBlocked = await createInvoice(started.baseUrl, admin.token, 1001, `inv-b-${Date.now()}`);
    assert.equal(secondBlocked.status, 409);
    assert.equal(secondBlocked.data.error.code, "TERMINAL_ACTIVE_INVOICE_EXISTS");

    const createTerminal = await apiRequest(started.baseUrl, "/api/v1/terminals", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `inv-second-terminal-${Date.now()}`,
      }),
      body: JSON.stringify({
        terminal_code: "TERM-002",
        status: "active",
      }),
    });
    assert.equal(createTerminal.status, 201);

    const secondTerminalAdmin = await loginAs(started.baseUrl, {
      terminalCode: "TERM-002",
      pin: env.STAFF_PIN,
      staffName: "Demo Staff",
    });

    const secondTerminalBlocked = await createInvoice(started.baseUrl, secondTerminalAdmin.token, 1002, `inv-b2-${Date.now()}`);
    assert.equal(secondTerminalBlocked.status, 409);
    assert.equal(secondTerminalBlocked.data.error.code, "ADDRESS_POOL_EXHAUSTED");

    const firstInvoiceId = first.data.invoice_id;
    const exact = await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: firstInvoiceId,
        amount_jpyc: 1000,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 2,
        tx_hash: randomTxHash("paid-first"),
        from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      `pay-a-${Date.now()}`
    );
    assert.equal(exact.status, 200);

    const third = await createInvoice(started.baseUrl, admin.token, 1100, `inv-c-${Date.now()}`);
    assert.equal(third.status, 201);

    const shortage = await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: third.data.invoice_id,
        amount_jpyc: 900,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 2,
        tx_hash: randomTxHash("shortage-review"),
        from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      `pay-short-${Date.now()}`
    );
    assert.equal(shortage.status, 200);
    assert.equal(shortage.data.status, "review_required");

    const blockedByReview = await createInvoice(started.baseUrl, admin.token, 1200, `inv-d-${Date.now()}`);
    assert.equal(blockedByReview.status, 409);
    assert.equal(blockedByReview.data.error.code, "ADDRESS_POOL_EXHAUSTED");

    const reviewedInvoice = await getInvoice(started.baseUrl, admin.token, third.data.invoice_id);
    assert.equal(reviewedInvoice.status, 200);
    assert.equal(reviewedInvoice.data.status, "review_required");
    assert.ok(reviewedInvoice.data.review_case_id);

    const reviewDetail = await apiRequest(
      started.baseUrl,
      `/api/v1/reviews/${encodeURIComponent(reviewedInvoice.data.review_case_id)}`,
      {
        headers: authHeaders(admin.token),
      }
    );
    assert.equal(reviewDetail.status, 200);
    assert.ok(Array.isArray(reviewDetail.data.events));
    assert.ok(reviewDetail.data.events.length >= 1);
    assert.equal(
      String(reviewDetail.data.events[0].from_address || "").toLowerCase(),
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert.equal(
      String(reviewDetail.data.events[0].to_address || "").toLowerCase(),
      String(env.RECIPIENT_ADDRESS || "").toLowerCase()
    );

    const resolveReview = await apiRequest(
      started.baseUrl,
      `/api/v1/reviews/${encodeURIComponent(reviewedInvoice.data.review_case_id)}`,
      {
        method: "PATCH",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
          "idempotency-key": `review-resolve-${Date.now()}`,
        }),
        body: JSON.stringify({
          status: "resolved",
          resolution_note: "integration test resolved",
        }),
      }
    );
    assert.equal(resolveReview.status, 200);

    const fourth = await createInvoice(started.baseUrl, admin.token, 1300, `inv-e-${Date.now()}`);
    assert.equal(fourth.status, 201);

    const expireFourth = await apiRequest(
      started.baseUrl,
      `/api/v1/invoices/${encodeURIComponent(fourth.data.invoice_id)}/expire`,
      {
        method: "POST",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
          "idempotency-key": `expire-${Date.now()}`,
        }),
        body: "{}",
      }
    );
    assert.equal(expireFourth.status, 200);
  });

  await t.test("SR-11 settlement reports unresolved reviews and does not settle review_required invoices", async () => {
    const paidInvoice = await createInvoice(started.baseUrl, admin.token, 1400, `inv-paid-${Date.now()}`);
    assert.equal(paidInvoice.status, 201);
    const paidIngest = await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: paidInvoice.data.invoice_id,
        amount_jpyc: 1400,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 2,
        tx_hash: randomTxHash("settlement-paid"),
        from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      `pay-settle-paid-${Date.now()}`
    );
    assert.equal(paidIngest.status, 200);

    const reviewInvoice = await createInvoice(started.baseUrl, admin.token, 1500, `inv-review-${Date.now()}`);
    assert.equal(reviewInvoice.status, 201);
    const overpay = await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: reviewInvoice.data.invoice_id,
        amount_jpyc: 1700,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 2,
        tx_hash: randomTxHash("settlement-review"),
        from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      `pay-settle-review-${Date.now()}`
    );
    assert.equal(overpay.status, 200);
    assert.equal(overpay.data.status, "review_required");

    // Keep this close test isolated from the later issuance tests. The production
    // gate intentionally blocks issuance for a store/date after close, so use a
    // deterministic historical business date for the two invoices under test.
    const businessDateJst = "1999-01-01";
    db.prepare(`UPDATE invoices SET business_date = ? WHERE id IN (?, ?)`).run(
      businessDateJst,
      paidInvoice.data.invoice_id,
      reviewInvoice.data.invoice_id
    );
    const closeRes = await apiRequest(started.baseUrl, "/api/v1/settlements/daily:close", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `settlement-${Date.now()}`,
      }),
      body: JSON.stringify({ business_date: businessDateJst, admin_approval: true }),
    });
    assert.equal(closeRes.status, 200);
    assert.equal(closeRes.data.warning, "UNRESOLVED_REVIEWS");
    assert.ok(Number(closeRes.data.review_count) >= 1);
    assert.ok(Array.isArray(closeRes.data.review_invoice_ids));
    assert.ok(closeRes.data.review_invoice_ids.includes(reviewInvoice.data.invoice_id));

    const paidRow = db.prepare(`SELECT settled_at FROM invoices WHERE id = ?`).get(paidInvoice.data.invoice_id);
    const reviewRow = db.prepare(`SELECT settled_at FROM invoices WHERE id = ?`).get(reviewInvoice.data.invoice_id);
    assert.ok(paidRow.settled_at);
    assert.equal(reviewRow.settled_at, null);

    const reviewInvoiceDetail = await getInvoice(started.baseUrl, admin.token, reviewInvoice.data.invoice_id);
    await apiRequest(started.baseUrl, `/api/v1/reviews/${encodeURIComponent(reviewInvoiceDetail.data.review_case_id)}`, {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `review-resolve-settlement-${Date.now()}`,
      }),
      body: JSON.stringify({
        status: "resolved",
        resolution_note: "settlement integration resolved",
      }),
    });
  });

  await t.test("SR-12 metrics auth required and healthz minimal", async () => {
    const m1 = await apiRequest(started.baseUrl, "/metrics");
    assert.equal(m1.status, 401);

    const r1 = await apiRequest(started.baseUrl, "/readyz");
    assert.equal(r1.status, 401);

    const m2 = await apiRequest(started.baseUrl, "/metrics", {
      headers: { authorization: `Bearer ${env.METRICS_SECRET}` },
    });
    assert.equal(m2.status, 200);

    const health = await apiRequest(started.baseUrl, "/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(health.data).sort(), ["now", "ok", "service"]);
  });

  await t.test("SR-13 CSV formula values are sanitized and export is audited", async () => {
    releaseRecipientLock();
    const invoice = await apiRequest(started.baseUrl, "/api/v1/invoices", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": "=EVIL()",
      }),
      body: JSON.stringify({ amount_jpy: 1600, payment_chain_id: "137" }),
    });
    assert.equal(invoice.status, 201);

    const csv = await apiRequest(started.baseUrl, "/api/v1/audit-logs/export?format=csv&limit=1000", {
      headers: authHeaders(admin.token),
    });
    assert.equal(csv.status, 200);
    assert.equal(typeof csv.data, "string");
    assert.match(csv.data, /"'=EVIL\(\)"/);

    const audit = await apiRequest(started.baseUrl, "/api/v1/audit-logs?limit=100", {
      headers: authHeaders(admin.token),
    });
    assert.equal(audit.status, 200);
    const actions = (audit.data.audit_logs || []).map((row) => row.action);
    assert.ok(actions.includes("audit.exported"));

    await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(invoice.data.invoice_id)}/expire`, {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `expire-csv-${Date.now()}`,
      }),
      body: "{}",
    });
  });

  await t.test("SR-15 kill switch blocks invoice creation and changes are audited", async () => {
    const disable = await apiRequest(started.baseUrl, "/api/v1/admin/stores/store-001/payments/disable", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `disable-${Date.now()}`,
      }),
      body: JSON.stringify({ reason: "incident-test" }),
    });
    assert.equal(disable.status, 200);
    assert.equal(disable.data.disabled, true);

    const blocked = await createInvoice(started.baseUrl, admin.token, 1700, `inv-blocked-${Date.now()}`);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.data.error.code, "PAYMENTS_DISABLED");

    const enable = await apiRequest(started.baseUrl, "/api/v1/admin/stores/store-001/payments/enable", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `enable-${Date.now()}`,
      }),
      body: JSON.stringify({ reason: "recover-test" }),
    });
    assert.equal(enable.status, 200);
    assert.equal(enable.data.disabled, false);

    const audit = await apiRequest(started.baseUrl, "/api/v1/audit-logs?limit=200", {
      headers: authHeaders(admin.token),
    });
    const actions = (audit.data.audit_logs || []).map((row) => row.action);
    assert.ok(actions.includes("payments.store_disabled"));
    assert.ok(actions.includes("payments.store_enabled"));
  });

  await t.test("SR-06 manual refund is recorded, external signer blocked without legal gate, duplicate tx hash blocked", async () => {
    releaseRecipientLock();
    const invoice = await createInvoice(started.baseUrl, admin.token, 2000, `inv-refund-${Date.now()}`);
    assert.equal(invoice.status, 201);

    const overpay = await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: invoice.data.invoice_id,
        amount_jpyc: 2300,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 2,
        tx_hash: randomTxHash("refund-overpay"),
        from_address: "0x4444444444444444444444444444444444444444",
      },
      `pay-refund-${Date.now()}`
    );
    assert.equal(overpay.status, 200);
    assert.equal(overpay.data.status, "review_required");

    const invoiceDetail = await getInvoice(started.baseUrl, admin.token, invoice.data.invoice_id);
    assert.ok(invoiceDetail.data.review_case_id);

    const invalidAddress = await apiRequest(started.baseUrl, "/api/v1/refunds", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-invalid-address-${Date.now()}`,
      }),
      body: JSON.stringify({
        review_case_id: invoiceDetail.data.review_case_id,
        refund_amount_jpyc: 200,
        refund_to_address: "0xinvalid",
        refund_chain_id: env.CHAIN_ID,
      }),
    });
    assert.equal(invalidAddress.status, 400);

    const wrongChain = await apiRequest(started.baseUrl, "/api/v1/refunds", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-wrong-chain-${Date.now()}`,
      }),
      body: JSON.stringify({
        review_case_id: invoiceDetail.data.review_case_id,
        refund_amount_jpyc: 200,
        refund_to_address: "0x4444444444444444444444444444444444444444",
        refund_chain_id: "1",
      }),
    });
    assert.equal(wrongChain.status, 400);

    const overRefund = await apiRequest(started.baseUrl, "/api/v1/refunds", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-over-${Date.now()}`,
      }),
      body: JSON.stringify({
        review_case_id: invoiceDetail.data.review_case_id,
        refund_amount_jpyc: 400,
        refund_to_address: "0x4444444444444444444444444444444444444444",
        refund_chain_id: env.CHAIN_ID,
      }),
    });
    assert.equal(overRefund.status, 400);
    assert.equal(overRefund.data.error.code, "OVER_REFUND");

    const request = await apiRequest(started.baseUrl, "/api/v1/refunds", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-request-${Date.now()}`,
      }),
      body: JSON.stringify({
        review_case_id: invoiceDetail.data.review_case_id,
        refund_amount_jpyc: 200,
        refund_to_address: "0x4444444444444444444444444444444444444444",
        refund_chain_id: env.CHAIN_ID,
      }),
    });
    assert.equal(request.status, 201);
    const refundId = request.data.refund_request_id;

    const approve = await apiRequest(started.baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/approve`, {
      method: "POST",
      headers: authHeaders(approver.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-approve-${Date.now()}`,
      }),
      body: "{}",
    });
    assert.equal(approve.status, 200);

    const extBlocked = await apiRequest(started.baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/execute`, {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-ext-${Date.now()}`,
      }),
      body: JSON.stringify({
        executor_type: "external_signer",
        execution_ref: "external-ref-1",
      }),
    });
    assert.equal(extBlocked.status, 503);
    assert.equal(extBlocked.data.error.code, "LEGAL_GATE_NOT_APPROVED");

    const manualTx = randomTxHash("refund-manual");
    const manualRecorded = await apiRequest(started.baseUrl, `/api/v1/refunds/${encodeURIComponent(refundId)}/execute`, {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `refund-manual-${Date.now()}`,
      }),
      body: JSON.stringify({
        executor_type: "manual",
        refund_tx_hash: manualTx,
      }),
    });
    assert.equal(manualRecorded.status, 200);
    assert.equal(manualRecorded.data.status, "recorded");

    const resolveFirstReview = await apiRequest(
      started.baseUrl,
      `/api/v1/reviews/${encodeURIComponent(invoiceDetail.data.review_case_id)}`,
      {
        method: "PATCH",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
          "idempotency-key": `refund-review-resolve-${Date.now()}`,
        }),
        body: JSON.stringify({
          status: "resolved",
          resolution_note: "unlock recipient for duplicate tx hash test",
        }),
      }
    );
    assert.equal(resolveFirstReview.status, 200);

    const invoice2 = await createInvoice(started.baseUrl, admin.token, 2100, `inv-refund-2-${Date.now()}`);
    assert.equal(invoice2.status, 201);
    const overpay2 = await ingestManualPayment(
      started.baseUrl,
      admin.token,
      {
        invoice_id: invoice2.data.invoice_id,
        amount_jpyc: 2400,
        chain_id: env.CHAIN_ID,
        token_contract: env.TOKEN_CONTRACT,
        to_address: env.RECIPIENT_ADDRESS,
        confirmations: 2,
        tx_hash: randomTxHash("refund-overpay-2"),
        from_address: "0x5555555555555555555555555555555555555555",
      },
      `pay-refund-2-${Date.now()}`
    );
    assert.equal(overpay2.status, 200);
    const invoice2Detail = await getInvoice(started.baseUrl, admin.token, invoice2.data.invoice_id);

    const request2 = await apiRequest(started.baseUrl, "/api/v1/refunds", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `refund2-request-${Date.now()}`,
      }),
      body: JSON.stringify({
        review_case_id: invoice2Detail.data.review_case_id,
        refund_amount_jpyc: 200,
        refund_to_address: "0x5555555555555555555555555555555555555555",
        refund_chain_id: env.CHAIN_ID,
      }),
    });
    assert.equal(request2.status, 201);

    const approve2 = await apiRequest(
      started.baseUrl,
      `/api/v1/refunds/${encodeURIComponent(request2.data.refund_request_id)}/approve`,
      {
        method: "POST",
        headers: authHeaders(approver.token, {
          "content-type": "application/json",
          "idempotency-key": `refund2-approve-${Date.now()}`,
        }),
        body: "{}",
      }
    );
    assert.equal(approve2.status, 200);

    const duplicateTx = await apiRequest(
      started.baseUrl,
      `/api/v1/refunds/${encodeURIComponent(request2.data.refund_request_id)}/execute`,
      {
        method: "POST",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
          "idempotency-key": `refund2-execute-${Date.now()}`,
        }),
        body: JSON.stringify({
          executor_type: "manual",
          refund_tx_hash: manualTx,
        }),
      }
    );
    assert.equal(duplicateTx.status, 409);
    assert.equal(duplicateTx.data.error.code, "DUPLICATE_REFUND_TX_HASH");
  });

  await t.test("signed /pay?ref redirects only to local payment page", async () => {
    releaseRecipientLock();
    const invoice = await createInvoice(started.baseUrl, admin.token, 2200, `inv-pay-ref-${Date.now()}`);
    assert.equal(invoice.status, 201);
    const paymentUrl = invoice.data.payment_url;
    assert.ok(typeof paymentUrl === "string" && paymentUrl.includes("/pay?ref="));

    const redirectRes = await fetch(paymentUrl, { redirect: "manual" });
    assert.equal(redirectRes.status, 302);
    const location = redirectRes.headers.get("location");
    assert.ok(location);
    assert.match(location, /^\/mobile\.html\?/);
    assert.ok(!location.includes("://evil.example"));
  });

  await t.test("SR-19 cancel and expire require invoice.create permission and reject accounting role with 403", async () => {
    releaseRecipientLock();
    const accountingPin = "9182";
    const createStaff = await apiRequest(started.baseUrl, "/api/v1/staff", {
      method: "POST",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `staff-accounting-${Date.now()}`,
      }),
      body: JSON.stringify({
        staff_name: "Accounting User",
        role: "accounting",
        pin: accountingPin,
        status: "active",
      }),
    });
    assert.equal(createStaff.status, 201, `staff create failed: ${JSON.stringify(createStaff.data)}`);

    const accountingSession = await loginAs(started.baseUrl, {
      terminalCode: env.TERMINAL_CODE,
      pin: accountingPin,
      staffName: "Accounting User",
    });
    assert.equal(accountingSession.role, "accounting");

    const invoice = await createInvoice(started.baseUrl, admin.token, 1500, `inv-perm-${Date.now()}`);
    assert.equal(invoice.status, 201);
    const invoiceId = invoice.data.invoice_id;

    const cancelByAccounting = await apiRequest(
      started.baseUrl,
      `/api/v1/invoices/${encodeURIComponent(invoiceId)}/cancel`,
      {
        method: "POST",
        headers: authHeaders(accountingSession.token, {
          "content-type": "application/json",
          "idempotency-key": `cancel-deny-${Date.now()}`,
        }),
        body: "{}",
      }
    );
    assert.equal(cancelByAccounting.status, 403, `cancel should be forbidden: ${JSON.stringify(cancelByAccounting.data)}`);
    assert.equal(cancelByAccounting.data.error.code, "FORBIDDEN");
    assert.match(String(cancelByAccounting.data.error.message || ""), /invoice\.create/);

    const expireByAccounting = await apiRequest(
      started.baseUrl,
      `/api/v1/invoices/${encodeURIComponent(invoiceId)}/expire`,
      {
        method: "POST",
        headers: authHeaders(accountingSession.token, {
          "content-type": "application/json",
          "idempotency-key": `expire-deny-${Date.now()}`,
        }),
        body: "{}",
      }
    );
    assert.equal(expireByAccounting.status, 403, `expire should be forbidden: ${JSON.stringify(expireByAccounting.data)}`);
    assert.equal(expireByAccounting.data.error.code, "FORBIDDEN");
    assert.match(String(expireByAccounting.data.error.message || ""), /invoice\.create/);

    const expireByAdmin = await apiRequest(
      started.baseUrl,
      `/api/v1/invoices/${encodeURIComponent(invoiceId)}/expire`,
      {
        method: "POST",
        headers: authHeaders(admin.token, {
          "content-type": "application/json",
          "idempotency-key": `expire-allow-${Date.now()}`,
        }),
        body: "{}",
      }
    );
    assert.equal(expireByAdmin.status, 200, `expire by admin should succeed: ${JSON.stringify(expireByAdmin.data)}`);
  });

  await t.test("public invoice API returns wallet launch payload and copy fallback", async () => {
    releaseRecipientLock();
    const invoice = await createInvoice(started.baseUrl, admin.token, 2300, `inv-public-wallet-${Date.now()}`);
    assert.equal(invoice.status, 201);
    assert.ok(typeof invoice.data.payment_uri === "string");
    assert.ok(typeof invoice.data.wallet_url === "string");
    assert.ok(invoice.data.copy_fallback);
    assert.equal(invoice.data.copy_fallback.copy_network, "Polygon");
    assert.equal(invoice.data.copy_fallback.copy_token, "JPYC");

    const signed = parsePaymentUrl(invoice.data.payment_url);
    const publicInvoice = await apiRequest(
      started.baseUrl,
      `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}?sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`
    );
    assert.equal(publicInvoice.status, 200);
    assert.equal(publicInvoice.data.chain_id, env.CHAIN_ID);
    assert.equal(publicInvoice.data.network, "Polygon");
    assert.equal(publicInvoice.data.token_symbol, "JPYC");
    assert.equal(Number(publicInvoice.data.token_decimals), Number(env.TOKEN_DECIMALS));
    assert.equal(String(publicInvoice.data.token_contract).toLowerCase(), env.TOKEN_CONTRACT.toLowerCase());
    assert.equal(String(publicInvoice.data.receive_address).toLowerCase(), env.RECIPIENT_ADDRESS.toLowerCase());
    assert.equal(publicInvoice.data.pay_url, invoice.data.payment_url);
    assert.equal(publicInvoice.data.wallet_url, publicInvoice.data.payment_uri);
    assert.match(publicInvoice.data.payment_uri, /ethereum:/);
    assert.match(publicInvoice.data.payment_uri, /@137\/transfer\?/);
    assert.match(publicInvoice.data.payment_uri, new RegExp(env.TOKEN_CONTRACT, "i"));
    assert.match(publicInvoice.data.payment_uri, new RegExp(env.RECIPIENT_ADDRESS, "i"));
    assert.match(publicInvoice.data.payment_uri, /uint256=2300000000000000000000/);
    assert.equal(publicInvoice.data.expected_amount_atomic, "2300000000000000000000");
    assert.equal(publicInvoice.data.copy_fallback.copy_receive_address.toLowerCase(), env.RECIPIENT_ADDRESS.toLowerCase());
    assert.equal(publicInvoice.data.copy_fallback.copy_amount, "2300000000000000000000");
  });
});
