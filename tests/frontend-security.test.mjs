import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

const inlineDirectivePattern = new RegExp(["unsafe", "inline"].join("-"), "i");

test("SR-09 no runtime CDN QR script, no inline scripts, and no inline style attributes in terminal/mobile HTML", () => {
  const terminalHtml = read("public/terminal.html");
  const mobileHtml = read("public/mobile.html");
  const terminalEntryHtml = read("public/terminal-entry.html");
  const indexHtml = read("index.html");
  const server = read("src/server.mjs");

  assert.doesNotMatch(terminalHtml, /cdn\.jsdelivr/i);
  assert.doesNotMatch(mobileHtml, /cdn\.jsdelivr/i);
  assert.doesNotMatch(terminalEntryHtml, /cdn\.jsdelivr/i);
  assert.doesNotMatch(indexHtml, /cdn\.jsdelivr/i);
  assert.match(terminalHtml, /<script\s+src="\/terminal\.js"/i);
  assert.match(mobileHtml, /<script\s+src="\/mobile\.js"/i);
  assert.match(terminalEntryHtml, /<script\s+src="\/terminal-entry\.js"/i);
  assert.match(indexHtml, /<script\s+src="\.\/public\/index\.js"/i);
  assert.doesNotMatch(terminalHtml, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
  assert.doesNotMatch(mobileHtml, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
  assert.doesNotMatch(terminalEntryHtml, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
  assert.doesNotMatch(indexHtml, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
  assert.doesNotMatch(terminalHtml, /\sstyle=/i);
  assert.doesNotMatch(mobileHtml, /\sstyle=/i);
  assert.doesNotMatch(terminalEntryHtml, /\sstyle=/i);
  assert.doesNotMatch(indexHtml, /\sstyle=/i);
  assert.doesNotMatch(server, new RegExp(`scriptSrc:\\s*\\[[^\\]]*${inlineDirectivePattern.source}`, "i"));
  assert.doesNotMatch(server, new RegExp(`styleSrc:\\s*\\[[^\\]]*${inlineDirectivePattern.source}`, "i"));
});

test("development LAN UI does not force HTTPS upgrades while production keeps CSP upgrade protection", () => {
  const server = read("src/server.mjs");
  assert.match(server, /upgradeInsecureRequests:\s*IS_PRODUCTION\s*\?\s*\[\]\s*:\s*null/);
});

test("SR-10 mobile polling includes issued and unknown-status safe handling", () => {
  const mobileJs = read("public/mobile.js");
  assert.match(mobileJs, /issued/);
  assert.match(mobileJs, /FINAL_STATUSES/);
  assert.match(mobileJs, /不明な状態です。確認のため自動更新を継続しています。/);
  assert.match(mobileJs, /wallet_deeplink/);
  assert.match(mobileJs, /payment_uri/);
  assert.match(mobileJs, /wallet_url/);
  assert.match(mobileJs, /buildManualPaymentInstructions/);
  assert.doesNotMatch(mobileJs, /adapter\.available && adapter\.wallet_help_url\) return/);
});

test("SR-10 terminal SSE reconnect refreshes current invoice snapshot", () => {
  const terminalJs = read("public/terminal.js");
  assert.match(terminalJs, /addEventListener\("open"/);
  assert.match(terminalJs, /void loadInvoice\(invoiceId, \{ silent: true \}\)/);
  assert.match(terminalJs, /requestSequence !== state\.invoiceRequestSequence/);
  assert.match(terminalJs, /FALLBACK_POLL_INTERVAL_MS/);
  assert.match(terminalJs, /\/api\/v1\/invoices\/\$\{encodeURIComponent\(invoiceId\)\}\/sse-token/);
  assert.match(terminalJs, /sse_token=\$\{encodeURIComponent\(sseToken\)\}/);
  assert.doesNotMatch(terminalJs, /sse_token=\$\{encodeURIComponent\(state\.token\)\}/);
  assert.match(terminalJs, /diagnosticsEnabled/);
  assert.match(terminalJs, /sse_connection:/);
  assert.match(terminalJs, /polling_fallback:/);
});

test("index prototype demo controls are guarded and delete key has aria-label", () => {
  const indexHtml = read("index.html");
  const indexJs = read("public/index.js");
  const server = read("src/server.mjs");

  assert.match(indexHtml, /data-key="back"[^>]*aria-label="削除"/);
  assert.match(indexHtml, /id="demoControlsSection"/);
  assert.match(indexHtml, /id="demoModeBadge"/);
  assert.match(indexHtml, /JPYC Merchant Ops プロトタイプ/);
  assert.match(indexHtml, /Merchant Opsで勝つ理由/);
  assert.match(indexHtml, /払われた後に店舗が困らない/);
  assert.match(indexHtml, /data-prototype-preset="1000"/);
  assert.match(indexHtml, /Pilot-ready/);

  assert.match(indexJs, /query\.get\("demo"\)\s*===\s*"1"/);
  assert.match(indexJs, /config\.app_env\s*!==\s*"production"/);
  assert.match(indexJs, /config\.demo_controls_enabled\s*===\s*true/);
  assert.match(indexJs, /demoControlsSection\.remove\(\)/);
  assert.match(indexJs, /data-prototype-preset/);

  assert.match(server, /DEMO_CONTROLS_ENABLED/);
  assert.match(server, /app_env:\s*APP_ENV/);
  assert.match(server, /demo_controls_enabled:\s*DEMO_CONTROLS_ENABLED/);
});

test("mobile customer-first UX keeps technical fields in details and includes wallet CTA", () => {
  const mobileHtml = read("public/mobile.html");
  const mobileJs = read("public/mobile.js");
  assert.match(mobileHtml, /JPYCお支払い案内/);
  assert.match(mobileHtml, /迷わないお支払い手順/);
  assert.match(mobileHtml, /二重送金せず確認完了まで/);
  assert.match(mobileHtml, /店舗/);
  assert.match(mobileHtml, /お支払い金額/);
  assert.match(mobileHtml, /お支払い期限/);
  assert.match(mobileHtml, /ウォレットで支払う/);
  assert.match(mobileHtml, /はじめての方へ/);
  assert.match(mobileHtml, /対応ウォレットとサポート/);
  assert.match(mobileHtml, /id="customerActionCard"/);
  assert.match(mobileHtml, /<details[^>]*id="technicalDetails"/);
  assert.match(mobileHtml, /支払いネットワーク/);
  assert.match(mobileHtml, /支払い先/);
  assert.doesNotMatch(mobileHtml, /<input[^>]*(秘密鍵|シードフレーズ)/);
  assert.match(mobileHtml, /秘密鍵・シードフレーズを聞くことはありません/);
  assert.match(mobileJs, /renderWalletSupport/);
  assert.match(mobileJs, /renderCustomerAction/);
  assert.match(mobileJs, /supported_wallets/);
});

test("terminal staff/admin IA and review empty/loading/error placeholders are present", () => {
  const terminalHtml = read("public/terminal.html");
  const terminalJs = read("public/terminal.js");
  const terminalEntryHtml = read("public/terminal-entry.html");
  const terminalEntryJs = read("public/terminal-entry.js");
  const server = read("src/server.mjs");
  assert.match(terminalHtml, /viewport-fit=cover/);
  assert.match(terminalHtml, /JPYC Merchant Ops 端末/);
  assert.match(terminalHtml, /端末セッション/);
  assert.match(terminalHtml, /請求作成（運用起点）/);
  assert.match(terminalHtml, /端末入口QR URL/);
  assert.match(terminalHtml, /この会計の支払いURL/);
  assert.match(terminalHtml, /お客様提示（端末入口QR \/ タッチ案内）/);
  assert.match(terminalHtml, /id="presentTapBtn"/);
  assert.match(terminalHtml, /id="resumeQrBtn"/);
  assert.match(terminalHtml, /id="tapModePanel"/);
  assert.match(terminalHtml, /id="amountPresetList"/);
  assert.match(terminalHtml, /id="presetAmountInput"/);
  assert.match(terminalHtml, /id="operatorGuideCard"/);
  assert.match(terminalHtml, /id="diagnosticsCard"/);
  assert.match(terminalHtml, /診断モード/);
  assert.match(terminalHtml, /Read-only/);
  assert.match(terminalHtml, /確認待ち支払い/);
  assert.match(terminalHtml, /id="reviewSummaryChips"/);
  assert.match(terminalHtml, /id="reviewDetailCard"/);
  assert.match(terminalHtml, /本日の運用サマリー/);
  assert.match(terminalHtml, /id="opsPriorityReview"/);
  assert.match(terminalHtml, /id="opsRefundCandidateCount"/);
  assert.match(terminalHtml, /優先度/);
  assert.match(terminalHtml, /id="reviewDetailAction"/);
  assert.match(terminalHtml, /id="reviewRelatedInvoices"/);
  assert.match(terminalHtml, /返金記録/);
  assert.match(terminalHtml, /id="refundExecutedWalletInput"/);
  assert.match(terminalHtml, /id="refundEvidenceNotePathInput"/);
  assert.match(terminalHtml, /id="refundCustomerNoteInput"/);
  assert.match(terminalHtml, /id="refundDraftHint"/);
  assert.match(terminalHtml, /日次締め \/ CSV出力/);
  assert.match(terminalHtml, /id="reviewListState"/);
  assert.match(terminalHtml, /外部ウォレットで実行した返金を記録・検証します/);
  assert.match(terminalJs, /diagnostic_mode_enabled/);
  assert.match(terminalJs, /renderOperatorGuide/);
  assert.match(terminalJs, /selectReview/);
  assert.match(terminalJs, /loadOpsSnapshot/);
  assert.match(terminalJs, /computeReviewSuggestion/);
  assert.match(terminalJs, /compareReviewsByPriority/);
  assert.match(terminalJs, /reviewPriorityMeta/);
  assert.match(terminalJs, /applyRefundDraftFromReview/);
  assert.match(terminalJs, /related_invoices/);
  assert.match(terminalJs, /同じ会計で再発行された請求があります/);
  assert.match(terminalJs, /buildMonitorWarnings/);
  assert.match(terminalJs, /fixedQrUrl/);
  assert.match(terminalJs, /renderCustomerFacingQr/);
  assert.match(terminalJs, /provider_summary/);
  assert.match(terminalJs, /handlePresentTap/);
  assert.match(terminalJs, /handleResumeQr/);
  assert.match(terminalJs, /TERMINAL_ACTIVE_INVOICE_EXISTS/);
  assert.match(terminalJs, /normalizeAmountPresetList/);
  assert.match(terminalJs, /DEFAULT_AMOUNT_PRESETS/);
  assert.match(terminalEntryHtml, /JPYCお支払い案内/);
  assert.match(terminalEntryJs, /public\/terminal-entry/);
  assert.match(terminalEntryJs, /会計がまだ立っていない/);
  assert.match(terminalEntryJs, /店頭端末でお支払いをご案内しています/);
  assert.match(terminalEntryHtml, /id="openInvoiceBtn"[^>]*>この会計を開く</);
  assert.match(terminalEntryJs, /async function handleOpenInvoice/);
  assert.match(terminalEntryJs, /window\.location\.replace/);
  assert.match(server, /DIAGNOSTIC_MODE_ENABLED/);
  assert.match(server, /buildInvoiceDiagnostics/);
  assert.match(server, /app\.get\("\/t\/:publicEntryToken"/);
  assert.match(server, /api\/v1\/public\/terminal-entry/);
  assert.match(server, /provider-sessions:present/);
  assert.match(server, /provider_summary/);
});

test("consent gate: mobile.html has consent section with checkbox, policy links, and risk warnings", () => {
  const mobileHtml = read("public/mobile.html");
  assert.match(mobileHtml, /id="consentGateSection"/);
  assert.match(mobileHtml, /id="consentCheckbox"/);
  assert.match(mobileHtml, /id="consentCheckboxLabel"/);
  assert.match(mobileHtml, /id="consentTermsLink"/);
  assert.match(mobileHtml, /id="consentPrivacyLink"/);
  assert.match(mobileHtml, /id="consentRefundLink"/);
  assert.match(mobileHtml, /id="consentLiveStatus"/);
  assert.match(mobileHtml, /利用規約・プライバシーポリシー・返金ポリシーを確認しました/);
  assert.match(mobileHtml, /二重送金・分割送金/);
  assert.match(mobileHtml, /誤チェーン・誤トークン・誤アドレス/);
  assert.match(mobileHtml, /選択されたネットワークのガス代/);
  assert.match(mobileHtml, /秘密鍵・シードフレーズを聞くことはありません/);
  assert.match(mobileHtml, /aria-live="polite"/);
});

test("consent gate: mobile.js gates wallet/copy buttons behind state.consented and records server audit", () => {
  const mobileJs = read("public/mobile.js");
  assert.match(mobileJs, /state\.consented/);
  assert.match(mobileJs, /POLICY_URLS/);
  assert.match(mobileJs, /POLICY_VERSIONS/);
  assert.match(mobileJs, /terms_version/);
  assert.match(mobileJs, /privacy_version/);
  assert.match(mobileJs, /refund_policy_version/);
  assert.match(mobileJs, /renderConsentGate/);
  assert.match(mobileJs, /handleConsentChange/);
  assert.match(mobileJs, /signedConsentPath/);
  assert.match(mobileJs, /recordConsent/);
  assert.match(mobileJs, /state\.consented.*walletAllowed|walletAllowed.*state\.consented/);
  assert.match(mobileJs, /customer_policy_consent|\/consent/);
  assert.match(mobileJs, /consentCheckbox.*addEventListener|addEventListener.*consentCheckbox/);
});

test("consent gate: detail copy buttons and handlers all enforce state.consented", () => {
  const mobileJs = read("public/mobile.js");
  assert.match(
    mobileJs,
    /el\.copyAddressBtn\.disabled\s*=\s*!walletAllowed/,
    "copyAddressBtn must follow walletAllowed (consent-aware) gate in renderInvoice"
  );
  assert.match(
    mobileJs,
    /el\.copyAmountBtn\.disabled\s*=\s*!walletAllowed/,
    "copyAmountBtn must follow walletAllowed (consent-aware) gate in renderInvoice"
  );
  assert.match(
    mobileJs,
    /el\.copyInvoiceBtn\.disabled\s*=\s*!walletAllowed/,
    "copyInvoiceBtn must follow walletAllowed (consent-aware) gate in renderInvoice"
  );
  for (const handlerName of ["handleCopyInfo", "handleCopyAddress", "handleCopyAmount", "handleCopyInvoice"]) {
    const fnPattern = new RegExp(
      `async function ${handlerName}\\([^)]*\\)\\s*\\{[\\s\\S]*?if \\(!state\\.consented\\)`,
    );
    assert.match(mobileJs, fnPattern, `${handlerName} must short-circuit when state.consented is false`);
  }
});

test("consent gate: server.mjs exposes /consent endpoint with sig verification and rate limiting", () => {
  const server = read("src/server.mjs");
  assert.match(server, /\/api\/v1\/public\/invoices\/:invoiceId\/consent/);
  assert.match(server, /isPublicRateLimited.*public:consent/);
  assert.match(server, /verifySig\(invoiceId/);
  assert.match(server, /evaluatePolicyUrlsGate\(\)/);
  assert.match(server, /POLICY_CONFIGURATION_NOT_READY/);
  assert.match(server, /validatePolicyVersionSubmission/);
  assert.match(server, /POLICY_VERSION_MISMATCH/);
  assert.match(server, /customer_policy_consent/);
  assert.match(server, /terms_version/);
  assert.match(server, /privacy_version/);
  assert.match(server, /refund_policy_version/);
  assert.match(server, /recorded_at/);
});

test("status terminology: review_required is canonical and manual_review is alias-only compatibility", () => {
  const mobileJs = read("public/mobile.js");
  const terminalJs = read("public/terminal.js");
  assert.match(mobileJs, /INVOICE_STATUS_ALIASES/);
  assert.match(mobileJs, /manual_review:\s*"review_required"/);
  assert.match(mobileJs, /function canonicalInvoiceStatus/);
  assert.match(terminalJs, /INVOICE_STATUS_ALIASES/);
  assert.match(terminalJs, /manual_review:\s*"review_required"/);
  assert.match(terminalJs, /function canonicalInvoiceStatus/);
});
