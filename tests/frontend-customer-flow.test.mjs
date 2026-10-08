import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const mobile = fs.readFileSync(new URL("../public/mobile.js", import.meta.url), "utf8");
const mobileHtml = fs.readFileSync(new URL("../public/mobile.html", import.meta.url), "utf8");
const entryHtml = fs.readFileSync(new URL("../public/terminal-entry.html", import.meta.url), "utf8");

function between(start, end) {
  const first = mobile.indexOf(start);
  const last = mobile.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return mobile.slice(first, last);
}

function harness() {
  const context = vm.createContext({
    state: { refreshInProgress: false, consented: false, consentRecordStatus: "idle", launchInProgress: false },
    STATUS_COPY: Object.fromEntries(["issued", "open", "payment_detected", "confirming", "paid", "settled", "review_required", "expired", "cancelled"].map((status) => [status, {}])),
    PAYMENT_ACTION_STATUSES: new Set(["issued", "open"]),
    canonicalInvoiceStatus: (status) => status === "manual_review" ? "review_required" : status,
    hasIntegrityHold: (invoice) => Boolean(invoice?.integrity_hold),
    hasFreshInvoiceObservation: (invoice) => invoice?.fresh === true,
    validatePaymentDetails: (invoice) => ({ ok: invoice?.detailsValid !== false }),
    remainingSeconds: (expiresAt) => expiresAt === "expired" ? 0 : 60,
    policyLinksReady: () => context.policiesReady,
  });
  context.policiesReady = true;
  vm.runInContext(between("function evaluatePaymentActionGate", "function startPolling"), context);
  vm.runInContext(between("function getReceiptEvidence", "function renderReceiptCard"), context);
  const invoice = (status, overrides = {}) => ({ status, fresh: true, customer_payment_mode: { mode: "wallet_qr" }, expires_at: "future", ...overrides });
  const model = (data) => context.resolveCustomerFlow(data, context.evaluatePaymentActionGate(data));
  return { context, invoice, model };
}

test("customer flow uses the actual consent gate and never adds an interactive step", () => {
  const { context, invoice, model } = harness();
  assert.equal(model(invoice("issued")).step, 0);
  context.state.consented = true;
  assert.equal(model(invoice("issued")).step, 0, "local consent alone cannot advance before server recording");
  context.state.consentRecordStatus = "recorded";
  assert.equal(model(invoice("issued")).step, 1);
  context.policiesReady = false;
  assert.equal(model(invoice("issued")).step, 0);
  assert.equal(model(invoice("issued")).hold, true);
  assert.doesNotMatch(mobileHtml.match(/<ol class="customer-flow[\s\S]*?<\/ol>/)?.[0] || "", /<button|<a|tabindex/);
  assert.doesNotMatch(mobileHtml, /payment-guide-details"\s+open/);
  assert.match(entryHtml, /1回の操作で最新内容を照合/);
  assert.doesNotMatch(entryHtml, /最初の確認[\s\S]*次の確認/);
});

test("fresh signed server confirmation is required for the final customer flow step", () => {
  const { context, invoice, model } = harness();
  const evidence = { confirmed_at: "2026-10-08T00:00:00Z", receipt: { signature: "synthetic", kid: "synthetic", content_sha256: "synthetic", tx_hash: "synthetic" } };
  for (const status of ["paid", "settled"]) {
    assert.equal(model(invoice(status)).step, 2);
    assert.equal(model(invoice(status)).hold, true);
    assert.equal(model(invoice(status, evidence)).step, 3);
    assert.equal(model(invoice(status, { ...evidence, fresh: false })).step, 2);
    assert.equal(model(invoice(status, { ...evidence, fresh: false })).hold, true);
    assert.equal(model(invoice(status, { ...evidence, integrity_hold: true })).step, 2);
    context.state.refreshInProgress = true;
    assert.equal(model(invoice(status, evidence)).hold, true);
    assert.equal(model(invoice(status, evidence)).step, 2);
    context.state.refreshInProgress = false;
  }
});

test("detected, review, recovery and expired customer flows never imply completion", () => {
  const { invoice, model } = harness();
  for (const status of ["payment_detected", "confirming"]) {
    assert.equal(model(invoice(status)).step, 2);
    assert.match(model(invoice(status)).hint, /追加送金せず/);
  }
  for (const status of ["review_required", "manual_review"]) {
    assert.equal(model(invoice(status)).step, 2);
    assert.equal(model(invoice(status)).hold, true);
  }
  const recovery = model(invoice("paid", { payment_recovery: { status: "verified_wrong_token" } }));
  assert.equal(recovery.step, 2);
  assert.equal(recovery.hold, true);
  for (const status of ["expired", "cancelled", "unexpected"]) {
    assert.equal(model(invoice(status)).hold, true);
    assert.notEqual(model(invoice(status)).step, 3);
  }
  assert.equal(model(null).step, 0);
  assert.equal(model(null).hold, true);
});

test("provider payment modes retain store guidance instead of directing wallet transfer", () => {
  const { invoice, model } = harness();
  const flow = model(invoice("issued", { customer_payment_mode: { mode: "tap_processing", body: "店頭で確認中" } }));
  assert.equal(flow.step, 2);
  assert.equal(flow.paymentLabel, "店頭で支払い");
  assert.equal(flow.hint, "店頭で確認中");
  for (const mode of ["tap_review", "tap_retry"]) {
    const held = model(invoice("issued", { customer_payment_mode: { mode } }));
    assert.equal(held.hold, true);
    assert.equal(held.paymentLabel, "店頭で支払い");
  }
});

test("automatic flow updates retain the same DOM nodes with one current step", () => {
  const { context } = harness();
  const nodes = Array.from({ length: 4 }, () => ({ dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } }));
  const hint = { textContent: "" };
  context.el = { customerFlowSteps: nodes, customerFlowHint: hint, customerFlowPaymentLabel: { textContent: "" } };
  const invoice = { status: "confirming" };
  const gate = { code: "status_not_payable", blockingMessage: "", message: "確認中" };
  context.renderCustomerFlow(invoice, gate);
  const firstHint = hint.textContent;
  context.renderCustomerFlow(invoice, gate);
  assert.equal(context.el.customerFlowSteps, nodes);
  assert.equal(nodes.filter((node) => node.attributes["aria-current"] === "step").length, 1);
  assert.equal(nodes[2].attributes["aria-current"], "step");
  assert.equal(nodes[3].dataset.state, "upcoming");
  assert.equal(hint.textContent, firstHint);
});

test("payment actions follow the live gate and return after consent without exposing stopped transfers", () => {
  const { context, invoice } = harness();
  const control = () => {
    const node = { disabled: false, hidden: false };
    node.classList = { toggle(name, value) { if (name === "hidden") node.hidden = value; } };
    return node;
  };
  context.el = Object.fromEntries(["walletPayBtn", "showMethodsBtn", "copyInfoBtn", "copyAddressBtn", "copyAmountBtn", "copyInvoiceBtn", "copyTokenContractBtn", "secondaryPaymentActions", "goToConsentBtn"].map((name) => [name, control()]));
  context.el.paymentGateHint = { textContent: "" };
  context.setMethodPanel = () => {};
  context.setBlockingWarning = () => {};
  context.applyPaymentActionGate(invoice("issued"));
  assert.equal(context.el.walletPayBtn.hidden, true);
  assert.equal(context.el.goToConsentBtn.hidden, false);
  assert.equal(context.el.secondaryPaymentActions.hidden, true);
  context.state.consented = true;
  context.state.consentRecordStatus = "recorded";
  context.applyPaymentActionGate(invoice("issued"));
  assert.equal(context.el.walletPayBtn.hidden, false);
  assert.equal(context.el.walletPayBtn.disabled, false);
  assert.equal(context.el.goToConsentBtn.hidden, true);
  assert.equal(context.el.secondaryPaymentActions.hidden, false);
  for (const status of ["confirming", "paid", "expired", "review_required"]) {
    context.applyPaymentActionGate(invoice(status));
    assert.equal(context.el.walletPayBtn.hidden, true, status);
    assert.equal(context.el.walletPayBtn.disabled, true, status);
    assert.equal(context.el.secondaryPaymentActions.hidden, true, status);
  }
});

function gateControls(context) {
  const control = () => {
    const classes = new Set();
    return { disabled: false, textContent: "", classList: {
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    } };
  };
  context.el = Object.fromEntries(["walletPayBtn", "showMethodsBtn", "copyInfoBtn", "copyAddressBtn", "copyAmountBtn", "copyInvoiceBtn", "copyTokenContractBtn", "secondaryPaymentActions", "goToConsentBtn", "consentGateSection", "retryConsentBtn", "consentRecordError", "paymentVerifyCard", "technicalDetails"].map((name) => [name, control()]));
  context.el.paymentGateHint = { textContent: "" };
  context.el.consentCheckbox = { checked: true };
  context.setMethodPanel = () => {};
  context.setBlockingWarning = () => {};
  return context.el;
}

test("rechecking keeps visible payment controls in place while disabling every transfer and copy action", () => {
  const { context, invoice, model } = harness();
  const el = gateControls(context);
  context.state.consented = true;
  context.state.consentRecordStatus = "recorded";
  context.applyPaymentActionGate(invoice("issued"));
  assert.equal(el.walletPayBtn.classList.contains("hidden"), false);
  context.state.refreshInProgress = true;
  context.applyPaymentActionGate(invoice("issued"));
  assert.equal(el.walletPayBtn.classList.contains("hidden"), false);
  assert.equal(el.secondaryPaymentActions.classList.contains("hidden"), false);
  assert.equal(el.secondaryPaymentActions.classList.contains("payment-surface-blocked"), false);
  for (const name of ["walletPayBtn", "copyInfoBtn", "showMethodsBtn", "copyAddressBtn", "copyAmountBtn", "copyInvoiceBtn", "copyTokenContractBtn"]) assert.equal(el[name].disabled, true, name);
  assert.equal(model(invoice("issued")).step, 1);
  assert.equal(model(invoice("issued")).hold, true);
  context.state.refreshInProgress = false;
  context.applyPaymentActionGate(invoice("issued", { fresh: false }));
  assert.equal(el.walletPayBtn.disabled, true);
  assert.equal(el.walletPayBtn.classList.contains("hidden"), true);
});

test("failed consent remains reachable for retry but never enables payment before a recorded fresh state", () => {
  const { context, invoice } = harness();
  const el = gateControls(context);
  vm.runInContext(between("function renderConsentRecordState", "function renderConsentGate"), context);
  context.state.consented = true;
  context.state.consentRecordStatus = "failed";
  context.state.consentRecordError = "synthetic consent failure";
  context.renderConsentRecordState();
  context.applyPaymentActionGate(invoice("issued"));
  assert.equal(el.consentGateSection.classList.contains("payment-surface-blocked"), false);
  assert.equal(el.retryConsentBtn.classList.contains("hidden"), false);
  assert.equal(el.retryConsentBtn.disabled, false);
  assert.equal(el.walletPayBtn.disabled, true);
  assert.equal(el.copyInfoBtn.disabled, true);
  assert.equal(el.paymentVerifyCard.classList.contains("payment-surface-blocked"), true);
  context.policiesReady = false;
  context.applyPaymentActionGate(invoice("issued"));
  assert.equal(el.consentGateSection.classList.contains("payment-surface-blocked"), true, "unapproved policies still fail closed");
  context.policiesReady = true;
  context.state.consentRecordStatus = "recorded";
  context.renderConsentRecordState();
  context.applyPaymentActionGate(invoice("issued", { fresh: false }));
  assert.equal(el.walletPayBtn.disabled, true);
  context.applyPaymentActionGate(invoice("issued"));
  assert.equal(el.walletPayBtn.disabled, false);
  assert.equal(el.retryConsentBtn.classList.contains("hidden"), true);
});
