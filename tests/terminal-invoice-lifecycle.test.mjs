import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/terminal.js", import.meta.url), "utf8");
function harness() {
  let now = Date.parse("2026-10-05T10:00:00Z"), nextTimer = 0, drawn = null;
  const timers = new Map(), windowEvents = new Map(), documentEvents = new Map(), requests = [], loads = [];
  class Clock extends Date { static now() { return now; } }
  const el = new Proxy({}, { get(target, key) {
    if (!target[key]) {
      const classes = new Set();
      target[key] = { checked: false, disabled: false, textContent: "", value: "", addEventListener() {}, removeAttribute() {}, replaceChildren() {}, focus() {},
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x),
          toggle: (x, on) => on ? classes.add(x) : classes.delete(x) } };
    }
    return target[key];
  } });
  const state = { deploymentTopology: "local_store_terminal", invoiceId: "", paymentChains: [], token: "", terminalId: "",
    consentRecordingInFlight: false, consentRecordingRequest: null, localPaymentQrExpiryTimer: null, invoiceRequestSequence: 0 };
  const context = { state, el, Date: Clock, PROVIDER_RAIL_ENABLED: false,
    ACTIVE_INVOICE_STATUSES: new Set(["issued"]), FINAL_INVOICE_STATUSES: new Set(["cancelled"]),
    document: { visibilityState: "visible", addEventListener: (name, callback) => documentEvents.set(name, callback) },
    window: { setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, deadline: now + ms }); return id; },
      addEventListener: (name, callback) => windowEvents.set(name, callback) },
    clearTimeout: id => timers.delete(id), canonicalInvoiceStatus: x => x, nowIsoDate: () => "2026-10-05",
    drawQr: value => { drawn = value; }, clearQrCanvas: () => { drawn = null; }, requireUiPermission: () => true,
    requestJson: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); },
    loadInvoice: async id => { loads.push(id); return { status: "pending" }; }, isIgnoredRequestError: () => false,
  };
  // The behavior under test runs from the real source. Other terminal services
  // are inert; no DOM renderer, browser, network or database is started.
  for (const match of source.matchAll(/^(?:async )?function (\w+)\(/gm)) context[match[1]] ??= () => {};
  vm.createContext(context);
  const names = ["stopLocalPaymentQrExpiryTimer", "hideLocalPaymentQr", "scheduleLocalPaymentQrExpiry", "clearQr",
    "renderCustomerFacingDisplay", "renderCustomerFacingQr", "invoiceConsentRequired", "renderInvoiceConsent",
    "syncConsentControls", "handleRecordInvoiceConsent", "renderInvoice", "clearInvoiceView", "resetSessionUi",
    "refreshFulfillmentObservationAfterResume", "bindEvents"];
  vm.runInContext(names.map(name => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, name);
    return match[0];
  }).join("\n"), context);
  context.bindEvents();
  const invoice = (id = "a", recorded = true, ttl = 1000) => ({ invoice_id: id, status: "issued",
    expires_at: new Clock(now + ttl).toISOString(), payment_uri: recorded ? `ethereum:${id}@137/transfer?uint256=1` : null,
    customer_policy_consent: { required: true, ready: true, recorded,
      versions: { terms_version: "1.0", privacy_version: "1.0", refund_policy_version: "1.0" } } });
  return { context, state, el, timers, requests, loads, invoice, drawn: () => drawn,
    advance(ms, fire = true) { now += ms; if (fire) {
      for (const [id, timer] of [...timers]) if (timer.deadline <= now && timers.has(id)) {
        timers.delete(id); timer.callback();
      }
    } },
    visibility(value) { context.document.visibilityState = value; documentEvents.get("visibilitychange")(); },
    event(name) { windowEvents.get(name)(); } };
}

test("local QR expires without a refresh, including a pending network refresh", () => {
  const h = harness(); h.context.renderInvoice(h.invoice()); h.state.token = "synthetic";
  h.context.loadInvoice = () => new Promise(() => {});
  h.event("online"); // Resume starts a request that never resolves.
  assert.ok(h.drawn()); assert.equal(h.timers.size, 1);
  h.advance(999); assert.ok(h.drawn());
  h.advance(1); assert.equal(h.drawn(), null); assert.equal(h.timers.size, 0);
});

test("rerender replaces the expiry timer; cancelled callbacks cannot clear a reissued invoice", () => {
  const h = harness(); h.context.renderInvoice(h.invoice());
  const oldCallback = [...h.timers.values()][0].callback;
  h.context.renderCustomerFacingQr(); assert.equal(h.timers.size, 1);
  h.context.renderInvoice(h.invoice("b", true, 5000));
  oldCallback(); assert.match(h.drawn(), /ethereum:b/); assert.equal(h.timers.size, 1);
  h.advance(1000); assert.match(h.drawn(), /ethereum:b/);
  h.advance(4000); assert.equal(h.drawn(), null);
});

test("inactive or invalid invoice never draws a transfer QR or schedules an expiry", () => {
  const h = harness();
  for (const patch of [{ expires_at: "bad" }, { expires_at: null }, { expires_at: "2000-01-01" },
    { status: "paid" }, { status: "cancelled" }, { payment_uri: null },
    { customer_policy_consent: { required: true, ready: true, recorded: false } }]) {
    h.context.renderInvoice({ ...h.invoice(), ...patch });
    assert.equal(h.drawn(), null); assert.equal(h.timers.size, 0);
  }
});

test("reset and logout cancel the payment QR deadline and clear consent intent", () => {
  for (const action of ["clearInvoiceView", "resetSessionUi"]) {
    const h = harness(); h.context.renderInvoice(h.invoice()); h.el.invoiceConsentCheckbox.checked = true;
    const oldCallback = [...h.timers.values()][0].callback;
    h.context[action](); oldCallback(); h.advance(0); // Logout may schedule a focus-only task.
    assert.equal(h.drawn(), null); assert.equal(h.timers.size, 0);
    assert.equal(h.el.invoiceConsentCheckbox.checked, false);
  }
});

test("page exit and background cancel QR; resume checks expiry before any response", () => {
  for (const exit of ["pagehide", "beforeunload", "hidden"]) {
    const h = harness(); h.context.renderInvoice(h.invoice());
    exit === "hidden" ? h.visibility("hidden") : h.event(exit);
    assert.equal(h.drawn(), null); assert.equal(h.timers.size, 0);
    h.advance(1000, false);
    exit === "hidden" ? h.visibility("visible") : h.event("pageshow");
    assert.equal(h.drawn(), null); assert.equal(h.timers.size, 0);
  }
  const h = harness(); h.context.renderInvoice(h.invoice()); h.event("pagehide"); h.event("pageshow");
  assert.ok(h.drawn()); assert.equal(h.timers.size, 1, "unexpired resume rearms the deadline");
});

test("long expiry cannot overflow the browser timeout; fixed entrance QR stays compatible", () => {
  const h = harness(); h.context.renderInvoice(h.invoice("a", true, 3_000_000_000));
  h.advance(2_147_483_647); assert.ok(h.drawn()); assert.equal(h.timers.size, 1);
  h.advance(3_000_000_000 - 2_147_483_647); assert.equal(h.drawn(), null);
  h.state.deploymentTopology = "public_cloud"; h.state.fixedQrUrl = "https://pay.merchant.jp/fixed";
  h.context.renderCustomerFacingQr(); assert.equal(h.drawn(), h.state.fixedQrUrl); assert.equal(h.timers.size, 0);
  h.event("pagehide"); assert.equal(h.drawn(), h.state.fixedQrUrl);
});

test("same-invoice polling keeps selection; reissue requires a fresh checkbox before consent POST", async () => {
  const h = harness(); h.context.renderInvoice(h.invoice("a", false));
  h.el.invoiceConsentCheckbox.checked = true; h.context.renderInvoice(h.invoice("a", false));
  assert.equal(h.el.invoiceConsentCheckbox.checked, true); assert.equal(h.el.recordConsentBtn.disabled, false);
  h.context.renderInvoice(h.invoice("b", false));
  assert.equal(h.el.invoiceConsentCheckbox.checked, false); assert.equal(h.el.recordConsentBtn.disabled, true);
  await h.context.handleRecordInvoiceConsent(); assert.equal(h.requests.length, 0);
  h.el.invoiceConsentCheckbox.checked = true; await h.context.handleRecordInvoiceConsent();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "/api/v1/invoices/b/policy-consent");
  assert.deepEqual(h.requests[0].body, { terms_version: "1.0", privacy_version: "1.0", refund_policy_version: "1.0" });
});

test("consent handler rechecks readiness, reissue, status, expiry and invoice identity", async () => {
  const h = harness();
  for (const patch of [{ status: "paid" }, { expires_at: "bad" }, { expires_at: "2000-01-01" },
    { customer_policy_consent: { ready: false, versions: {} } },
    { customer_policy_consent: { ready: true, requires_reissue: true, versions: {} } },
    { customer_policy_consent: { ready: true, recorded: true, versions: {} } }]) {
    h.context.renderInvoice({ ...h.invoice("a", false), ...patch }); h.el.invoiceConsentCheckbox.checked = true;
    await h.context.handleRecordInvoiceConsent(); assert.equal(h.requests.length, 0);
  }
  h.context.renderInvoice(h.invoice("a", false)); h.el.invoiceConsentCheckbox.checked = true; h.state.invoiceId = "b";
  await h.context.handleRecordInvoiceConsent(); assert.equal(h.requests.length, 0);
});

test("delayed consent success or failure never reloads a superseded invoice", async () => {
  for (const reject of [false, true]) {
    const h = harness(); let finish;
    h.context.requestJson = () => new Promise((resolve, fail) => { finish = reject ? () => fail(new Error("synthetic")) : resolve; });
    h.context.renderInvoice(h.invoice("a", false)); h.el.invoiceConsentCheckbox.checked = true;
    const pending = h.context.handleRecordInvoiceConsent();
    h.context.renderInvoice(h.invoice("b", false)); finish(); await pending;
    assert.equal(h.state.invoiceId, "b"); assert.deepEqual(h.loads, []);
    assert.equal(h.el.invoiceConsentCheckbox.checked, false); assert.equal(h.state.consentRecordingInFlight, false);
  }
});

test("clearing invoice invalidates a pending consent operation without unlocking a newer one", async () => {
  const h = harness(); const finish = [];
  h.context.requestJson = () => new Promise(resolve => finish.push(resolve));
  h.context.renderInvoice(h.invoice("a", false)); h.el.invoiceConsentCheckbox.checked = true;
  const a = h.context.handleRecordInvoiceConsent(); h.context.clearInvoiceView();
  h.context.renderInvoice(h.invoice("b", false)); h.el.invoiceConsentCheckbox.checked = true;
  const b = h.context.handleRecordInvoiceConsent(); finish[0](); await a;
  assert.equal(h.state.consentRecordingInFlight, true); assert.deepEqual(h.loads, []);
  finish[1](); await b; assert.equal(h.state.consentRecordingInFlight, false); assert.deepEqual(h.loads, ["b"]);
});
