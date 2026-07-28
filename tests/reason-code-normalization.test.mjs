import test from "node:test";
import assert from "node:assert/strict";
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
import { normalizeReviewReasonCode } from "../src/reason-codes.mjs";

const CWD = process.cwd();

test("legacy review reason codes normalize to canonical values", () => {
  assert.equal(normalizeReviewReasonCode("shortage"), "UNDERPAYMENT");
  assert.equal(normalizeReviewReasonCode("overpay"), "OVERPAYMENT");
  assert.equal(normalizeReviewReasonCode("late_arrival"), "LATE_PAYMENT");
  assert.equal(normalizeReviewReasonCode("duplicate"), "DUPLICATE_PAYMENT");
  assert.equal(normalizeReviewReasonCode("wrong_chain"), "CHAIN_INCONSISTENT");
  assert.equal(normalizeReviewReasonCode("wrong_token"), "UNKNOWN_TRANSFER");
});

test("review API and settlement CSV expose canonical reason_code", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const invoice = await createInvoice(started.baseUrl, admin.token, 1200, `reason-code-${Date.now()}`);
  assert.equal(invoice.status, 201);

  const overpay = await ingestManualPayment(
    started.baseUrl,
    admin.token,
    {
      invoice_id: invoice.data.invoice_id,
      amount_jpyc: 1400,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 2,
      tx_hash: randomTxHash("reason-overpay"),
      from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    `reason-code-ingest-${Date.now()}`
  );
  assert.equal(overpay.status, 200);
  assert.equal(overpay.data.status, "review_required");

  const reviews = await apiRequest(started.baseUrl, "/api/v1/reviews", {
    headers: authHeaders(admin.token),
  });
  assert.equal(reviews.status, 200);
  assert.ok(Array.isArray(reviews.data.reviews));
  assert.ok(reviews.data.reviews.some((row) => row.reason_code === "OVERPAYMENT"));
  const review = reviews.data.reviews.find((row) => row.reason_code === "OVERPAYMENT");
  const resolved = await apiRequest(
    started.baseUrl,
    `/api/v1/reviews/${encodeURIComponent(review.id)}`,
    {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `reason-code-resolve-${Date.now()}`,
      }),
      body: JSON.stringify({
        status: "resolved",
        disposition: "cancelled_no_sale",
        resolution_note: "reason code export fixture resolved",
      }),
    },
  );
  assert.equal(resolved.status, 200);

  const businessDateJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const settlementCsv = await apiRequest(
    started.baseUrl,
    `/api/v1/settlements/daily:export?business_date=${encodeURIComponent(businessDateJst)}&format=csv`,
    { headers: authHeaders(admin.token) }
  );
  assert.equal(settlementCsv.status, 200);
  assert.equal(typeof settlementCsv.data, "string");
  assert.match(settlementCsv.data, /reason_code/);
  assert.match(settlementCsv.data, /OVERPAYMENT/);
});
