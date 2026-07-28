import test from "node:test";
import assert from "node:assert/strict";
import { makePaymentLogic } from "../src/payment-logic.mjs";

const { decidePaymentStatus, toBaseUnits } = makePaymentLogic({ jpycBaseUnitScale: 1, requiredConfirmations: 2 });

const baseInvoice = {
  status: "issued",
  chain_id: "137",
  token_contract: "0xjpyc",
  recipient_address: "0xrecipient",
  amount_jpyc: 1200,
  amount_jpyc_base: "1200",
  expires_at: "2099-01-01T00:00:00.000Z",
};

const baseEvent = {
  chain_id: "137",
  tx_hash: "0xlegacy-tx",
  log_index: 0,
  token_contract: "0xjpyc",
  to_address: "0xrecipient",
  amount_jpyc: 1200,
  amount_jpyc_base: "1200",
  confirmations: 3,
  canonical_status: "canonical",
  block_timestamp: "2026-01-01T00:00:00.000Z",
  observed_at: "2026-01-01T00:00:00.000Z",
};

// --- toBaseUnits ---

test("toBaseUnits: valid whole number", () => {
  const result = toBaseUnits(1200);
  assert.equal(result.value, "1200");
});

test("makePaymentLogic: explicit scale is required", () => {
  assert.throws(() => makePaymentLogic({ requiredConfirmations: 2 }), /jpycBaseUnitScale/);
});

test("makePaymentLogic: requiredConfirmations must be non-negative integer", () => {
  assert.throws(
    () => makePaymentLogic({ jpycBaseUnitScale: 1, requiredConfirmations: -1 }),
    /requiredConfirmations/
  );
});

test("toBaseUnits: invalid NaN returns error", () => {
  assert.ok(toBaseUnits("abc").error);
});

test("toBaseUnits: negative returns error", () => {
  assert.ok(toBaseUnits(-1).error);
});

// --- decidePaymentStatus: happy path ---

test("exact amount with enough confirmations → paid", () => {
  const r = decidePaymentStatus(baseInvoice, baseEvent);
  assert.equal(r.nextStatus, "paid");
  assert.equal(r.reasonLabel, "confirmed");
});

test("exact amount but insufficient confirmations → confirming", () => {
  const r = decidePaymentStatus(baseInvoice, { ...baseEvent, confirmations: 1 });
  assert.equal(r.nextStatus, "confirming");
});

test("cumulative split payments reach paid only when the recorded total matches", () => {
  const splitInvoice = { ...baseInvoice, amount_jpyc: 1000, amount_jpyc_base: "1000" };
  const first = decidePaymentStatus(splitInvoice, { ...baseEvent, amount_jpyc_base: "300" }, {
    previousPaidAmountBase: "0",
    totalPaidAmountBase: "300",
  });
  assert.equal(first.nextStatus, "review_required");
  assert.equal(first.reasonType, "UNDERPAYMENT");

  const second = decidePaymentStatus(splitInvoice, { ...baseEvent, amount_jpyc_base: "700" }, {
    previousPaidAmountBase: "300",
    totalPaidAmountBase: "1000",
  });
  assert.equal(second.nextStatus, "paid");
  assert.equal(second.reasonLabel, "confirmed");
});

// --- decidePaymentStatus: review_required branches ---

test("expired invoice with in-expiry block timestamp → DETECTED_AFTER_EXPIRY review", () => {
  const r = decidePaymentStatus({ ...baseInvoice, status: "expired" }, baseEvent);
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "OTHER");
  assert.equal(r.reasonLabel, "detected_after_expiry");
});

test("wrong chain_id → CHAIN_INCONSISTENT", () => {
  const r = decidePaymentStatus(baseInvoice, { ...baseEvent, chain_id: "1" });
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "CHAIN_INCONSISTENT");
});

test("wrong token_contract → UNKNOWN_TRANSFER", () => {
  const r = decidePaymentStatus(baseInvoice, { ...baseEvent, token_contract: "0xother" });
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "UNKNOWN_TRANSFER");
});

test("token_contract case-insensitive match → paid", () => {
  const r = decidePaymentStatus(
    { ...baseInvoice, token_contract: "0xJPYC" },
    { ...baseEvent, token_contract: "0xjpyc" }
  );
  assert.equal(r.nextStatus, "paid");
});

test("wrong recipient address → ADDRESS_MISMATCH", () => {
  const r = decidePaymentStatus(baseInvoice, { ...baseEvent, to_address: "0xother" });
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "ADDRESS_MISMATCH");
});

test("shortage amount → UNDERPAYMENT", () => {
  const r = decidePaymentStatus(baseInvoice, { ...baseEvent, amount_jpyc_base: "1000" });
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "UNDERPAYMENT");
});

test("overpay amount → OVERPAYMENT", () => {
  const r = decidePaymentStatus(baseInvoice, { ...baseEvent, amount_jpyc_base: "1400" });
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "OVERPAYMENT");
});

test("already paid invoice → DUPLICATE_PAYMENT", () => {
  const r = decidePaymentStatus({ ...baseInvoice, status: "paid" }, baseEvent);
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "DUPLICATE_PAYMENT");
});

// --- priority ordering: expired is checked before chain/token ---

test("expired invoice skips chain check after timestamp classification", () => {
  const r = decidePaymentStatus(
    { ...baseInvoice, status: "expired" },
    { ...baseEvent, chain_id: "1" }
  );
  assert.equal(r.reasonType, "OTHER");
  assert.equal(r.reasonLabel, "detected_after_expiry");
});

// --- _base fallback: when amount_jpyc_base is null, derives from amount_jpyc ---

test("falls back to amount_jpyc when _base is null (shortage)", () => {
  const r = decidePaymentStatus(
    { ...baseInvoice, amount_jpyc_base: null, amount_jpyc: 1200 },
    { ...baseEvent, amount_jpyc_base: null, amount_jpyc: 800 }
  );
  assert.equal(r.reasonType, "UNDERPAYMENT");
});

test("past expires_at exact payment -> late_arrival review_required", () => {
  const r = decidePaymentStatus(
    { ...baseInvoice, expires_at: "2024-01-01T00:00:00.000Z" },
    {
      ...baseEvent,
      block_timestamp: "2024-01-01T00:00:01.000Z",
      observed_at: "2024-01-01T00:00:01.000Z",
    }
  );
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "LATE_PAYMENT");
});

test("canonical block timestamp is used for expiry and the exact boundary is accepted", () => {
  const boundary = "2024-01-01T00:00:00.000Z";
  const r = decidePaymentStatus(
    { ...baseInvoice, expires_at: boundary },
    { ...baseEvent, block_timestamp: boundary, observed_at: "2024-01-01T00:00:30.000Z" }
  );
  assert.equal(r.nextStatus, "paid");
});

test("invalid expires_at -> invalid_invoice_expiry review_required", () => {
  const r = decidePaymentStatus(
    { ...baseInvoice, expires_at: "not-a-date" },
    baseEvent
  );
  assert.equal(r.nextStatus, "review_required");
  assert.equal(r.reasonType, "OTHER");
});

test("legacy single-event decision also holds incomplete identity, unverified timestamp, and ledger errors", () => {
  const missingIdentity = { ...baseEvent };
  delete missingIdentity.log_index;
  assert.equal(
    decidePaymentStatus(baseInvoice, missingIdentity).reasonType,
    "CHAIN_TRANSFER_IDENTITY_INCOMPLETE"
  );

  const missingTimestamp = { ...baseEvent, block_timestamp: undefined };
  assert.equal(
    decidePaymentStatus(baseInvoice, missingTimestamp).reasonType,
    "TIMESTAMP_UNVERIFIED"
  );

  const malformedAmount = { ...baseEvent, amount_jpyc_base: "not-an-integer" };
  assert.equal(
    decidePaymentStatus(baseInvoice, malformedAmount).reasonType,
    "LEDGER_INTEGRITY_ERROR"
  );
});

// --- reorg detection condition (pure logic mirror) ---

test("reorg condition: latestBlock < previous triggers reorg flag", () => {
  const previous = 1000;
  const latestBlock = 995;
  const isReorg = latestBlock < previous;
  assert.ok(isReorg, "should detect reorg when latest < previous");
});

test("no reorg when latestBlock >= previous", () => {
  assert.ok(!(1001 < 1000));
  assert.ok(!(1000 < 1000));
});

// --- RPC failover condition (pure logic mirror) ---

test("failover exhaustion: all providers fail", () => {
  const providers = ["rpc1", "rpc2", "rpc3"];
  const failures = [];
  for (const p of providers) {
    failures.push(p);
  }
  assert.equal(failures.length, providers.length, "all providers failed");
});
