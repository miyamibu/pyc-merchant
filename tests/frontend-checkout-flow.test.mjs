import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const js = fs.readFileSync(new URL("../public/terminal.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/terminal.html", import.meta.url), "utf8");
function block(start, end) {
  const from = js.indexOf(start);
  const to = js.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return js.slice(from, to);
}

function flowContext() {
  const state = {
    token: "test-session",
    currentInvoice: null,
    lastInvoiceRefreshAt: new Date().toISOString(),
    fulfillmentObservationValid: true,
    sseStatus: "open",
    fallbackPollingStatus: "idle",
  };
  const context = vm.createContext({
    state,
    el: {},
    FULFILLMENT_FRESHNESS_MS: 30_000,
    PROVIDER_RAIL_ENABLED: false,
    INVOICE_STATUS_ALIASES: { manual_review: "review_required" },
    getOperatorActionPolicy: () => ({ handoff: "保留", next: "待機", manager: "店長確認" }),
    paymentIssuanceAllowed: () => true,
    hasPermission: () => true,
  });
  vm.runInContext([
    block("function canonicalInvoiceStatus", "function getOperatorActionPolicy"),
    block("function wouldAllowFulfillment", "function renderFulfillmentDecisionBanner"),
    block("function resolveCheckoutFlow", "function stopFulfillmentFreshnessTimer"),
  ].join("\n"), context);
  return context;
}

function invoice(status, decision = "hold_fulfillment") {
  return { invoice_id: "fixture-invoice", status, fulfillment_decision: { decision, reason_codes: [] } };
}

test("read-only roles receive staff guidance rather than unauthorized create or reissue actions", () => {
  const ui = flowContext();
  ui.hasPermission = () => false;
  for (const current of [null, invoice("expired"), invoice("cancelled")]) {
    const flow = ui.resolveCheckoutFlow(current);
    assert.equal(flow.primary, "none");
    assert.match(flow.action, /担当スタッフ/);
    assert.notEqual(flow.step, 4);
  }
});

test("checkout separates payment confirmation from fresh authoritative handoff permission", () => {
  const ui = flowContext();
  assert.equal(ui.resolveCheckoutFlow(invoice("paid")).step, 3);
  assert.equal(ui.resolveCheckoutFlow(invoice("settled")).step, 3);
  const allowed = invoice("paid", "allow_fulfillment");
  assert.equal(ui.resolveCheckoutFlow(allowed).step, 4);
  assert.equal(ui.resolveCheckoutFlow(allowed).action, "商品をお渡しできます");
  assert.equal(ui.resolveCheckoutFlow({ ...allowed, integrity_hold: true }).step, 3);
  ui.state.fulfillmentObservationValid = false;
  assert.equal(ui.resolveCheckoutFlow(allowed).step, 3);
  assert.equal(ui.resolveCheckoutFlow(allowed).primary, "refresh");
  ui.state.fulfillmentObservationValid = true;
  ui.state.lastInvoiceRefreshAt = new Date(Date.now() - 31_000).toISOString();
  assert.equal(ui.resolveCheckoutFlow(allowed).step, 3);
  ui.state.lastInvoiceRefreshAt = new Date().toISOString();
  ui.state.sseStatus = "closed";
  assert.equal(ui.resolveCheckoutFlow(allowed).step, 3);
  ui.state.fallbackPollingStatus = "active";
  assert.equal(ui.resolveCheckoutFlow(allowed).step, 4);
});

test("readable handoff text distinguishes fresh payment holds from stale observations and keeps raw reasons", () => {
  const ui = flowContext();
  const paid = invoice("paid");
  paid.fulfillment_decision.reason_codes = ["CHAIN_MONITOR_HEALTH_UNKNOWN_OR_STALE"];
  const held = ui.resolveFulfillmentDecisionModel(paid);
  assert.match(ui.readableFulfillmentBody(paid, held), /お渡しは保留/);
  assert.match(held.body, /CHAIN_MONITOR_HEALTH_UNKNOWN_OR_STALE/);
  ui.state.fulfillmentObservationValid = false;
  assert.match(ui.readableFulfillmentBody(paid, held), /最新状態を確認できません/);
  assert.doesNotMatch(ui.readableFulfillmentBody(paid, held), /支払いは確認済み/);
  const render = block("function renderFulfillmentDecisionBanner", "function resolveCheckoutFlow");
  assert.match(render, /fulfillmentDecisionDetails/);
  assert.match(render, /model\.title[\s\S]*model\.body/);
  assert.doesNotMatch(render, /innerHTML/);
});

test("checkout shows one next action for preparation, QR, pending and exception states", () => {
  const ui = flowContext();
  assert.equal(ui.resolveCheckoutFlow(null).step, 1);
  assert.equal(ui.resolveCheckoutFlow(null).primary, "create");
  assert.equal(ui.resolveCheckoutFlow(invoice("issued")).step, 2);
  for (const status of ["payment_detected", "confirming"]) {
    const flow = ui.resolveCheckoutFlow(invoice(status));
    assert.equal(flow.step, 3);
    assert.equal(flow.primary, "none");
    assert.match(flow.hint, /二重送金も案内しない/);
  }
  assert.equal(ui.resolveCheckoutFlow(invoice("review_required")).action, "店長へ引き継ぐ");
  assert.equal(ui.resolveCheckoutFlow(invoice("expired")).primary, "reissue");
  assert.equal(ui.resolveCheckoutFlow(invoice("cancelled")).primary, "create");
  assert.equal(ui.resolveCheckoutFlow(invoice("unknown")).primary, "refresh");
  ui.PROVIDER_RAIL_ENABLED = true;
  assert.match(ui.resolveCheckoutFlow({ ...invoice("issued"), provider_summary: { qr_available: false } }).action, /店頭端末/);
  ui.state.token = "";
  assert.equal(ui.resolveCheckoutFlow(null).primary, "none");
});

function element() {
  const attributes = new Map();
  const classes = new Set();
  return {
    textContent: "",
    dataset: {},
    disabled: true,
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
    getAttribute: (key) => attributes.get(key),
    classList: { toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key), contains: (key) => classes.has(key) },
  };
}

test("flow render demotes stale handoff without replacing controls, changing permissions or moving focus", () => {
  const ui = flowContext();
  const steps = [1, 2, 3, 4].map((step) => ({ ...element(), dataset: { checkoutStep: String(step) } }));
  const controls = ["createInvoiceBtn", "refreshBtn", "reissueInvoiceBtn", "presentTapBtn"];
  ui.el = {
    checkoutFlow: { ...element(), querySelectorAll: () => steps },
    checkoutNextAction: element(),
    checkoutFlowHint: element(),
    ...Object.fromEntries(controls.map((id) => [id, element()])),
  };
  ui.state.currentInvoice = invoice("paid", "allow_fulfillment");
  ui.renderCheckoutFlow();
  assert.equal(steps[3].getAttribute("aria-current"), "step");
  ui.state.fulfillmentObservationValid = false;
  ui.renderCheckoutFlow();
  assert.equal(steps[2].getAttribute("aria-current"), "step");
  assert.equal(steps[3].getAttribute("aria-current"), undefined);
  assert.equal(steps[3].dataset.state, "upcoming");
  assert.equal(ui.el.refreshBtn.classList.contains("btn-primary"), true);
  for (const id of controls) assert.equal(ui.el[id].disabled, true);
  assert.doesNotMatch(block("function renderCheckoutFlow", "function stopFulfillmentFreshnessTimer"), /\.focus\(|innerHTML|replaceChildren/);
});

test("flow uses the existing freshness refresh path and keeps all referenced terminal elements", () => {
  assert.match(block("function renderOperatorGuide", "function computeReviewSuggestion"), /renderFulfillmentDecisionBanner\(invoice\);\s*renderCheckoutFlow\(invoice\)/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "DOM IDs must be unique including templates");
  for (const [, id] of js.matchAll(/document\.getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids.includes(id), `terminal element remains reachable: ${id}`);
  }
  assert.match(html, /<ol id="checkoutFlow"/);
  assert.match(html, /<details id="operatorGuideCard"/);
  assert.match(html, /id="refreshBtn"[^>]*data-permission="invoice\.read"/);
  assert.match(html, /id="createInvoiceBtn"[^>]*data-permission="invoice\.create"/);
});

test("Enter login is limited to login fields and repeated submissions use the button busy guard", () => {
  const keyboard = block('el.loginFormPanel?.addEventListener("keydown"', 'el.logoutBtn.addEventListener');
  const listeners = new Map();
  const el = {
    terminalCode: {}, staffName: {}, staffPin: {},
    loginFormPanel: { addEventListener: (type, callback) => listeners.set(type, callback) },
  };
  let submissions = 0;
  vm.runInNewContext(keyboard, { el, handleLogin: () => { submissions += 1; } });
  const press = listeners.get("keydown");
  press({ key: "Enter", target: el.staffPin, preventDefault() {} });
  press({ key: "Enter", target: {}, preventDefault() { throw new Error("unrelated field captured"); } });
  press({ key: "Enter", target: el.staffPin, isComposing: true, preventDefault() { throw new Error("IME captured"); } });
  assert.equal(submissions, 1);
  assert.match(block("async function handleLogin", "function renderPaymentChains"), /if \(el\.loginBtn\.disabled\) return/);
});
