import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/terminal.js", import.meta.url), "utf8");

function between(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing source markers: ${start}, ${end}`);
  return source.slice(first, last);
}

test("fixed QR caches identical draws while retaining resize, DPR, URL and clear updates", () => {
  let size = 420;
  let generated = 0;
  let clears = 0;
  const fills = [];
  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: size, height: size }),
    getContext: () => ({
      setTransform() {},
      clearRect() { clears += 1; },
      fillRect(...args) { fills.push(args); },
      fillText() {},
    }),
  };
  const context = vm.createContext({
    el: { qrCanvas: canvas },
    window: { devicePixelRatio: 2 },
    qrcode: () => ({
      addData() {},
      make() { generated += 1; },
      getModuleCount: () => 21,
      isDark: () => true,
    }),
  });
  vm.runInContext(between("const qrRenderCache", "function providerBadgeClass"), context);
  context.drawQr("https://example.test/t/one");
  assert.equal(generated, 1);
  assert.equal(canvas.width, 840);
  assert.equal(fills.length, 442);
  assert.deepEqual(fills[1], [63, 63, 14, 14], "four-module quiet zone and integer tiles remain intact");
  context.drawQr("https://example.test/t/one");
  assert.equal(clears, 1, "unchanged draws do not reset the canvas");
  assert.equal(generated, 1);
  size = 300;
  context.drawQr("https://example.test/t/one");
  assert.equal(canvas.width, 600);
  assert.equal(clears, 2);
  assert.equal(generated, 1, "resizing reuses the QR matrix");
  context.window.devicePixelRatio = 4;
  context.drawQr("https://example.test/t/one");
  assert.equal(canvas.width, 900, "DPR remains capped at three");
  assert.equal(generated, 1);
  canvas.width = 1;
  context.drawQr("https://example.test/t/one");
  assert.equal(canvas.width, 900, "a reset canvas must be repainted");
  context.drawQr("https://example.test/t/two");
  assert.equal(generated, 2);
  context.clearQr();
  context.drawQr("https://example.test/t/two");
  assert.equal(generated, 3, "clearing invalidates the cached QR");
});

test("ops polling skips hidden tabs and refreshes resumed authenticated sessions only", () => {
  let polls = 0;
  let allowed = true;
  let callback;
  let stopped = false;
  const context = vm.createContext({
    state: { token: "test-session", autoRefreshTimer: null },
    document: { visibilityState: "visible" },
    OPS_AUTO_REFRESH_INTERVAL_MS: 60_000,
    hasAnyPermission: () => allowed,
    loadOpsSnapshot: () => { polls += 1; },
    setInterval: (fn) => { callback = fn; return 1; },
    clearInterval: () => { stopped = true; },
  });
  vm.runInContext(between("function startOpsAutoRefresh", "function setSseStatus"), context);
  context.startOpsAutoRefresh();
  callback();
  assert.equal(polls, 1);
  context.document.visibilityState = "hidden";
  callback();
  context.refreshOpsSnapshotAfterResume();
  assert.equal(polls, 1);
  context.document.visibilityState = "visible";
  context.refreshOpsSnapshotAfterResume();
  assert.equal(polls, 2);
  allowed = false;
  callback();
  context.refreshOpsSnapshotAfterResume();
  assert.equal(polls, 2, "permission gates remain in effect");
  allowed = true;
  context.state.token = "";
  context.refreshOpsSnapshotAfterResume();
  assert.equal(polls, 2, "resume does not fetch after logout");
  context.state.token = "test-session";
  context.stopOpsAutoRefresh();
  context.refreshOpsSnapshotAfterResume();
  assert.equal(polls, 2, "resume cannot restart a stopped ops lifecycle");
  assert.equal(stopped, true);
  assert.match(source, /addEventListener\("pageshow", refreshOpsSnapshotAfterResume\)/);
  assert.match(source, /visibilityState === "visible"[\s\S]{0,160}refreshOpsSnapshotAfterResume\(\)/);
});

function reviewContext({ stale = false } = {}) {
  const appended = [];
  const status = { value: "open" };
  const state = { reviewListSequence: 0, reviewDetailSequence: 0, selectedReviewId: "" };
  let pages = 0;
  const context = vm.createContext({
    state,
    el: { reviewStatusFilter: status, reviewsTableBody: { innerHTML: "", appendChild: (node) => appended.push(node) } },
    hasPermission: () => true,
    setReviewListState() {},
    requestJson: async () => {
      pages += 1;
      if (stale) state.reviewListSequence += 1;
      return { reviews: pages === 1
        ? Array.from({ length: 100 }, (_, i) => ({ id: `review-${i}`, priority: i, status: "open" }))
        : [{ id: "review-final", priority: 100, status: "open" }] };
    },
    compareReviewsByPriority: (a, b) => b.priority - a.priority,
    renderReviewSummary() {},
    renderReviewDetail() {},
    reviewReasonLabel: () => "reason",
    shortId: (id) => id,
    createReviewRow: (row) => ({ id: row.id }),
    document: { createDocumentFragment: () => ({ children: [], appendChild(node) { this.children.push(node); } }) },
    selectReview: async () => {},
    highlightSelectedReviewRow() {},
  });
  vm.runInContext(between("async function loadReviews", "async function stepUpForAccountingAdjustment"), context);
  return { context, appended, getPages: () => pages };
}

test("paginated reviews append once while retaining every row and priority order", async () => {
  const { context, appended, getPages } = reviewContext();
  const result = await context.loadReviews();
  assert.equal(result.status, "ok");
  assert.equal(getPages(), 2);
  assert.equal(result.rows.length, 101);
  assert.equal(appended.length, 1, "one live DOM append replaces per-row appends");
  assert.equal(appended[0].children.length, 101);
  assert.equal(appended[0].children[0].id, "review-final");
  assert.equal(appended[0].children[100].id, "review-0");
});

test("stale review responses do not append a fragment or change the selected review", async () => {
  const { context, appended } = reviewContext({ stale: true });
  context.state.selectedReviewId = "existing-review";
  const result = await context.loadReviews();
  assert.equal(result.status, "stale");
  assert.equal(appended.length, 0);
  assert.equal(context.state.selectedReviewId, "existing-review");
});
