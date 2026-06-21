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
  assert.match(terminalHtml, /<script\s+src="\/terminal\.js(?:\?[^"]*)?"/i);
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
  assert.match(terminalJs, /if\s*\(state\.invoiceId\)\s*\{\s*void loadInvoice\(state\.invoiceId/);
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
  const appCss = read("public/app.css");
  assert.match(mobileHtml, /JPYCでお支払い/);
  assert.match(mobileHtml, /迷わないお支払い手順/);
  assert.match(
    mobileHtml,
    /<details class="details payment-guide-details payment-guide-compact">\s*<summary id="paymentActionTitle">[\s\S]*迷わないお支払い手順[\s\S]*<\/summary>/,
    "payment guide should be a compact collapsed disclosure with an accessible action title"
  );
  assert.match(mobileHtml, /金額・送金先を確認してください/);
  assert.match(mobileHtml, /id="summaryNetworkText"/);
  assert.match(mobileHtml, /id="summaryStoreText"/);
  assert.doesNotMatch(mobileHtml, /id="helpBtn"/);
  assert.doesNotMatch(mobileJs, /helpBtn/);
  assert.doesNotMatch(mobileJs, /signedPayPath/);
  assert.match(mobileHtml, /店舗/);
  assert.match(mobileHtml, /お支払い金額/);
  assert.match(mobileHtml, /お支払い期限/);
  assert.doesNotMatch(mobileHtml, /id="expiredNotice"/);
  assert.doesNotMatch(mobileHtml, /この請求は期限切れです。送金せず、店舗スタッフに再発行を依頼してください。/);
  assert.match(mobileHtml, /ウォレットで支払う/);
  assert.match(mobileHtml, /M19 7V4a1 1 0 0 0-1-1H5/);
  assert.match(mobileJs, /M19 7V4a1 1 0 0 0-1-1H5/);
  assert.doesNotMatch(mobileHtml, /id="closeErrorBannerBtn"/);
  assert.doesNotMatch(mobileHtml, />閉じる<\/button>/);
  assert.doesNotMatch(mobileHtml, /id="consentGateSection"/);
  assert.doesNotMatch(mobileHtml, /id="consentCheckbox"/);
  assert.doesNotMatch(mobileHtml, /<details class="details payment-guide-details" open>/);
  assert.match(mobileHtml, /id="walletDisabledReason"/);
  assert.match(mobileHtml, /mobile-bottom-sheet/);
  assert.match(mobileHtml, />更新<\/button>/);
  assert.doesNotMatch(mobileHtml, /最新の状態に更新/);
  assert.match(mobileHtml, /はじめての方へ/);
  assert.match(mobileHtml, />対応ウォレット</);
  assert.match(mobileHtml, /id="paymentConditionsCard" class="wallet-support-inline mobile-wallet-support-card hidden"/);
  assert.match(mobileHtml, /class="wallet-support-inline mobile-wallet-support-card hidden"/);
  assert.doesNotMatch(mobileHtml, /id="walletSupportText"/);
  assert.doesNotMatch(mobileHtml, /id="walletAvailabilityBadge"/);
  assert.doesNotMatch(mobileHtml, /いまの状況と次の行動/);
  assert.match(mobileHtml, /id="customerActionCard" class="card stack mt-16 hidden"/);
  assert.match(mobileHtml, /id="customerActionList" class="warning-list compact-list"/);
  assert.match(mobileHtml, /<details[^>]*id="technicalDetails"/);
  assert.match(mobileHtml, /支払いネットワーク/);
  assert.match(mobileHtml, /支払い先/);
  assert.doesNotMatch(mobileHtml, /<input[^>]*(秘密鍵|シードフレーズ)/);
  assert.match(mobileHtml, /秘密鍵・シードフレーズを聞くことはありません/);
  assert.match(mobileJs, /renderWalletSupport/);
  assert.match(mobileJs, /renderCustomerAction/);
  assert.match(mobileJs, /!el\.supportedWalletChips/);
  assert.match(mobileJs, /!el\.customerActionCard/);
  assert.match(mobileJs, /customerActionCard\.classList\.remove\("hidden"\)/);
  assert.match(mobileJs, /supported_wallets/);
  assert.match(mobileJs, /primaryActionStack[\s\S]*classList\.toggle\("hidden", isReceiptMode\)/);
  assert.match(mobileJs, /paymentGuideDetails\)\s*el\.paymentGuideDetails\.classList\.toggle\("hidden", needsStaff \|\| isReceiptMode\)/);
  assert.match(mobileJs, /if\s*\(needsStaff\)\s*setMethodPanel\(false, ""\)/);
  assert.doesNotMatch(mobileJs, /const message = staffGuidanceMessage\(invoice\)[\s\S]{0,100}setMethodPanel\(true, message\)/);
  assert.doesNotMatch(mobileJs, /status === "expired"[\s\S]{0,100}customerActionCard\.classList\.add\("hidden"\)/);
  assert.match(mobileJs, /スタッフに見せる/);
  assert.match(mobileJs, /errorBannerCloseBtn/);
  assert.match(mobileJs, /function updateExpiredNotice/);
  assert.match(mobileJs, /isInvoiceExpired/);
  assert.doesNotMatch(mobileJs, /paymentGuideDetails\?\.classList\.toggle\("hidden", expired\)/);
  assert.match(mobileJs, /remaining-expired-label/);
  assert.doesNotMatch(mobileJs, /remainingText\.classList\.add\("attention-pulse"\)/);
  assert.doesNotMatch(mobileJs, /closeErrorBannerBtn/);
  assert.match(mobileJs, /このURLは無効です。/);
  assert.doesNotMatch(mobileJs, /署名付きの支払いURLをご確認ください/);
  assert.match(mobileJs, /amountText\.textContent = `\$\{toNumber\(invoice\.amount_jpyc\)\.toLocaleString\("ja-JP"\)\} \$\{getTokenSymbol\(invoice\)\}`/);
  assert.match(mobileJs, /amountSubText\.textContent = formatJpy\(invoice\.amount_jpy\)/);
  assert.match(appCss, /\.remaining-expired-label[\s\S]*background: var\(--color-danger-soft\)/);
  assert.doesNotMatch(appCss, /\.mobile-expired-notice/);
  assert.match(appCss, /\.error-banner > span[\s\S]*background: var\(--color-danger-soft\)/);
  assert.match(appCss, /\.mobile-summary-card \.amount-primary[\s\S]*color: var\(--color-primary\)[\s\S]*font-size: clamp\(48px, 14vw, 64px\)/);
  assert.match(appCss, /\.mobile-summary-card \.amount-sub[\s\S]*color: var\(--color-text\)[\s\S]*font-size: clamp\(18px, 5vw, 24px\)/);
  assert.match(appCss, /\.mobile-network-value::before[\s\S]*8247e5[\s\S]*mask: url\("data:image\/svg\+xml/);
  assert.match(appCss, /\.mobile-payment-status-row[\s\S]*justify-content: space-between/);
  assert.match(appCss, /\.mobile-disclosure-stack \.details > summary[\s\S]*grid-template-columns: 34px minmax\(0, 1fr\) 34px/);
  assert.match(appCss, /\.mobile-disclosure-stack \.details > summary::after[\s\S]*font-size: 28px/);
  assert.match(appCss, /\.mobile-surface \.secondary-action-row[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(appCss, /#technicalDetails > summary,[\s\S]*#refreshBtn[\s\S]*font-size: var\(--font-size-md\)/);
});

test("terminal staff/admin IA and review empty/loading/error placeholders are present", () => {
  const terminalHtml = read("public/terminal.html");
  const terminalJs = read("public/terminal.js");
  const terminalEntryHtml = read("public/terminal-entry.html");
  const terminalEntryJs = read("public/terminal-entry.js");
  const server = read("src/server.mjs");
  assert.match(terminalHtml, /viewport-fit=cover/);
  assert.match(terminalHtml, /JPYC Merchant Ops 端末/);
  assert.match(terminalHtml, /data-tab-target="billing"/);
  assert.match(terminalHtml, /data-tab-target="reviews"/);
  assert.match(terminalHtml, /data-tab-target="refunds"/);
  assert.match(terminalHtml, /data-tab-target="settlement"/);
  assert.match(terminalHtml, /data-tab-target="settings"/);
  assert.match(terminalHtml, /data-tab-panel="billing"/);
  assert.match(terminalHtml, /data-tab-panel="settings"/);
  assert.match(terminalHtml, /id="testNotificationSoundBtn"[^>]*>▶ 通知音をテスト<\/button>/);
  assert.match(terminalHtml, /id="terminalDiagnosticsPanel" class="terminal-diagnostics-panel"/);
  assert.doesNotMatch(terminalHtml, /端末診断を実行/);
  assert.doesNotMatch(terminalHtml, /保存済み \d/);
  assert.doesNotMatch(terminalHtml, /未保存の変更があります/);
  assert.match(terminalHtml, /id="saveSettingsBtn"[^>]*disabled/);
  assert.doesNotMatch(terminalHtml, /id="saveSettingsBottomBtn"/);
  assert.match(terminalHtml, /id="settingsStoreName"/);
  assert.match(terminalHtml, /id="settingsStaffName"/);
  assert.doesNotMatch(terminalHtml, /JPYCカフェ 渋谷店/);
  assert.doesNotMatch(terminalHtml, /山田 太郎・管理者/);
  assert.doesNotMatch(terminalHtml, /id="terminalCode"[^>]*value="TERM-001"/);
  assert.match(terminalHtml, /id="adminLoginShortcutBtn"[^>]*>管理者としてログインするには？<\/button>/);
  assert.match(terminalHtml, /管理者PINを入力すると、管理者モードで端末を開始できます。/);
  assert.match(terminalHtml, /disabled title="この設定は現バージョンでは未対応です"[\s\S]{0,120}重要警告を大きく表示/);
  assert.match(terminalHtml, /未操作ロック時間[\s\S]{0,160}disabled[\s\S]{0,120}この設定は現バージョンでは未対応です/);
  assert.match(terminalHtml, /disabled title="この設定は現バージョンでは未対応です"[\s\S]{0,120}ロック画面に戻る前に確認を表示/);
  assert.match(terminalJs, /renderSettingsSessionSummary/);
  assert.match(terminalJs, /staffNameInput/);
  assert.match(terminalJs, /staff_name/);
  assert.match(server, /staff_name:\s*staff\.staff_name/);
  assert.match(terminalJs, /ERROR_MESSAGE_BY_CODE/);
  assert.match(terminalJs, /AML_POLICY_NOT_APPROVED/);
  assert.match(terminalJs, /高額請求は承認が完了するまで作成できません/);
  assert.match(terminalJs, /\[ぁ-んァ-ン一-龯\]/);
  assert.doesNotMatch(terminalJs, /data\?\.error\?\.message\s*\|\|\s*fallback/);
  assert.match(terminalJs, /executeRefundBtn\)\s*el\.executeRefundBtn\.disabled = workflowStatus !== "approved"/);
  assert.match(terminalJs, /verifyRefundBtn\)\s*el\.verifyRefundBtn\.disabled = workflowStatus !== "recorded"/);
  assert.doesNotMatch(terminalJs, /reviewsTableBody/);
  assert.doesNotMatch(terminalJs, /createReviewRow/);
  assert.doesNotMatch(terminalJs, /selectRefundCaseCard/);
  assert.match(terminalJs, /一致する確認待ちはありません/);
  assert.match(terminalHtml, /最近の運用警告/);
  assert.doesNotMatch(terminalHtml, /監査ログを開く/);
  assert.match(terminalHtml, /端末セッション/);
  assert.match(terminalHtml, /id="invoiceCreateTitle" class="title title-lg">会計<\/h2>/);
  assert.match(terminalHtml, /id="amountInput"[^>]*type="text"[^>]*inputmode="numeric"[^>]*pattern="\[0-9\]\*"/);
  assert.match(terminalHtml, /class="invoice-action-row"/);
  assert.match(terminalHtml, /class="billing-secondary-controls"/);
  assert.match(terminalHtml, /id="invoiceDangerActions" class="details danger-actions billing-compact-details"/);
  assert.match(terminalHtml, /<summary>請求を取り消す \/ 変更する<\/summary>/);
  assert.match(terminalHtml, /<summary>プリセットを編集<\/summary>/);
  assert.doesNotMatch(terminalHtml, /現在の請求を無効化または期限切れにする副操作です/);
  const appCss = read("public/app.css");
  assert.match(appCss, /\.invoice-action-row[\s\S]*grid-template-columns: 1fr/);
  assert.match(appCss, /\.billing-secondary-controls[\s\S]*display: flex/);
  assert.match(appCss, /\.billing-compact-details[\s\S]*flex: 0 1 260px/);
  assert.match(appCss, /\.split-layout\.billing-primary[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(appCss, /\.billing-primary[\s\S]*align-items: stretch/);
  assert.match(appCss, /\.billing-present \.amount-primary[\s\S]*font-size: clamp\(22px, 3vw, 32px\)/);
  assert.match(appCss, /#qrCanvas[\s\S]*max-width: 420px/);
  assert.match(appCss, /\.qr-wallet-support[\s\S]*width: 100%/);
  assert.match(appCss, /\.qr-wallet-support \.chip-group[\s\S]*flex-wrap: nowrap/);
  assert.match(appCss, /\.qr-wallet-support \.chip[\s\S]*font-size: var\(--font-size-sm\)/);
  assert.match(appCss, /\.qr-wallet-support \.chip[\s\S]*white-space: nowrap/);
  assert.match(appCss, /\.details:not\(\[open\]\) > \.details-content[\s\S]*display: none/);
  assert.match(terminalHtml, /端末入口QR URLを表示/);
  assert.match(terminalHtml, /支払いURL/);
  assert.match(terminalHtml, /class="details billing-url-details"/);
  assert.match(terminalHtml, /<summary>端末入口QR URLを表示<\/summary>/);
  assert.match(terminalHtml, /お客様用QR/);
  assert.match(terminalHtml, /class="qr-wallet-support stack gap-tight"/);
  assert.ok(
    terminalHtml.indexOf('id="operatorWalletChips"') < terminalHtml.indexOf("お客様用QR"),
    "supported wallets should appear above the customer-facing QR heading"
  );
  assert.ok(
    terminalHtml.indexOf("お客様用QR") < terminalHtml.indexOf('id="qrCanvas"'),
    "customer-facing QR heading should stay above the QR canvas"
  );
  assert.match(terminalHtml, /id="operatorGuideCard"/);
  assert.match(terminalHtml, /id="operatorGuideBadge"/);
  assert.match(terminalHtml, /id="operatorGuideHeadline"/);
  assert.match(terminalHtml, /id="operatorGuideBody"/);
  assert.match(terminalHtml, /id="operatorGuideList"/);
  assert.match(terminalHtml, /id="operatorStreamStatus"/);
  assert.match(terminalHtml, /id="operatorReviewId"/);
  assert.match(terminalHtml, /id="operatorGuideAction"/);
  assert.doesNotMatch(terminalHtml, /id="customerDisplayHint"/);
  assert.doesNotMatch(terminalHtml, /このQRは端末ごとの入口です/);
  assert.match(terminalHtml, /id="presentTapBtn"/);
  assert.match(terminalHtml, /id="providerControlHint"/);
  assert.match(terminalHtml, /QR とタッチ案内は同じ会計で同時に開きません/);
  assert.match(terminalHtml, /QRを再発行/);
  assert.match(terminalHtml, /id="resumeQrBtn"/);
  assert.match(terminalHtml, /QR表示へ戻る/);
  assert.match(terminalHtml, /id="tapModePanel"/);
  assert.match(terminalHtml, /id="amountPresetList"/);
  assert.match(terminalHtml, /id="presetAmountInput"/);
  assert.match(terminalHtml, /金額ボタンは押すたびに現在の金額へ加算します/);
  assert.match(terminalJs, /data-preset-action="edit"|dataset\.presetAction = "edit"/);
  assert.match(terminalJs, /currentAmount \+ addAmount/);
  assert.doesNotMatch(appCss, /\.preset-chip \.btn-remove\s*\{[\s\S]{0,120}?display:\s*none/);
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
  assert.match(terminalHtml, /id="goRefundFromReviewBtn"/);
  assert.match(terminalHtml, /返金記録/);
  assert.match(terminalHtml, /id="refundExecutedWalletInput"/);
  assert.match(terminalHtml, /id="refundEvidenceNotePathInput"/);
  assert.match(terminalHtml, /id="refundCustomerNoteInput"/);
  assert.match(terminalHtml, /id="refundDraftHint"/);
  assert.match(terminalHtml, /日次締め \/ CSV出力/);
  assert.match(terminalHtml, /class="settlement-audit-action"/);
  assert.match(terminalHtml, /id="openAuditLogsBtn"[^>]*>監査ログを確認<\/button>/);
  assert.ok(
    terminalHtml.indexOf('class="settlement-audit-action"') > terminalHtml.indexOf("出力（帳票・データ）"),
    "audit log action should live in the settlement output area"
  );
  assert.match(terminalHtml, /id="reviewListState"/);
  assert.match(terminalHtml, /外部ウォレットで実行した返金を記録・検証します/);
  assert.match(terminalJs, /diagnostic_mode_enabled/);
  assert.match(terminalJs, /activeTab:\s*"billing"/);
  assert.match(terminalJs, /function setActiveTab/);
  assert.match(terminalJs, /function canShowTab/);
  assert.match(terminalJs, /function playNotificationTestSound/);
  assert.match(terminalJs, /window\.AudioContext \|\| window\.webkitAudioContext/);
  assert.match(terminalJs, /testNotificationSoundBtn\?\.addEventListener\("click"/);
  assert.match(terminalJs, /async function refreshTerminalDiagnostics/);
  assert.match(terminalJs, /void refreshTerminalDiagnostics\(\)/);
  assert.match(terminalJs, /function updateSettingsSaveState/);
  assert.match(terminalJs, /button\.disabled = !hasUnsavedChanges/);
  assert.match(terminalJs, /data\.tabTarget|dataset\.tabTarget/);
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
  assert.match(terminalJs, /if\s*\(el\.resumeQrBtn\)/);
  assert.match(terminalJs, /if\s*\(el\.providerControlHint\)/);
  assert.match(terminalJs, /TERMINAL_ACTIVE_INVOICE_EXISTS/);
  assert.match(terminalJs, /normalizeAmountPresetList/);
  assert.match(terminalJs, /DEFAULT_AMOUNT_PRESETS/);
  assert.match(terminalEntryHtml, /JPYCお支払い準備中/);
  assert.match(terminalEntryHtml, /JPYCお支払い準備中/);
  assert.match(terminalEntryJs, /public\/terminal-entry/);
  assert.match(terminalEntryJs, /会計がまだ立っていない/);
  assert.match(terminalEntryJs, /店頭端末でお支払いをご案内しています/);
  assert.match(terminalEntryJs, /window\.location\.replace/);
  assert.match(server, /DIAGNOSTIC_MODE_ENABLED/);
  assert.match(server, /buildInvoiceDiagnostics/);
  assert.match(server, /app\.get\("\/t\/:publicEntryToken"/);
  assert.match(server, /api\/v1\/public\/terminal-entry/);
  assert.match(server, /provider-sessions:present/);
  assert.match(server, /provider_summary/);
});

test("policy acknowledgement evidence: mobile.html has explicit consent checkbox and policy links", () => {
  const mobileHtml = read("public/mobile.html");
  const appCss = read("public/app.css");
  const termsHtml = read("public/legal/dev-terms.html");
  const privacyHtml = read("public/legal/dev-privacy.html");
  const refundHtml = read("public/legal/dev-refund.html");
  const server = read("src/server.mjs");
  assert.match(mobileHtml, /id="policyConsentCheckbox"/);
  assert.match(mobileHtml, /class="policy-check-label"/);
  assert.match(mobileHtml, /規約・返金方針を確認しました/);
  assert.match(mobileHtml, /id="policyTermsLink"/);
  assert.match(mobileHtml, /id="policyPrivacyLink"/);
  assert.match(mobileHtml, /id="policyRefundLink"/);
  assert.match(mobileHtml, /class="policy-link-list"/);
  assert.doesNotMatch(mobileHtml, /id="policyTermsLink" class="btn/);
  assert.doesNotMatch(mobileHtml, /id="policyPrivacyLink" class="btn/);
  assert.doesNotMatch(mobileHtml, /id="policyRefundLink" class="btn/);
  assert.doesNotMatch(mobileHtml, /お支払い前の確認・同意/);
  assert.match(mobileHtml, /id="policyDetails"/);
  assert.match(mobileHtml, /二重送金・分割送金/);
  assert.match(mobileHtml, /誤チェーン・誤トークン・誤アドレス/);
  assert.match(mobileHtml, /ガス代（MATIC等）/);
  assert.match(mobileHtml, /秘密鍵・シードフレーズを聞くことはありません/);
  assert.match(mobileHtml, /aria-live="polite"/);
  assert.match(mobileHtml, /税務上の領収書または適格請求書ではありません/);
  assert.doesNotMatch(mobileHtml, /receipt-bottom-nav/);
  assert.doesNotMatch(mobileHtml, /お支払い画面ナビゲーション/);
  assert.doesNotMatch(appCss, /\.receipt-bottom-nav/);
  assert.match(appCss, /\.policy-check-label/);
  assert.match(appCss, /\.policy-link-list li::before[\s\S]*border-radius: 999px/);
  assert.match(server, /"\/legal\/dev-terms"/);
  assert.match(server, /res\.type\("html"\)/);
  assert.match(termsHtml, /JPYCお支払い案内 利用規約/);
  assert.match(termsHtml, /資産、秘密鍵、シードフレーズ、ウォレットの署名権限を保有しません/);
  assert.match(privacyHtml, /秘密鍵、シードフレーズ、ウォレット復元情報/);
  assert.match(privacyHtml, /監査対応のために必要な証跡/);
  assert.match(refundHtml, /返金は自動送金ではありません/);
  assert.match(refundHtml, /誤チェーン/);
});

test("policy acknowledgement evidence: mobile.js records server audit before wallet/copy actions", () => {
  const mobileJs = read("public/mobile.js");
  assert.match(mobileJs, /state\.policyAcknowledged/);
  assert.match(mobileJs, /POLICY_URLS/);
  assert.match(mobileJs, /POLICY_VERSIONS/);
  assert.match(mobileJs, /terms_version/);
  assert.match(mobileJs, /privacy_version/);
  assert.match(mobileJs, /refund_policy_version/);
  assert.doesNotMatch(mobileJs, /renderConsentGate/);
  assert.match(mobileJs, /ensurePolicyAcknowledgementRecorded/);
  assert.match(mobileJs, /signedPolicyAcknowledgementPath/);
  assert.match(mobileJs, /recordPolicyAcknowledgement/);
  assert.match(mobileJs, /await ensurePolicyAcknowledgementRecorded\(\)/);
  assert.match(mobileJs, /\/consent/);
  assert.doesNotMatch(mobileJs, /customer_policy_consent/);
  assert.doesNotMatch(mobileJs, /consented|consentRecordId|recordConsent|signedConsentPath|ensureConsentRecorded/);
  assert.match(mobileJs, /function setPolicyLink/);
  assert.match(mobileJs, /linkEl\.removeAttribute\("href"\)/);
  assert.doesNotMatch(mobileJs, /policyTermsLink\)\s*el\.policyTermsLink\.href\s*=\s*urls\.terms\s*\|\|\s*"#"/);
  assert.doesNotMatch(mobileJs, /consentCheckbox.*addEventListener|addEventListener.*consentCheckbox/);
  assert.doesNotMatch(mobileJs, /helpBtn/);
  assert.doesNotMatch(mobileJs, /signedPayPath/);
});

test("policy acknowledgement evidence: detail copy buttons are action-gated and handlers record policy acknowledgement first", () => {
  const mobileJs = read("public/mobile.js");
  assert.match(mobileJs, /const copyAllowed\s*=\s*Boolean\(invoice\)\s*&&\s*!isReceiptMode/);
  assert.match(mobileJs, /const primaryActionAllowed\s*=\s*walletAllowed\s*\|\|\s*needsStaff/);
  assert.match(
    mobileJs,
    /el\.copyAddressBtn\.disabled\s*=\s*!copyAllowed/,
    "copyAddressBtn must stay copy-enabled separately from wallet/manual-send availability"
  );
  assert.match(
    mobileJs,
    /el\.copyAmountBtn\.disabled\s*=\s*!copyAllowed/,
    "copyAmountBtn must stay copy-enabled separately from wallet/manual-send availability"
  );
  assert.match(
    mobileJs,
    /el\.copyInvoiceBtn\.disabled\s*=\s*!copyAllowed/,
    "copyInvoiceBtn must stay copy-enabled separately from wallet/manual-send availability"
  );
  assert.match(
    mobileJs,
    /el\.showMethodsBtn\.disabled\s*=\s*!walletAllowed/,
    "manual-send guidance must remain unavailable outside waiting statuses"
  );
  for (const handlerName of ["handleCopyInfo", "handleCopyAddress", "handleCopyAmount", "handleCopyInvoice"]) {
    const fnPattern = new RegExp(
      `async function ${handlerName}\\([^)]*\\)\\s*\\{[\\s\\S]*?await ensurePolicyAcknowledgementRecorded\\(\\)`,
    );
    assert.match(mobileJs, fnPattern, `${handlerName} must record policy acknowledgement before copying`);
  }
});

test("policy acknowledgement gate: server.mjs exposes /policy-acknowledgement endpoint with sig verification and rate limiting", () => {
  const server = read("src/server.mjs");
  assert.match(server, /\/api\/v1\/public\/invoices\/:invoiceId\/policy-acknowledgement/);
  assert.match(server, /isPublicRateLimited.*public:policy-acknowledgement/);
  assert.match(server, /verifySig\(invoiceId/);
  assert.match(server, /customer_policy_acknowledgement/);
  assert.doesNotMatch(server, /customer_policy_consent|consent_record_id|consented_at/);
  assert.match(server, /\/api\/v1\/public\/invoices\/:invoiceId\/consent/);
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
