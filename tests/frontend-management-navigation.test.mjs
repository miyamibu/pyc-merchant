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
function element() {
  const attrs = new Map();
  const classes = new Set();
  return {
    dataset: {},
    textContent: "",
    classList: { toggle: (key, value) => value ? classes.add(key) : classes.delete(key), contains: (key) => classes.has(key) },
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: (key) => attrs.delete(key),
    getAttribute: (key) => attrs.get(key),
  };
}

test("business dates initialize after authenticated management controls are mounted", () => {
  const context = vm.createContext({ el: {}, state: { storeTimezone: "Asia/Tokyo" }, nowIsoDate: () => "2026-10-08" });
  vm.runInContext(block("function initializeBusinessDateInputs", "let screenWakeLock"), context);
  assert.doesNotThrow(() => context.initializeBusinessDateInputs());
  const date = { value: "" };
  const month = { value: "" };
  const timezone = { textContent: "" };
  Object.assign(context.el, { businessDateInput: date, businessMonthInput: month, businessTimezoneText: timezone });
  context.initializeBusinessDateInputs();
  assert.equal(date.value, "2026-10-08");
  assert.equal(month.value, "2026-10");
  assert.equal(timezone.textContent, "Asia/Tokyo");
  assert.match(block("async function handleLogin", "async function handleLogout"), /applyPermissionVisibility\(\);\s*initializeBusinessDateInputs\(\);/);
});

test("management anchors retain scoped permissions and move focus without replacing forms or submitting", () => {
  const ancestor = { tagName: "DETAILS", open: false, parentElement: null };
  let hidden = false;
  let focused = 0;
  let scrolled = 0;
  let allowed = true;
  const target = {
    ...element(), tagName: "SECTION", parentElement: ancestor,
    closest: () => hidden ? {} : null,
    focus: () => { focused += 1; },
    scrollIntoView: () => { scrolled += 1; },
  };
  const link = { ...element(), dataset: { permissionAny: "review.read review.update", managementTarget: "reviewOperations" } };
  const otherLink = element();
  const event = { target: { closest: () => link }, preventDefault() {} };
  const state = { token: "fixture-session", permissionsKnown: true, reviewDrafts: new Map([["fixture-review", "unsaved memo"]]) };
  const context = vm.createContext({
    state,
    el: { adminOperationsMount: { contains: () => true, querySelectorAll: () => [link, otherLink] } },
    document: { getElementById: () => target },
    hasAnyPermission: () => allowed,
  });
  vm.runInContext(block("function handleManagementNavigation", "function requireUiPermission"), context);
  context.handleManagementNavigation(event);
  assert.equal(ancestor.open, true);
  assert.equal(focused, 1);
  assert.equal(scrolled, 1);
  assert.equal(link.getAttribute("aria-current"), "location");
  assert.equal(state.reviewDrafts.get("fixture-review"), "unsaved memo");
  allowed = false;
  context.handleManagementNavigation(event);
  allowed = true;
  hidden = true;
  context.handleManagementNavigation(event);
  hidden = false;
  state.permissionsKnown = false;
  context.handleManagementNavigation(event);
  state.permissionsKnown = true;
  state.token = "";
  context.handleManagementNavigation(event);
  assert.equal(focused, 1, "unauthorized, unknown and hidden destinations remain inaccessible");
  assert.equal(scrolled, 1);
  assert.doesNotMatch(block("function handleManagementNavigation", "function requireUiPermission"), /requestJson|fetch\(|replaceChildren|innerHTML/);
});

test("refund stage changes open the current step without closing manually opened evidence or losing inputs", () => {
  const panels = [0, 1, 2].map((index) => ({ ...element(), tagName: "DETAILS", open: index === 0, dataset: { stepState: index === 0 ? "current" : "future" } }));
  const track = [0, 1, 2].map((index) => ({ ...element(), dataset: { refundStep: String(index) } }));
  const state = {
    refundRequestOperations: new Map(), refundRequestCompletedSignature: "",
    refundOperationsInFlight: new Set(), refundOperationTargetsInFlight: new Set(),
    currentRefund: null, refundPayerAddressVerified: true, refundPayerAddressReviewId: "review-fixture",
  };
  const el = {
    refundIdInput: { value: "" }, refundReviewCaseId: { value: "review-fixture" },
    refundStepRequestPanel: panels[0], refundStepApprovePanel: panels[1], refundStepEvidencePanel: panels[2],
    refundStepRequestBadge: element(), refundStepApproveBadge: element(), refundStepEvidenceBadge: element(),
    requestRefundBtn: element(), approveRefundBtn: element(), executeRefundBtn: element(), verifyRefundBtn: element(),
    refundTxHashInput: { value: "draft-transfer-reference" },
  };
  const context = vm.createContext({
    state, el,
    document: { getElementById: () => ({ querySelectorAll: () => track }) },
    buildRefundRequestSignature: () => "fixture-signature",
    hasPermission: () => true,
    refundStatusLabel: (status) => status,
  });
  vm.runInContext(block("function updateRefundStepState", "function stopSessionExpiryTimer"), context);
  context.updateRefundStepState();
  assert.equal(track[0].getAttribute("aria-current"), "step");
  panels[2].open = true;
  el.refundIdInput.value = "refund-fixture";
  state.currentRefund = { status: "requested" };
  context.updateRefundStepState();
  assert.equal(panels[1].open, true);
  assert.equal(panels[2].open, true, "manual opening is preserved");
  assert.equal(track[1].getAttribute("aria-current"), "step");
  state.currentRefund = { status: "approved" };
  context.updateRefundStepState();
  assert.equal(track[2].getAttribute("aria-current"), "step");
  panels[2].open = false;
  context.updateRefundStepState();
  assert.equal(panels[2].open, false, "same-stage refresh does not override an explicit close");
  assert.equal(el.refundTxHashInput.value, "draft-transfer-reference");
});

test("management markup keeps dangerous impact and exact accounting units next to submission", () => {
  const template = html.match(/<template id="adminOperationsTemplate">([\s\S]*?)<\/template>/)[1];
  const navigation = template.match(/<nav id="managementNavigation"[\s\S]*?<\/nav>/)[0];
  const destinations = [...navigation.matchAll(/data-management-target="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(destinations).size, destinations.length, "one navigation item per destination");
  for (const id of destinations) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(navigation, /data-permission-any="review\.read review\.update"/);
  assert.match(navigation, /data-permission-any="refund\.request refund\.view refund\.approve refund\.execute"/);
  assert.match(navigation, /data-permission-any="audit\.read audit\.export"/);
  assert.match(template, /調整額（JPYC base units）/);
  assert.match(template, /「売上にしない」は対象請求を無効にします[\s\S]*?id="updateReviewBtn"/);
  assert.match(template, /作成者とは別のスタッフが承認します[\s\S]*?id="approveAccountingAdjustmentBtn"/);
  assert.match(template, /ここでは送金しません[\s\S]*?id="executeRefundBtn"/);
  assert.match(template, /id="settlementPreviewConfirm"[\s\S]*?id="closeSettlementBtn"[^>]*disabled/);
  for (const id of ["settlementExportId", "settlementExportRunId", "settlementExportVersion", "settlementExportHash", "downloadSettlementCsvBtn", "downloadSettlementJsonBtn"]) assert.match(template, new RegExp(`id="${id}"`));
});

test("compact review references keep full identity in evidence and keyboard selection", () => {
  const selected = [];
  const makeNode = () => {
    const node = { ...element(), children: [], listeners: new Map() };
    node.appendChild = (child) => node.children.push(child);
    node.addEventListener = (type, callback) => node.listeners.set(type, callback);
    return node;
  };
  const context = vm.createContext({
    document: { createElement: makeNode },
    reviewReasonLabel: (reason) => reason,
    reviewStatusLabel: (status) => status,
    reviewPriorityMeta: () => ({ className: "s-yellow", label: "確認" }),
    selectReview: (id) => selected.push(id),
  });
  vm.runInContext(`${block("function shortId", "function reviewStatusSortRank")}\n${block("function createReviewRow", "async function handleLogin")}`, context);
  const id = "c83a6836-04a9-4a9b-a171-662a9f9fe0cb";
  const row = context.createReviewRow({ id, invoice_no: "INV-001", reason_type: "OVERPAYMENT", status: "open" });
  assert.equal(row.children[0].textContent, "c83a6836…e0cb");
  assert.equal(row.children[0].title, id);
  assert.equal(row.dataset.reviewId, id);
  assert.match(row.getAttribute("aria-label"), new RegExp(id));
  row.listeners.get("keydown")({ key: "Enter", preventDefault() {} });
  assert.deepEqual(selected, [id]);
});
