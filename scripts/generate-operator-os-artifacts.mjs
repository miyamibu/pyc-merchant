import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JAPANESE_FONT_STACK } from "../src/operator-language.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "artifacts", "operator-os", "2026-04-29");
const MP4_DIR = path.join(ROOT, "artifacts", "manual-video-mp4", "2026-04-29", "videos");
const OUT_VIDEO_DIR = path.join(OUT_DIR, "videos");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title, target, body) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light; --ink: #132036; --muted: #50607a; --line: #d6deec; --soft: #f5f8fc; --ok: #0f7a4f; --warn: #906200; --stop: #b4372f; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px; color: var(--ink); background: linear-gradient(145deg, #f2f6ff, #fbfbf4); font-family: ${JAPANESE_FONT_STACK}; line-height: 1.7; }
    main { max-width: 1040px; margin: 0 auto; display: grid; gap: 20px; }
    header, section { background: rgba(255,255,255,.92); border: 1px solid var(--line); border-radius: 18px; padding: 22px; box-shadow: 0 12px 28px rgba(19,32,54,.08); }
    h1, h2, h3, p { margin-top: 0; }
    .badge { display: inline-block; border-radius: 999px; padding: 4px 10px; background: #e7edf8; font-weight: 700; font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
    .card { border: 1px solid var(--line); border-radius: 14px; padding: 16px; background: var(--soft); }
    .ok { color: var(--ok); font-weight: 800; }
    .warn { color: var(--warn); font-weight: 800; }
    .stop { color: var(--stop); font-weight: 800; }
    video { width: 100%; border-radius: 14px; border: 1px solid var(--line); background: #111; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <header>
      <span class="badge">${esc(target)}</span>
      <h1>${esc(title)}</h1>
      <p>この成果物は店舗運用OS向けに分割生成されています。対象読者以外の内部情報は含めない方針です。</p>
    </header>
    ${body}
  </main>
</body>
</html>
`;
}

function list(items) {
  return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("\n")}</ul>`;
}

function storeGuide() {
  return page("JPYC決済端末 店舗スタッフ クイックガイド", "store-staff-quick-guide", `
<section>
  <h2>まず見るところ</h2>
  <div class="grid">
    <div class="card"><h3>お支払い待ち</h3><p class="stop">商品引渡し: まだ渡さない</p><p>この会計のQRを読み取ってもらい、確認済みになるまで待ちます。</p></div>
    <div class="card"><h3>支払い確認済み</h3><p class="ok">商品引渡し: 渡してOK</p><p>商品を渡してよい状態です。必要なら確認書を案内します。</p></div>
    <div class="card"><h3>店長確認が必要</h3><p class="warn">商品引渡し: 保留</p><p>追加送金を促さず、店長または管理者を呼びます。</p></div>
    <div class="card"><h3>期限切れ/無効</h3><p class="stop">商品引渡し: まだ渡さない</p><p>古い画面から送金しないよう案内し、新しい請求を作成します。</p></div>
  </div>
</section>
<section>
  <h2>通常のお会計</h2>
  ${list([
    "端末コードとスタッフPINでログインします。PINは画面や資料に表示しません。",
    "請求金額を入力し、「請求を作成」を押します。",
    "お客様にこの会計のQRを読み取ってもらいます。",
    "画面が「支払い確認済み」になるまで商品は渡しません。",
    "ウォレットが開かない場合は、お客様画面の「支払い情報をコピー」を案内します。",
  ])}
</section>
<section>
  <h2>絶対にしないこと</h2>
  ${list([
    "お客様の秘密鍵・シードフレーズを聞かない",
    "お客様のウォレットを代わりに操作しない",
    "お客様のスマホを預からない",
    "送金先を口頭だけで読み上げて案内しない",
    "画面外のアドレスへ送るよう案内しない",
    "支払い確認済みになる前に商品を渡さない",
    "確認待ち中に追加送金を促さない",
  ])}
</section>`);
}

function adminManual() {
  return page("JPYC決済端末 管理者運用マニュアル", "admin-ops-manual", `
<section>
  <h2>管理者が扱う範囲</h2>
  ${list([
    "確認待ち支払いの理由、請求額、着金額、差額、取引番号を確認します。",
    "過入金・重複支払いは、返金ケースを作成し、店舗ウォレットで返金後に tx hash を登録します。",
    "アプリは返金送金を実行しません。証跡登録と検証を行います。",
    "日次締めは、未解決の確認待ち・返金証跡がある場合にブロックまたは警告します。",
    "CSV/JSON export は Settlement Export Contract v1 を source of truth とします。",
  ])}
</section>
<section>
  <h2>返金証跡カードの必須項目</h2>
  ${list([
    "refund_case_id: 返金ケースID",
    "original_invoice_id / checkout_session_id: 元請求と同じ会計の追跡",
    "reason / refund_amount_jpyc: 返金理由と返金額",
    "approved_by / executed_by / executed_wallet: 誰が承認し、誰がどの店舗ウォレットで外部返金したか",
    "refund_tx_hash: 外部ウォレットで返金した取引番号",
    "evidence_screenshot または evidence_note_path: スクリーンショットや証跡メモの保管先",
    "customer_note: お客様説明用メモ",
    "status / audit_log_refs: 状態と監査ログ参照",
  ])}
</section>
<section>
  <h2>確認待ち理由別の処理</h2>
  <div class="grid">
    <div class="card"><h3>不足入金</h3><p>不足額の追加請求、未完了扱い、店長判断のいずれかを選びます。元の請求額は変更しません。</p></div>
    <div class="card"><h3>過入金</h3><p>有効売上額を確認し、差額の返金ケースを作成します。</p></div>
    <div class="card"><h3>重複支払い</h3><p>1件を有効売上として残し、重複分の返金証跡を作成します。</p></div>
    <div class="card"><h3>期限後入金</h3><p>同じ会計の新しい請求が支払い済みか確認し、旧請求/重複扱いを判断します。</p></div>
  </div>
</section>`);
}

function customerHelp() {
  return page("JPYCお支払い お客様ヘルプ", "customer-help", `
<section>
  <h2>お支払い前</h2>
  ${list([
    "請求金額・ネットワーク・送金先を確認してください。",
    "この画面に表示された内容以外には送金しないでください。",
    "店舗スタッフが秘密鍵・シードフレーズを聞くことはありません。絶対に入力・共有しないでください。",
  ])}
</section>
<section>
  <h2>ウォレットが開かない場合</h2>
  <p>ウォレットが自動で開かない場合は、「支払い情報をコピー」から手動で送金してください。送金できない場合は、別のお支払い方法をご利用ください。</p>
</section>
<section>
  <h2>送金後</h2>
  <p>送金後は、この画面が「支払い確認済み」になるまでお待ちください。二重送金しないでください。</p>
</section>
<section>
  <h2>確認中・期限切れ</h2>
  ${list([
    "お支払い内容の確認が必要な場合は、追加で送金せず、店舗スタッフにこの画面を見せてください。",
    "期限切れの場合は送金せず、店舗スタッフに新しい請求を作成してもらってください。",
    "すでに送金した場合は、二重送金せずスタッフにお声がけください。",
  ])}
</section>`);
}

function internalValidationReport() {
  return page("JPYC決済端末 Internal Validation Report", "internal-validation-report", `
<section>
  <h2>Local validation scope</h2>
  ${list([
    "This report separates local/simulated evidence from real-world external validation.",
    "Real JPYC transfer, public FQDN/TLS, real iOS/Android wallet launch, and real staff drill remain BLOCKED_EXTERNAL_VALIDATION unless timestamped evidence exists.",
    "Secrets, production credentials, real PINs, and private keys must not be embedded in artifacts.",
  ])}
</section>
<section>
  <h2>External blocked checklist</h2>
  ${list([
    "EXT-001 real JPYC payment with tx hash",
    "EXT-002 HashPort/support wallet launch on iOS/Android",
    "EXT-003 public FQDN/TLS/nginx health checks",
    "EXT-004 store ops drill with real operators",
  ])}
</section>`);
}

const scenarios = [
  ["01_store_operator_normal.mp4", "店舗スタッフ: 通常支払い", "請求作成から支払い確認済みまで。判断: 支払い確認済みまで商品を渡さない。"],
  ["02_customer_payment_normal.mp4", "お客様: 通常支払い", "金額・ネットワーク・送金先を確認して支払い、確認済みまで待つ。"],
  ["03_customer_error_patterns.mp4", "お客様: ウォレット不可/期限切れ/無効URL", "送れない時はコピー送金または別決済。期限切れは送金しない。"],
  ["04_review_required_patterns.mp4", "04_confirmation-needed-patterns.mp4", "店舗/管理者: 確認待ち", "過不足・重複・期限後入金は店長確認まで保留。"],
  ["05_full_operation_manual.mp4", "全体: 操作マニュアル", "スタッフ/お客様/管理者の主要導線を通しで確認。"],
];

function trainingIndex() {
  ensureDir(OUT_VIDEO_DIR);
  const normalizedScenarios = scenarios.map((scenario) => {
    if (scenario.length === 4) return scenario;
    const [sourceFile, title, transcript] = scenario;
    return [sourceFile, sourceFile, title, transcript];
  });
  const cards = normalizedScenarios.map(([sourceFile, publicFile, title, transcript]) => {
    const videoPath = path.join(MP4_DIR, sourceFile);
    const publicVideoPath = path.join(OUT_VIDEO_DIR, publicFile);
    const exists = fs.existsSync(videoPath);
    if (exists) {
      fs.copyFileSync(videoPath, publicVideoPath);
    }
    const rel = `videos/${publicFile}`;
    return `<section>
  <h2>${esc(title)}</h2>
  <p>${esc(transcript)}</p>
  ${exists ? `<video controls muted playsinline preload="metadata" src="${esc(rel)}"></video>` : `<div class="card"><strong>BLOCKED_RECORDING_ASSET</strong><p>録画素材がありません。30〜45秒でこのシナリオを収録してください。</p></div>`}
</section>`;
  }).join("\n");
  const placeholders = [
    "店舗キャンセル",
    "不足入金",
    "過入金",
    "重複支払い",
    "期限後入金",
    "返金証跡登録",
    "日次締めブロックと成功",
  ].map((name) => `<div class="card"><h3>${esc(name)}</h3><p><strong>録画チェックリスト:</strong> 状態、商品引渡し判断、次の安全な操作、店長確認の要否を30〜45秒で収録する。</p></div>`).join("\n");
  return page("JPYC決済端末 トレーニング動画インデックス", "training-video-index", `
<section>
  <h2>動画内文字の目視確認</h2>
  <p>動画内文字の最終確認は、<code>video-visual-inspection-checklist.md</code> の完了証跡を確認してください。未記入の場合、MP4の日本語表示は未検収です。</p>
</section>
${cards}
<section>
  <h2>追加収録が必要なシナリオ</h2>
  <div class="grid">${placeholders}</div>
</section>`);
}

function main() {
  ensureDir(OUT_DIR);
  ensureDir(OUT_VIDEO_DIR);
  const outputs = {
    "store-staff-quick-guide.html": storeGuide(),
    "admin-ops-manual.html": adminManual(),
    "customer-help.html": customerHelp(),
    "internal-validation-report.html": internalValidationReport(),
    "training-video-index.html": trainingIndex(),
  };
  for (const [name, html] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(OUT_DIR, name), html, "utf8");
  }
  fs.writeFileSync(
    path.join(OUT_DIR, "video-visual-inspection-checklist.md"),
    `# Video Visual Inspection Checklist

Status: PENDING_HUMAN_REVIEW

動画内文字の最終検収は未完了です。各MP4について、下表を人間が目視で確認し、スクリーンショット証跡パスを記入してください。

| File | Scenario | Duration | Japanese text readable | Tofu/□ visible | Important labels readable | Unsafe staff/customer terms visible | Reviewer | Reviewed at | Screenshot evidence path | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${normalizedScenariosForChecklist().map((row) => `| ${row.publicFile} | ${row.title} | TBD | unchecked | unchecked | unchecked | unchecked |  |  |  |  |`).join("\n")}

Do not mark MP4 visual verification complete until every row is reviewed and screenshot evidence paths are filled.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "artifact-manifest.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), out_dir: OUT_DIR, files: Object.keys(outputs) }, null, 2),
    "utf8"
  );
  console.log(JSON.stringify({ ok: true, out_dir: OUT_DIR, files: Object.keys(outputs) }, null, 2));
}

main();

function normalizedScenariosForChecklist() {
  return scenarios.map((scenario) => {
    if (scenario.length === 4) {
      const [_sourceFile, publicFile, title] = scenario;
      return { publicFile, title };
    }
    const [sourceFile, title] = scenario;
    return { publicFile: sourceFile, title };
  });
}
