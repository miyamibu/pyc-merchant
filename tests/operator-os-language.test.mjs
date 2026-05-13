import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  FORBIDDEN_STORE_CUSTOMER_TERMS,
  JAPANESE_FONT_STACK,
  getOperatorStatusPolicy,
  getReviewReasonActionPolicy,
  hasTofuGlyphs,
} from "../src/operator-language.mjs";

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, "artifacts", "operator-os", "2026-04-29");

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

function readArtifact(fileName) {
  return fs.readFileSync(path.join(ARTIFACT_DIR, fileName), "utf8");
}

function requireOperatorArtifacts(t) {
  if (!fs.existsSync(ARTIFACT_DIR)) {
    t.skip("operator-os generated artifacts are local evidence outputs and are not committed");
    return false;
  }
  return true;
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("operator language contract maps states to handoff decisions and safe next actions", () => {
  assert.equal(getOperatorStatusPolicy("issued").handoffDecision, "商品引渡し: まだ渡さない");
  assert.equal(getOperatorStatusPolicy("paid").handoffDecision, "商品引渡し: 渡してOK");
  assert.equal(getOperatorStatusPolicy("manual_review").statusLabel, "店長確認が必要");
  assert.match(getOperatorStatusPolicy("review_required").nextAction, /追加送金を促さず/);
  assert.match(getOperatorStatusPolicy("expired").customerScript, /送金せず/);
});

test("manual review reasons have actionable non-custodial safe exits", () => {
  assert.match(getReviewReasonActionPolicy("UNDERPAYMENT").suggestedAction, /不足額/);
  assert.match(getReviewReasonActionPolicy("OVERPAYMENT").safeExit, /アプリは返金送金を実行しません/);
  assert.match(getReviewReasonActionPolicy("DUPLICATE_PAYMENT").suggestedAction, /重複分の返金ケース/);
  assert.match(getReviewReasonActionPolicy("LATE_PAYMENT").suggestedAction, /新しい請求/);
  assert.match(getReviewReasonActionPolicy("ADDRESS_MISMATCH").safeExit, /返金可否/);
  assert.match(getReviewReasonActionPolicy("CHAIN_INCONSISTENT").suggestedAction, /自動確定せず/);
});

test("public pages and generated operator artifacts use robust Japanese font stack and no tofu glyphs", (t) => {
  const artifactFiles = [
    "artifacts/operator-os/2026-04-29/store-staff-quick-guide.html",
    "artifacts/operator-os/2026-04-29/admin-ops-manual.html",
    "artifacts/operator-os/2026-04-29/customer-help.html",
    "artifacts/operator-os/2026-04-29/internal-validation-report.html",
    "artifacts/operator-os/2026-04-29/training-video-index.html",
  ];
  const hasArtifacts = requireOperatorArtifacts(t);
  const files = [
    "public/app.css",
    ...(hasArtifacts ? artifactFiles : []),
  ];
  for (const file of files) {
    const text = read(file);
    assert.equal(hasTofuGlyphs(text), false, `${file} must not include tofu glyphs`);
  }
  const css = read("public/app.css");
  for (const font of ["Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", "Meiryo"]) {
    assert.match(css, new RegExp(font.replace(/\s/g, "\\s+")));
  }
  if (hasArtifacts) {
    const storeGuide = readArtifact("store-staff-quick-guide.html");
    assert.match(storeGuide, /font-family:[\s\S]*Noto Sans JP/);
  }
  assert.ok(JAPANESE_FONT_STACK.includes("Noto Sans CJK JP"));
});

test("store and customer artifacts are audience-split and avoid forbidden operational terms", (t) => {
  if (!requireOperatorArtifacts(t)) return;
  const storeText = visibleText(readArtifact("store-staff-quick-guide.html"));
  const customerText = visibleText(readArtifact("customer-help.html"));
  for (const term of FORBIDDEN_STORE_CUSTOMER_TERMS) {
    assert.doesNotMatch(storeText, new RegExp(term, "i"), `store guide leaked ${term}`);
    assert.doesNotMatch(customerText, new RegExp(term, "i"), `customer help leaked ${term}`);
  }
  assert.doesNotMatch(storeText, /固定QR/);
  assert.match(storeText, /絶対にしないこと/);
  assert.match(storeText, /支払い確認済みになる前に商品を渡さない/);
  assert.match(customerText, /二重送金しないでください/);
  assert.match(customerText, /秘密鍵・シードフレーズを聞くことはありません/);
});

test("staff terminal and customer page expose operation-first safety copy", () => {
  const terminalHtml = read("public/terminal.html");
  const terminalJs = read("public/terminal.js");
  const mobileHtml = read("public/mobile.html");
  const mobileJs = read("public/mobile.js");

  assert.match(terminalHtml, /商品を渡してよいか/);
  assert.match(terminalHtml, /端末入口QR URL/);
  assert.doesNotMatch(terminalHtml, /固定QR URL/);
  assert.doesNotMatch(visibleText(terminalHtml), /worker/i);
  assert.match(terminalJs, /商品引渡し: まだ渡さない/);
  assert.match(terminalJs, /商品引渡し: 渡してOK/);
  assert.match(terminalJs, /状態更新が停止しています。新しいJPYC決済を受け付けないでください/);
  assert.match(terminalJs, /受取アドレス残数が少なくなっています/);
  assert.match(mobileHtml, /この画面に表示された内容以外には送金しないでください/);
  assert.match(mobileHtml, /ウォレットが自動で開かない場合/);
  assert.match(mobileJs, /お支払い内容の確認が必要です。追加で送金せず/);
  assert.doesNotMatch(mobileJs, /送金額\(atomic\)/);
});

test("training index uses controllable MP4 videos and placeholder cards for missing scenario assets", (t) => {
  if (!requireOperatorArtifacts(t)) return;
  const index = readArtifact("training-video-index.html");
  const generator = read("scripts/generate-operator-os-artifacts.mjs");
  assert.match(generator, /<video controls muted playsinline/);
  assert.match(generator, /01_store_operator_normal\.mp4/);
  assert.match(generator, /02_customer_payment_normal\.mp4/);
  assert.match(generator, /04_confirmation-needed-patterns\.mp4/);
  assert.match(index, /(<video controls muted playsinline|BLOCKED_RECORDING_ASSET)/);
  assert.doesNotMatch(index, /review_required/);
  for (const match of index.matchAll(/<video[^>]+src="([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(ARTIFACT_DIR, match[1])), `missing referenced video ${match[1]}`);
  }
  assert.match(index, /video-visual-inspection-checklist\.md/);
  assert.match(index, /録画チェックリスト/);
  assert.match(index, /返金証跡登録/);
  assert.match(index, /日次締めブロックと成功/);
});

test("video visual inspection checklist exists and is not falsely completed", (t) => {
  if (!requireOperatorArtifacts(t)) return;
  const checklist = readArtifact("video-visual-inspection-checklist.md");
  assert.match(checklist, /Status: PENDING_HUMAN_REVIEW/);
  assert.match(checklist, /Japanese text readable/);
  assert.match(checklist, /Tofu\/□ visible/);
  assert.match(checklist, /Screenshot evidence path/);
});
