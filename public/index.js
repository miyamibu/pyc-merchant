const query = new URLSearchParams(location.search);
const motionMediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  amountDigits: "",
  status: "idle",
  demoEnabled: false,
  demoScenario: "success",
  offline: false,
};

const motionState = {
  sceneIndex: 0,
  phaseIndex: 0,
  timer: null,
  playing: !motionMediaQuery.matches,
};

const el = {
  amountPreview: document.getElementById("amountPreview"),
  amountPreviewSub: document.getElementById("amountPreviewSub"),
  prototypeStatus: document.getElementById("prototypeStatus"),
  prototypeStateLabel: document.getElementById("prototypeStateLabel"),
  prototypeStateDetail: document.getElementById("prototypeStateDetail"),
  prototypeLive: document.getElementById("prototypeLive"),
  createQrBtn: document.getElementById("createQrBtn"),
  clearAmountBtn: document.getElementById("clearAmountBtn"),
  demoModeBadge: document.getElementById("demoModeBadge"),
  demoControlsSection: document.getElementById("demoControlsSection"),
  demoGuardNote: document.getElementById("demoGuardNote"),
  demoStatusText: document.getElementById("demoStatusText"),
  demoDetectBtn: document.getElementById("demoDetectBtn"),
  demoSuccessBtn: document.getElementById("demoSuccessBtn"),
  demoShortageBtn: document.getElementById("demoShortageBtn"),
  demoOverBtn: document.getElementById("demoOverBtn"),
  demoDuplicateBtn: document.getElementById("demoDuplicateBtn"),
  demoLateArrivalBtn: document.getElementById("demoLateArrivalBtn"),
  demoOfflineBtn: document.getElementById("demoOfflineBtn"),
  demoFastForwardBtn: document.getElementById("demoFastForwardBtn"),
  keys: Array.from(document.querySelectorAll("[data-key]")),
  presetButtons: Array.from(document.querySelectorAll("[data-prototype-preset]")),
  motionCanvas: document.getElementById("motionCanvas"),
  motionScenarioBadge: document.getElementById("motionScenarioBadge"),
  motionPauseBtn: document.getElementById("motionPauseBtn"),
  motionSceneSummary: document.getElementById("motionSceneSummary"),
  motionSceneTitle: document.getElementById("motionSceneTitle"),
  motionSceneBody: document.getElementById("motionSceneBody"),
  motionTerminalStatus: document.getElementById("motionTerminalStatus"),
  motionTerminalAmount: document.getElementById("motionTerminalAmount"),
  motionTerminalAmountSub: document.getElementById("motionTerminalAmountSub"),
  motionTerminalInvoice: document.getElementById("motionTerminalInvoice"),
  motionTerminalAction: document.getElementById("motionTerminalAction"),
  motionTerminalTrace: document.getElementById("motionTerminalTrace"),
  motionTerminalTitle: document.getElementById("motionTerminalTitle"),
  motionTerminalList: document.getElementById("motionTerminalList"),
  motionTransferBadge: document.getElementById("motionTransferBadge"),
  motionBeamText: document.getElementById("motionBeamText"),
  motionMobileStatus: document.getElementById("motionMobileStatus"),
  motionMobileTitle: document.getElementById("motionMobileTitle"),
  motionMobileBody: document.getElementById("motionMobileBody"),
  motionMobileCta: document.getElementById("motionMobileCta"),
  motionMobileList: document.getElementById("motionMobileList"),
  motionPhaseTrack: document.getElementById("motionPhaseTrack"),
  motionReviewCard: document.getElementById("motionReviewCard"),
  motionReviewTitle: document.getElementById("motionReviewTitle"),
  motionReviewBody: document.getElementById("motionReviewBody"),
  motionRefundCard: document.getElementById("motionRefundCard"),
  motionRefundTitle: document.getElementById("motionRefundTitle"),
  motionRefundBody: document.getElementById("motionRefundBody"),
  motionSettlementCard: document.getElementById("motionSettlementCard"),
  motionSettlementTitle: document.getElementById("motionSettlementTitle"),
  motionSettlementBody: document.getElementById("motionSettlementBody"),
  motionSceneButtons: Array.from(document.querySelectorAll("[data-motion-scene-trigger]")),
  motionActiveStepPill: document.getElementById("motionActiveStepPill"),
  motionNarrativeList: document.getElementById("motionNarrativeList"),
  motionAuditText: document.getElementById("motionAuditText"),
  motionLive: document.getElementById("motionLive"),
};

function toJpy(value) {
  return `¥${Number(value || 0).toLocaleString("ja-JP")}`;
}

function toJpyc(value) {
  return `${Number(value || 0).toLocaleString("ja-JP")} JPYC`;
}

function announce(message) {
  el.prototypeLive.textContent = message || "";
}

function announceMotion(message) {
  if (!el.motionLive) return;
  el.motionLive.textContent = message || "";
}

const MOTION_SCENES = [
  {
    id: "success",
    label: "通常会計",
    badgeClass: "s-green",
    summary: "請求作成から支払い確認、日次締め候補化までの基本フローです。",
    body: "JPYC で払えた後に店舗が困らないよう、端末 UI・顧客 UI・settlement export が同じ流れでつながります。",
    phases: [
      {
        label: "請求作成",
        hint: "QR を提示して送金待ちへ",
        canvasTone: "default",
        flowActive: false,
        terminalStatus: ["支払い待ち", "s-blue"],
        terminalAmount: "¥3,000",
        terminalAmountSub: "3,000 JPYC",
        terminalInvoice: "INV-20260422-001",
        terminalAction: "QR提示",
        terminalTrace: "export_reference 待ち",
        terminalTitle: "QRを提示して、お客様の送金を待っています",
        terminalList: [
          "invoice-first で会計を起点にし、支払い後の分岐も同じ請求単位で追います。",
          "non-custodial 前提なので、端末側で秘密鍵や署名権限は持ちません。",
        ],
        transferBadge: "QR提示中",
        beamText: "受取 QR を読み取り、お客様ウォレット側で送金を始める段階です。",
        mobileStatus: ["支払い待ち", "s-blue"],
        mobileTitle: "ウォレットを開いて、送金内容を確認",
        mobileBody: "お客様のウォレットから直接送金するため、秘密鍵やシードフレーズの入力はありません。",
        mobileCta: "ウォレットで支払う",
        mobileList: [
          "金額と送金先を確認してから送金します。",
          "送金後はこの画面の自動更新を待つだけです。",
        ],
        review: {
          tone: "idle",
          title: "例外なし",
          body: "通常会計では review queue はまだ未使用です。",
        },
        refund: {
          tone: "idle",
          title: "返金なし",
          body: "返金証跡は必要なときだけ作成します。",
        },
        settlement: {
          tone: "active",
          title: "締め待ち",
          body: "paid になると export_reference 候補として日次締めへ集約されます。",
        },
        narrative: [
          "請求単位で trace を持つので、現場では『誰の何の支払いか』を見失いません。",
          "顧客画面と端末画面で次の行動が一致しているため、少人数運用でも詰まりにくい設計です。",
        ],
        audit: "invoice / checkout session / payment attempt の trace を維持したまま進みます。",
      },
      {
        label: "送金検知",
        hint: "payment detected から confirming へ",
        canvasTone: "default",
        flowActive: true,
        terminalStatus: ["確認中", "s-blue"],
        terminalAmount: "¥3,000",
        terminalAmountSub: "3,000 JPYC",
        terminalInvoice: "INV-20260422-001",
        terminalAction: "待機",
        terminalTrace: "payment evidence 検知",
        terminalTitle: "入金を検知し、二重送信を止めながら確認中です",
        terminalList: [
          "SSE / polling fallback で自動更新し、スタッフが張り付かなくても状態を追えます。",
          "この段階では『追加送金しない』ことを明確に案内します。",
        ],
        transferBadge: "JPYC送金",
        beamText: "お客様ウォレットから直接送金され、端末側は receipt と transfer evidence を待ちます。",
        mobileStatus: ["確認中", "s-blue"],
        mobileTitle: "送金は受け付け済みです。このままお待ちください",
        mobileBody: "重複送金を避けるため、追加操作はせずそのまま待機します。",
        mobileCta: "確認中",
        mobileList: [
          "追加送金は不要です。",
          "完了までこの画面の自動更新を待ちます。",
        ],
        review: {
          tone: "idle",
          title: "例外なし",
          body: "期待額どおりなら review queue に上げず、そのまま完了へ進みます。",
        },
        refund: {
          tone: "idle",
          title: "返金なし",
          body: "返金記録は発生していません。",
        },
        settlement: {
          tone: "active",
          title: "締め候補を準備中",
          body: "確定後に export_reference へ紐づく候補として集計待ちに入ります。",
        },
        narrative: [
          "支払い検知後の文言を端末と顧客でそろえ、現場で二重案内が起きないようにします。",
          "支払い後オペレーションを UI で先回りするのが Merchant Ops の差分です。",
        ],
        audit: "payment evidence を軸に、invoice と status change が同じ文脈で残ります。",
      },
      {
        label: "支払い確認",
        hint: "paid になり次会計へ戻る",
        canvasTone: "default",
        flowActive: false,
        terminalStatus: ["支払い完了", "s-green"],
        terminalAmount: "¥3,000",
        terminalAmountSub: "3,000 JPYC",
        terminalInvoice: "INV-20260422-001",
        terminalAction: "次の会計",
        terminalTrace: "payment_event confirmed",
        terminalTitle: "支払いを確認しました。次の会計へ進めます",
        terminalList: [
          "完了をすぐ把握できるので、現場オペレーションが止まりません。",
          "支払い証跡はそのまま締め処理と監査ログに引き継がれます。",
        ],
        transferBadge: "照合完了",
        beamText: "送金と確認が完了し、この請求は完了済みとして扱えます。",
        mobileStatus: ["支払い確認済み", "s-green"],
        mobileTitle: "支払いを確認しました",
        mobileBody: "追加送金は不要です。必要ならこの画面をスタッフに見せるだけで十分です。",
        mobileCta: "完了",
        mobileList: [
          "請求 ID と取引番号で照合できます。",
          "店舗側の案内に従って会計を終えます。",
        ],
        review: {
          tone: "idle",
          title: "review 不要",
          body: "例外がなければそのまま完了扱いです。",
        },
        refund: {
          tone: "idle",
          title: "返金なし",
          body: "返金フローへ分岐していません。",
        },
        settlement: {
          tone: "active",
          title: "締め候補に追加",
          body: "daily close 時に export_reference へ集約する準備が整いました。",
        },
        narrative: [
          "決済完了だけで終わらず、日次締めまで見越した状態にそのまま入ります。",
          "端末側は完了、顧客側は安心、会計側は trace 維持という三層を同時に成立させます。",
        ],
        audit: "paid 状態と payment evidence が settlement export の前提データになります。",
      },
      {
        label: "日次締め",
        hint: "export_reference 付きで確定",
        canvasTone: "settled",
        flowActive: false,
        terminalStatus: ["確定済み", "s-green"],
        terminalAmount: "¥3,000",
        terminalAmountSub: "3,000 JPYC",
        terminalInvoice: "INV-20260422-001",
        terminalAction: "次の営業へ",
        terminalTrace: "settlement-2026-04-22.csv",
        terminalTitle: "日次締めに取り込まれ、export_reference まで確定しました",
        terminalList: [
          "generic CSV / JSON を source of truth にし、下流 adapter はここから変換します。",
          "invoice / payment / review / refund / audit を export_reference からたどれます。",
        ],
        transferBadge: "export 済み",
        beamText: "支払い後運用まで一貫してつながり、accounting export の起点になります。",
        mobileStatus: ["確定済み", "s-green"],
        mobileTitle: "処理は完了しています",
        mobileBody: "顧客側の追加操作は不要です。店舗側では締め証跡と監査証跡が残ります。",
        mobileCta: "完了済み",
        mobileList: [
          "この取引は settlement export に含まれます。",
          "後続 adapter は contract v1 を変えずに変換します。",
        ],
        review: {
          tone: "success",
          title: "review 0件",
          body: "未解決例外なしで締め対象へ進みました。",
        },
        refund: {
          tone: "idle",
          title: "返金なし",
          body: "返金証跡は発生していません。",
        },
        settlement: {
          tone: "success",
          title: "export_reference 発行済み",
          body: "settlement-2026-04-22.csv / settlement-export-v1.json へ同じ意味で出力されます。",
        },
        narrative: [
          "ここで初めて accounting adapter に渡せる、安定した versioned contract になります。",
          "Merchant Ops の強みは『払えた』ではなく『払われた後まで説明できる』ことです。",
        ],
        audit: "export_reference から settlement / invoice / payment / audit を逆引きできます。",
      },
    ],
  },
  {
    id: "review",
    label: "過入金レビュー",
    badgeClass: "s-yellow",
    summary: "過入金を review queue に分岐し、返金証跡まで追えるフローです。",
    body: "例外を決済後に処理できることが、このプロダクトの実運用価値です。review / refund evidence を UI で迷わず扱えます。",
    phases: [
      {
        label: "請求作成",
        hint: "会計は 3,000 円で開始",
        canvasTone: "default",
        flowActive: false,
        terminalStatus: ["支払い待ち", "s-blue"],
        terminalAmount: "¥3,000",
        terminalAmountSub: "3,000 JPYC",
        terminalInvoice: "INV-20260422-019",
        terminalAction: "QR提示",
        terminalTrace: "review watch",
        terminalTitle: "通常会計として請求を発行し、送金を待っています",
        terminalList: [
          "この時点では通常会計と同じ見た目で進みます。",
          "差分が出た瞬間だけ review queue に分岐する前提です。",
        ],
        transferBadge: "QR提示中",
        beamText: "見た目は通常会計でも、後段で差分検知に備えています。",
        mobileStatus: ["支払い待ち", "s-blue"],
        mobileTitle: "案内どおり送金を開始",
        mobileBody: "顧客側は通常の支払い体験のまま送金します。",
        mobileCta: "ウォレットで支払う",
        mobileList: [
          "顧客体験を壊さず、例外処理は店舗側に寄せます。",
          "必要な差分検知はサーバー側 ledger で行います。",
        ],
        review: {
          tone: "idle",
          title: "review 未発生",
          body: "この時点では例外は上がっていません。",
        },
        refund: {
          tone: "idle",
          title: "返金未判断",
          body: "過不足が確定するまで返金候補は作りません。",
        },
        settlement: {
          tone: "active",
          title: "締め候補待ち",
          body: "正常ならそのまま締めへ進む予定です。",
        },
        narrative: [
          "例外が起きるまでは通常会計と同じ速さで回せるようにしています。",
          "差分を先に UI で恐れず、発生時だけ review queue へ上げる設計です。",
        ],
        audit: "通常会計と同じ invoice lineage を保ったまま例外待機します。",
      },
      {
        label: "差分検知",
        hint: "期待額との差分を検知",
        canvasTone: "alert",
        flowActive: true,
        terminalStatus: ["確認中", "s-blue"],
        terminalAmount: "¥3,000",
        terminalAmountSub: "期待 3,000 / 着金 5,000 JPYC",
        terminalInvoice: "INV-20260422-019",
        terminalAction: "差分確認",
        terminalTrace: "payment +2,000 detected",
        terminalTitle: "期待額との差分を検知し、例外処理へ分岐する準備中です",
        terminalList: [
          "過入金はその場で捨てず、review queue へ確実に引き継ぎます。",
          "端末側では顧客に追加送金を案内せず、そのまま待ってもらいます。",
        ],
        transferBadge: "過入金検知",
        beamText: "5,000 JPYC を検知し、期待額 3,000 JPYC との差分を記録しています。",
        mobileStatus: ["確認中", "s-blue"],
        mobileTitle: "送金は受け付け済みです。店舗側で確認中です",
        mobileBody: "顧客には通常どおり待ってもらい、例外判定は店舗側で処理します。",
        mobileCta: "確認中",
        mobileList: [
          "顧客側の追加操作は不要です。",
          "不足・過入金の判定はサーバー側 ledger が行います。",
        ],
        review: {
          tone: "active",
          title: "差分検知中",
          body: "review queue 候補として差分金額と payment evidence をまとめています。",
        },
        refund: {
          tone: "idle",
          title: "返金候補を算出中",
          body: "まずは差額と reason code を確定します。",
        },
        settlement: {
          tone: "blocked",
          title: "締め保留",
          body: "例外が解決するまで settlement export へ流し込みません。",
        },
        narrative: [
          "ここで決済後例外を早く検知できると、現場では『なぜ止まっているか』を説明できます。",
          "支払い受付と review 対応を切り分けることで、レジ側の混乱を減らします。",
        ],
        audit: "reason code 候補と差分金額を evidence と一緒に残します。",
      },
      {
        label: "review queue",
        hint: "要確認として管理者へ",
        canvasTone: "alert",
        flowActive: false,
        terminalStatus: ["確認が必要", "s-yellow"],
        terminalAmount: "¥3,000",
        terminalAmountSub: "差額 +2,000 JPYC",
        terminalInvoice: "INV-20260422-019",
        terminalAction: "レビュー対応",
        terminalTrace: "RVW-20260422-014",
        terminalTitle: "過入金として review queue に引き継ぎ、差額返金の要否を判断します",
        terminalList: [
          "review queue で reason code と候補返金額を確認します。",
          "顧客には『店舗側で確認する』だけを案内し、現場での過剰説明を避けます。",
        ],
        transferBadge: "review 分岐",
        beamText: "支払い証跡は保持したまま、通常フローから review queue へ安全に分岐します。",
        mobileStatus: ["確認が必要", "s-yellow"],
        mobileTitle: "店舗スタッフへお声がけください",
        mobileBody: "支払い内容の確認が必要です。追加送金は行わず、そのまま待機してください。",
        mobileCta: "要確認",
        mobileList: [
          "review queue で店舗側が状況を確認します。",
          "請求 ID と取引番号をそのまま提示できます。",
        ],
        review: {
          tone: "alert",
          title: "過入金 2,000 JPYC",
          body: "reason_code=OVERPAYMENT と payment evidence を同時に保持します。",
        },
        refund: {
          tone: "active",
          title: "差額返金候補あり",
          body: "suggested refund amount と refund_to_address の確認へ進みます。",
        },
        settlement: {
          tone: "blocked",
          title: "未解決 review のため保留",
          body: "contract v1 では review 未解決のまま adapter semantics を変えません。",
        },
        narrative: [
          "決済後の例外を『決済失敗』にせず、『要確認の運用』として扱えるのが Merchant Ops の核心です。",
          "review ID が起点になるので、返金・締め・監査まで同じ番号で追いやすくなります。",
        ],
        audit: "review_case_id と payment evidence が export trace に残ります。",
      },
      {
        label: "返金証跡",
        hint: "refund evidence を記録",
        canvasTone: "alert",
        flowActive: false,
        terminalStatus: ["確認が必要", "s-yellow"],
        terminalAmount: "¥3,000",
        terminalAmountSub: "返金候補 2,000 JPYC",
        terminalInvoice: "INV-20260422-019",
        terminalAction: "返金証跡登録",
        terminalTrace: "RFD-20260422-018",
        terminalTitle: "返金申請・承認・verify 用の証跡を作成し、外部送金結果を待ちます",
        terminalList: [
          "返金そのものは外部ウォレットで実行し、システムは tx hash と verify 結果を記録します。",
          "二名承認と audit evidence を残し、non-custodial 境界を越えません。",
        ],
        transferBadge: "refund evidence",
        beamText: "返金実行そのものは外部で行い、ここでは証跡と verify 結果を追跡します。",
        mobileStatus: ["確認が必要", "s-yellow"],
        mobileTitle: "店舗側で返金確認を進めています",
        mobileBody: "顧客体験はここで止め、返金証跡は店舗側の運用画面だけで管理します。",
        mobileCta: "店舗確認中",
        mobileList: [
          "送金署名はシステムでは行いません。",
          "返金の判断と証跡を切り分けて残します。",
        ],
        review: {
          tone: "active",
          title: "review 進行中",
          body: "差額確認と refund case を紐づけて運用します。",
        },
        refund: {
          tone: "alert",
          title: "refund evidence 記録済み",
          body: "request / approve / execute / verify の各段階を tx hash と actor 分離で追えます。",
        },
        settlement: {
          tone: "blocked",
          title: "解決完了まで保留",
          body: "返金 verify を待ってから settlement export の文脈へ戻します。",
        },
        narrative: [
          "返金を『機能』ではなく『証跡付き運用』として見せることで、実装境界が明確になります。",
          "ここでも source of truth は server-side ledger で、外部送金結果は verify で取り込みます。",
        ],
        audit: "refund request / approval / verify を payment trace にぶら下げて保持します。",
      },
    ],
  },
  {
    id: "late",
    label: "期限後着金",
    badgeClass: "s-red",
    summary: "期限切れ後の着金を旧請求レビューに残しつつ、新しい QR を再発行するフローです。",
    body: "小規模店舗で起こりやすい late payment を、その場の案内と audit trace の両方を崩さず処理できます。",
    phases: [
      {
        label: "請求作成",
        hint: "短い TTL で発行",
        canvasTone: "default",
        flowActive: false,
        terminalStatus: ["支払い待ち", "s-blue"],
        terminalAmount: "¥1,000",
        terminalAmountSub: "1,000 JPYC",
        terminalInvoice: "INV-20260422-032",
        terminalAction: "QR提示",
        terminalTrace: "ttl 02:00",
        terminalTitle: "イベント会計として短い期限の QR を提示しています",
        terminalList: [
          "ポップアップやイベントでは短めの期限付き請求が扱いやすいことがあります。",
          "期限後の送金も想定し、expired から review へ逃がせる構造にしておきます。",
        ],
        transferBadge: "短期 QR",
        beamText: "短い TTL の請求を発行し、現場回転を優先しています。",
        mobileStatus: ["支払い待ち", "s-blue"],
        mobileTitle: "案内どおり送金を進めてください",
        mobileBody: "期限表示を見ながら、時間内の送金を案内します。",
        mobileCta: "ウォレットで支払う",
        mobileList: [
          "残り時間を見て送金します。",
          "期限切れ後は店舗スタッフへ確認します。",
        ],
        review: {
          tone: "idle",
          title: "review 未発生",
          body: "期限内なら通常会計として完了できます。",
        },
        refund: {
          tone: "idle",
          title: "返金なし",
          body: "この時点では返金要否はありません。",
        },
        settlement: {
          tone: "active",
          title: "締め候補待ち",
          body: "期限内完了なら通常どおり daily close へ進みます。",
        },
        narrative: [
          "短い期限の請求でも、期限後着金を事故にしないことが重要です。",
          "late payment を先に設計しておくと、実証現場での運用詰まりが減ります。",
        ],
        audit: "expired 前の invoice 状態をそのまま保持します。",
      },
      {
        label: "期限切れ",
        hint: "old invoice は expired",
        canvasTone: "alert",
        flowActive: false,
        terminalStatus: ["期限切れ", "s-red"],
        terminalAmount: "¥1,000",
        terminalAmountSub: "expired invoice",
        terminalInvoice: "INV-20260422-032",
        terminalAction: "再発行判断",
        terminalTrace: "old QR invalid",
        terminalTitle: "期限切れになったため、この QR は再利用せず新しい請求を発行します",
        terminalList: [
          "expired -> paid にはせず、旧請求は期限切れのまま残します。",
          "現場では新しい QR を再発行する判断に集中できます。",
        ],
        transferBadge: "期限切れ",
        beamText: "旧 QR は無効になり、新しい請求発行が必要な状態です。",
        mobileStatus: ["期限切れ", "s-red"],
        mobileTitle: "この請求は期限切れです",
        mobileBody: "古い QR では支払えません。店舗スタッフに再発行を依頼してください。",
        mobileCta: "再発行待ち",
        mobileList: [
          "旧請求への送金は行いません。",
          "新しい QR を受け取るまでは待機します。",
        ],
        review: {
          tone: "idle",
          title: "旧請求は expired",
          body: "まだ着金がなければ review queue へは上げません。",
        },
        refund: {
          tone: "idle",
          title: "返金なし",
          body: "支払いが発生していなければ refund evidence は不要です。",
        },
        settlement: {
          tone: "blocked",
          title: "締め対象外",
          body: "expired のままでは settlement export に入りません。",
        },
        narrative: [
          "期限切れを曖昧にせず status として残すことで、後から説明できる状態になります。",
          "ここで old QR を消さず、無効として保持するのが auditability の基本です。",
        ],
        audit: "expired 状態を hard delete せず保持することで late payment を説明できます。",
      },
      {
        label: "期限後着金",
        hint: "late payment を review へ",
        canvasTone: "alert",
        flowActive: true,
        terminalStatus: ["確認が必要", "s-yellow"],
        terminalAmount: "¥1,000",
        terminalAmountSub: "late payment detected",
        terminalInvoice: "INV-20260422-032",
        terminalAction: "旧請求レビュー",
        terminalTrace: "RVW-20260422-021",
        terminalTitle: "期限後の着金を検知したため、旧請求は review queue で確認します",
        terminalList: [
          "expired を paid に巻き戻さず、late payment として review queue に分岐します。",
          "その場では新規会計を止めず、旧請求の確認だけを別レーンで処理できます。",
        ],
        transferBadge: "期限後着金",
        beamText: "期限切れ後の送金も payment evidence として記録し、old invoice の review に紐づけます。",
        mobileStatus: ["確認が必要", "s-yellow"],
        mobileTitle: "店舗スタッフへお声がけください",
        mobileBody: "旧請求の期限後着金として確認が必要です。追加送金はしないでください。",
        mobileCta: "要確認",
        mobileList: [
          "late payment は店舗側で判断します。",
          "必要なら新しい請求を再発行します。",
        ],
        review: {
          tone: "alert",
          title: "期限後着金 review",
          body: "reason_code=LATE_PAYMENT と old invoice の status lineage を同時に保持します。",
        },
        refund: {
          tone: "active",
          title: "返金 / 充当判断待ち",
          body: "旧請求へ返金するか、新規請求へ再案内するかを運用で決めます。",
        },
        settlement: {
          tone: "blocked",
          title: "旧請求は保留",
          body: "late payment の判断が終わるまで export_reference へ流しません。",
        },
        narrative: [
          "late payment を UI 上で明示すると、スタッフは『今やるべきこと』を迷いません。",
          "old invoice を残したまま new invoice を発行できるので、現場回転と監査性を両立できます。",
        ],
        audit: "old invoice / late payment evidence / review case の 3 点を同時に追えます。",
      },
      {
        label: "QR再発行",
        hint: "new invoice で会計再開",
        canvasTone: "default",
        flowActive: false,
        terminalStatus: ["支払い待ち", "s-blue"],
        terminalAmount: "¥1,000",
        terminalAmountSub: "new invoice ready",
        terminalInvoice: "INV-20260422-033",
        terminalAction: "新QR提示",
        terminalTrace: "old invoice linked",
        terminalTitle: "新しい請求を再発行し、旧請求の review を残したまま会計を再開します",
        terminalList: [
          "reissue しても old invoice の late payment trace は失われません。",
          "現場では新しい QR を提示し直すだけで運用を前に進められます。",
        ],
        transferBadge: "再発行済み",
        beamText: "旧請求の review を保持したまま、新しい QR で会計フローを再開しています。",
        mobileStatus: ["支払い待ち", "s-blue"],
        mobileTitle: "新しい QR で支払いを続けてください",
        mobileBody: "旧請求とは切り離した新しい請求として、再度送金を案内します。",
        mobileCta: "新しい QR で支払う",
        mobileList: [
          "旧請求は review queue 側で確認されます。",
          "新しい請求 ID でふたたび通常フローへ入れます。",
        ],
        review: {
          tone: "alert",
          title: "old invoice review 継続",
          body: "late payment の検証はそのまま残り、新規会計には影響させません。",
        },
        refund: {
          tone: "active",
          title: "個別判断レーン",
          body: "旧請求の返金 / 充当判断を separate flow で処理します。",
        },
        settlement: {
          tone: "active",
          title: "new invoice は通常候補",
          body: "新規請求は通常どおり paid / settled へ進めます。",
        },
        narrative: [
          "現場オペレーションは new invoice、監査性は old invoice review で保つ二層構造です。",
          "この分岐があると、イベント現場でも会計を止めずに late payment を吸収できます。",
        ],
        audit: "reissue lineage を残すことで、old invoice と new invoice の関係を説明できます。",
      },
    ],
  },
  {
    id: "settlement",
    label: "日次締め",
    badgeClass: "s-green",
    summary: "paid 済み取引を export_reference 付きで日次締めへまとめるフローです。",
    body: "Generic CSV / JSON を source of truth にして downstream adapter へ渡す、accounting trace の中心部分を見せています。",
    phases: [
      {
        label: "締め準備",
        hint: "paid 済み取引を集計",
        canvasTone: "default",
        flowActive: false,
        terminalStatus: ["支払い完了", "s-green"],
        terminalAmount: "¥12,500",
        terminalAmountSub: "5 invoices / 12,500 JPYC",
        terminalInvoice: "BATCH-20260422",
        terminalAction: "締め準備",
        terminalTrace: "paid invoices=5",
        terminalTitle: "paid 済み取引を集計し、daily close に入る準備をしています",
        terminalList: [
          "settlement export は server-side ledger を source of truth にして生成します。",
          "adapter ごとの差分はこの後段で変換し、契約意味はここで固定します。",
        ],
        transferBadge: "集計中",
        beamText: "支払い後の証跡を横断して集計し、日次締めの対象を固めています。",
        mobileStatus: ["支払い確認済み", "s-green"],
        mobileTitle: "顧客側の操作は完了済みです",
        mobileBody: "締め処理は店舗側だけで進み、顧客 UI に追加操作はありません。",
        mobileCta: "完了",
        mobileList: [
          "顧客フローを止めずに、店舗側で accounting trace を処理します。",
          "顧客 UI は完了表示のまま維持されます。",
        ],
        review: {
          tone: "active",
          title: "未解決 review を確認",
          body: "settlement 前に unresolved review の件数と理由を確認します。",
        },
        refund: {
          tone: "active",
          title: "refund verify 状態を確認",
          body: "refund evidence が pending のものは verify 状態を確認します。",
        },
        settlement: {
          tone: "active",
          title: "集計準備中",
          body: "business_date 単位で export 候補をまとめています。",
        },
        narrative: [
          "ここでは individual payment よりも『今日の運用をどう閉じるか』が主役になります。",
          "review / refund を飛ばさずに締めることで、後続 adapter でも意味が崩れません。",
        ],
        audit: "paid invoices と unresolved review count を同じ締めコンテキストで保持します。",
      },
      {
        label: "保留確認",
        hint: "unresolved review を判定",
        canvasTone: "alert",
        flowActive: false,
        terminalStatus: ["確認中", "s-blue"],
        terminalAmount: "¥12,500",
        terminalAmountSub: "review 1件 / refund 1件",
        terminalInvoice: "BATCH-20260422",
        terminalAction: "保留確認",
        terminalTrace: "review block check",
        terminalTitle: "未解決 review と refund verify を確認し、締め可否を判定しています",
        terminalList: [
          "未解決 review が block policy の場合は settlement export を先に出しません。",
          "便利だからといって ledger semantics を adapter 側で変えないための確認です。",
        ],
        transferBadge: "gate check",
        beamText: "日次締め前に unresolved review / refund verify を確認し、export contract を守ります。",
        mobileStatus: ["支払い確認済み", "s-green"],
        mobileTitle: "顧客体験は完了のままです",
        mobileBody: "締め前の確認は店舗側運用なので、顧客 UI にはノイズを増やしません。",
        mobileCta: "完了",
        mobileList: [
          "支払い完了表示を壊さず、店舗側だけで accounting guardrail を回します。",
          "review / refund の判断は別レーンで管理します。",
        ],
        review: {
          tone: "alert",
          title: "review block policy",
          body: "未解決 review がある場合、settlement export はその意味を隠さず block します。",
        },
        refund: {
          tone: "active",
          title: "refund verify 待ち",
          body: "verify 未完了の返金は pending のまま trace を残します。",
        },
        settlement: {
          tone: "blocked",
          title: "guardrail 判定中",
          body: "contract v1 の意味を守るため、未解決項目は export 前に可視化します。",
        },
        narrative: [
          "締め前に review / refund を数えることで、『数字は合うが意味が違う』状態を防ぎます。",
          "この guardrail があるから vendor-specific sync を後付けしても semantics が崩れません。",
        ],
        audit: "review block と refund pending を export 前 evidence として残します。",
      },
      {
        label: "export 生成",
        hint: "CSV / JSON contract v1",
        canvasTone: "settled",
        flowActive: false,
        terminalStatus: ["確定済み", "s-green"],
        terminalAmount: "¥12,500",
        terminalAmountSub: "export ready",
        terminalInvoice: "BATCH-20260422",
        terminalAction: "CSV / JSON 出力",
        terminalTrace: "settlement-2026-04-22.csv",
        terminalTitle: "Settlement Export Contract v1 に沿って CSV / JSON を生成しました",
        terminalList: [
          "export_reference を起点に settlement / invoice / payment / review / refund / audit をたどれます。",
          "freee / マネーフォワード / 弥生 / direct API sync はここからの downstream adapter です。",
        ],
        transferBadge: "contract v1",
        beamText: "adapter-agnostic な settlement export を生成し、外部連携はここから変換します。",
        mobileStatus: ["確定済み", "s-green"],
        mobileTitle: "店舗側で締め処理が完了しました",
        mobileBody: "顧客側の見え方は変えずに、店舗側で accounting export まで完了しています。",
        mobileCta: "完了済み",
        mobileList: [
          "支払い完了 UI はそのまま、店舗側で締め証跡だけを追加します。",
          "accounting export の成否は顧客 UI の source of truth になりません。",
        ],
        review: {
          tone: "success",
          title: "review を含めて集約",
          body: "未解決件数や理由も export 文脈で説明できる状態です。",
        },
        refund: {
          tone: "success",
          title: "refund trace 維持",
          body: "返金証跡も settlement export と同じ trace 上に残ります。",
        },
        settlement: {
          tone: "success",
          title: "export_reference 発行済み",
          body: "settlement-2026-04-22.csv / settlement-export-v1.json を正本として扱います。",
        },
        narrative: [
          "generic contract が source of truth なので、adapter は『変換者』であって『意味の定義者』ではありません。",
          "これは accounting sync を後から増やしても現場 semantics を崩さないための土台です。",
        ],
        audit: "export_reference を軸に internal ledger semantics を固定します。",
      },
      {
        label: "adapter 連携",
        hint: "下流 sync へ handoff",
        canvasTone: "settled",
        flowActive: false,
        terminalStatus: ["確定済み", "s-green"],
        terminalAmount: "¥12,500",
        terminalAmountSub: "adapter handoff",
        terminalInvoice: "BATCH-20260422",
        terminalAction: "adapter 連携",
        terminalTrace: "sync status tracked",
        terminalTitle: "下流 adapter へ handoff しつつ、内部 trace は contract v1 のまま保持します",
        terminalList: [
          "external system name / external reference / retry count / last error も trace に含めます。",
          "vendor output を source of truth にせず、internal ledger semantics を優先します。",
        ],
        transferBadge: "downstream sync",
        beamText: "adapter は contract v1 を変えずに vendor-specific 形式へ変換し、sync trace を追加します。",
        mobileStatus: ["確定済み", "s-green"],
        mobileTitle: "顧客側では処理完了のままです",
        mobileBody: "external sync が後から走っても、顧客 UI や支払い状態の意味は変わりません。",
        mobileCta: "完了済み",
        mobileList: [
          "adapter 結果は内部 ledger と切り分けて保持します。",
          "外部 sync の失敗も item-level evidence として追跡します。",
        ],
        review: {
          tone: "success",
          title: "review semantics 維持",
          body: "外部 sync へ出しても manual review の意味を隠しません。",
        },
        refund: {
          tone: "success",
          title: "refund trace 維持",
          body: "返金証跡も external sync reference と併記して保持します。",
        },
        settlement: {
          tone: "success",
          title: "sync trace 追加",
          body: "status / external system / retry / last error を settlement export の外側に追加記録します。",
        },
        narrative: [
          "ここまで来ても source of truth は server-side ledger です。vendor output は説明責任の補助に過ぎません。",
          "UI でこの境界を見せることで、non-custodial と accounting trace の両方が伝わります。",
        ],
        audit: "external sync reference も internal trace にぶら下げて保持します。",
      },
    ],
  },
];

function setStatus(status, detail = "") {
  state.status = status;
  const labelMap = {
    idle: ["未発行", "s-gray", "まず金額を入力して請求を作成してください"],
    pending: ["支払い待ち", "s-yellow", "お客様に QR を提示し、状態更新を待ちます。"],
    confirming: ["確認中", "s-blue", "入金を確認中です。重複送金を避けて待機します。"],
    paid: ["支払い完了", "s-green", "支払いを確認しました。次の会計へ進めます。"],
    review: ["確認が必要", "s-yellow", "要確認として review queue に引き継いでください。"],
    expired: ["期限切れ", "s-red", "この請求は期限切れです。新しいQRを発行してください。"],
    offline: ["状態未確認", "s-red", "通信状態を確認できません。再接続後に運用状態を確認してください。"],
  };
  const [pillLabel, pillClass, title] = labelMap[status] || labelMap.idle;
  el.prototypeStatus.textContent = pillLabel;
  el.prototypeStatus.className = `status-pill ${pillClass}`;
  el.prototypeStateLabel.textContent = title;
  el.prototypeStateDetail.textContent = detail || "";
  announce(`状態が ${pillLabel} に更新されました`);
}

function renderAmount() {
  const amount = Number(state.amountDigits || 0);
  el.amountPreview.textContent = toJpy(amount);
  el.amountPreviewSub.textContent = toJpyc(amount);
}

function onKeyInput(key) {
  if (key === "clear") {
    state.amountDigits = "";
  } else if (key === "back") {
    state.amountDigits = state.amountDigits.slice(0, -1);
  } else {
    const next = (state.amountDigits + key).replace(/^0+(?=\d)/, "");
    state.amountDigits = next.slice(0, 9);
  }
  renderAmount();
}

function applyPresetAmount(amount) {
  const numeric = String(amount || "").replace(/[^\d]/g, "");
  if (!numeric) return;
  state.amountDigits = numeric.slice(0, 9);
  renderAmount();
  announce(`デモ金額を ${toJpy(Number(state.amountDigits || 0))} に設定しました`);
}

function setDemoScenario(value, label) {
  state.demoScenario = value;
  el.demoStatusText.textContent = `シナリオ: ${label}`;
}

function detectPayment() {
  if (!state.demoEnabled) return;
  if (state.status !== "pending") {
    setStatus("review", "支払い待ち状態でのみ入金検知デモを実行できます。");
    return;
  }
  setStatus("confirming", "入金検知を受け付けました。");
  setTimeout(() => {
    if (state.demoScenario === "success") {
      setStatus("paid", "次の会計へ進んでください。");
      return;
    }
    if (state.demoScenario === "shortage") {
      setStatus("review", "金額不足のため確認待ちです。");
      return;
    }
    if (state.demoScenario === "overpay") {
      setStatus("review", "過入金のため返金判断が必要です。");
      return;
    }
    if (state.demoScenario === "duplicate") {
      setStatus("review", "重複支払いの確認が必要です。");
      return;
    }
    if (state.demoScenario === "late_arrival") {
      setStatus("review", "期限切れ後の着金として確認待ちです。");
      return;
    }
    setStatus("review", "確認待ちの状態に移行しました。");
  }, 900);
}

function issueQr() {
  const amount = Number(state.amountDigits || 0);
  if (amount <= 0) {
    setStatus("idle", "0円では請求を作成できません。");
    return;
  }
  if (state.offline) {
    setStatus("offline", "オフライン中はQRを作成できません。");
    return;
  }
  setStatus("pending", "支払い後は完了 / 要確認に自動で振り分けられます。");
}

function resetAmount() {
  state.amountDigits = "";
  renderAmount();
  setStatus("idle", "金額を入力して請求を作成してください。");
}

function setPill(node, label, className) {
  if (!node) return;
  node.textContent = label;
  node.className = `status-pill ${className}`;
}

function setText(node, value) {
  if (!node) return;
  node.textContent = value;
}

function renderList(host, items) {
  if (!host) return;
  host.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    host.appendChild(li);
  }
}

function renderOpsCard(card, titleNode, bodyNode, payload) {
  if (!card) return;
  card.dataset.tone = payload.tone;
  titleNode.textContent = payload.title;
  bodyNode.textContent = payload.body;
}

function renderMotionPhaseTrack(scene, activeIndex) {
  if (!el.motionPhaseTrack) return;
  el.motionPhaseTrack.innerHTML = "";
  scene.phases.forEach((phase, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "motion-phase";
    if (index === activeIndex) button.classList.add("is-active");
    if (index < activeIndex) button.classList.add("is-complete");
    button.dataset.motionPhaseIndex = String(index);

    const step = document.createElement("span");
    step.className = "motion-phase-step";
    step.textContent = `0${index + 1}`;

    const label = document.createElement("span");
    label.className = "motion-phase-label";
    label.textContent = phase.label;

    const hint = document.createElement("span");
    hint.className = "motion-phase-hint";
    hint.textContent = phase.hint;

    button.append(step, label, hint);
    el.motionPhaseTrack.appendChild(button);
  });
}

function syncMotionButtons(sceneId) {
  for (const button of el.motionSceneButtons) {
    button.classList.toggle("is-active", button.dataset.motionSceneTrigger === sceneId);
  }
}

function syncMotionPauseButton() {
  if (!el.motionPauseBtn) return;
  el.motionPauseBtn.textContent = motionState.playing ? "一時停止" : "再生する";
  el.motionPauseBtn.setAttribute("aria-pressed", motionState.playing ? "true" : "false");
}

function renderMotionScene(announceScene = false) {
  const scene = MOTION_SCENES[motionState.sceneIndex];
  const phase = scene.phases[motionState.phaseIndex];

  setText(el.motionSceneSummary, scene.summary);
  setText(el.motionSceneTitle, scene.label);
  setText(el.motionSceneBody, scene.body);
  setPill(el.motionScenarioBadge, scene.label, scene.badgeClass);

  if (el.motionCanvas) {
    el.motionCanvas.dataset.motionScene = scene.id;
    el.motionCanvas.dataset.motionPhase = phase.label;
    el.motionCanvas.classList.toggle("is-flowing", phase.flowActive === true);
    el.motionCanvas.classList.toggle("is-alert", phase.canvasTone === "alert");
    el.motionCanvas.classList.toggle("is-settled", phase.canvasTone === "settled");
  }

  setPill(el.motionTerminalStatus, phase.terminalStatus[0], phase.terminalStatus[1]);
  setText(el.motionTerminalAmount, phase.terminalAmount);
  setText(el.motionTerminalAmountSub, phase.terminalAmountSub);
  setText(el.motionTerminalInvoice, phase.terminalInvoice);
  setText(el.motionTerminalAction, phase.terminalAction);
  setText(el.motionTerminalTrace, phase.terminalTrace);
  setText(el.motionTerminalTitle, phase.terminalTitle);
  renderList(el.motionTerminalList, phase.terminalList);

  setText(el.motionTransferBadge, phase.transferBadge);
  setText(el.motionBeamText, phase.beamText);

  setPill(el.motionMobileStatus, phase.mobileStatus[0], phase.mobileStatus[1]);
  setText(el.motionMobileTitle, phase.mobileTitle);
  setText(el.motionMobileBody, phase.mobileBody);
  setText(el.motionMobileCta, phase.mobileCta);
  renderList(el.motionMobileList, phase.mobileList);

  renderOpsCard(el.motionReviewCard, el.motionReviewTitle, el.motionReviewBody, phase.review);
  renderOpsCard(el.motionRefundCard, el.motionRefundTitle, el.motionRefundBody, phase.refund);
  renderOpsCard(el.motionSettlementCard, el.motionSettlementTitle, el.motionSettlementBody, phase.settlement);

  renderMotionPhaseTrack(scene, motionState.phaseIndex);
  syncMotionButtons(scene.id);
  setText(el.motionActiveStepPill, `phase ${motionState.phaseIndex + 1} / ${scene.phases.length}`);
  renderList(el.motionNarrativeList, phase.narrative);
  setText(el.motionAuditText, phase.audit);
  syncMotionPauseButton();

  if (announceScene) {
    announceMotion(`${scene.label} の ${phase.label} を表示中です`);
  }
}

function stopMotionTimer() {
  if (!motionState.timer) return;
  clearTimeout(motionState.timer);
  motionState.timer = null;
}

function scheduleMotionAdvance() {
  stopMotionTimer();
  if (!motionState.playing || !el.motionCanvas) return;
  motionState.timer = setTimeout(() => {
    const scene = MOTION_SCENES[motionState.sceneIndex];
    if (motionState.phaseIndex < scene.phases.length - 1) {
      motionState.phaseIndex += 1;
    } else {
      motionState.sceneIndex = (motionState.sceneIndex + 1) % MOTION_SCENES.length;
      motionState.phaseIndex = 0;
    }
    renderMotionScene(false);
    scheduleMotionAdvance();
  }, 2400);
}

function jumpToMotionScene(sceneId) {
  const index = MOTION_SCENES.findIndex((scene) => scene.id === sceneId);
  if (index < 0) return;
  motionState.sceneIndex = index;
  motionState.phaseIndex = 0;
  renderMotionScene(true);
  scheduleMotionAdvance();
}

function jumpToMotionPhase(index) {
  const scene = MOTION_SCENES[motionState.sceneIndex];
  const nextIndex = Number(index);
  if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= scene.phases.length) return;
  motionState.phaseIndex = nextIndex;
  renderMotionScene(true);
  scheduleMotionAdvance();
}

function toggleMotionPlayback() {
  motionState.playing = !motionState.playing;
  syncMotionPauseButton();
  if (motionState.playing) {
    announceMotion("アニメーションの自動再生を再開しました");
    scheduleMotionAdvance();
  } else {
    announceMotion("アニメーションの自動再生を一時停止しました");
    stopMotionTimer();
  }
}

function bindMotionEvents() {
  if (!el.motionCanvas) return;

  el.motionPauseBtn.addEventListener("click", toggleMotionPlayback);
  for (const button of el.motionSceneButtons) {
    button.addEventListener("click", () => jumpToMotionScene(String(button.dataset.motionSceneTrigger || "")));
  }
  el.motionPhaseTrack.addEventListener("click", (event) => {
    const target = event.target.closest("[data-motion-phase-index]");
    if (!target) return;
    jumpToMotionPhase(target.dataset.motionPhaseIndex);
  });
}

function initMotionShowcase() {
  if (!el.motionCanvas) return;
  bindMotionEvents();
  renderMotionScene(true);
  scheduleMotionAdvance();
}

async function loadRuntimeConfig() {
  try {
    const res = await fetch("/api/v1/public/config", { method: "GET" });
    if (!res.ok) throw new Error("config fetch failed");
    const payload = await res.json();
    return {
      prototype_demo_enabled: payload.prototype_demo_enabled === true,
    };
  } catch (_error) {
    return {
      prototype_demo_enabled: false,
    };
  }
}

function guardDemoControls(config) {
  const allowByQuery = query.get("demo") === "1";
  const allowByFlag = config.prototype_demo_enabled === true;
  state.demoEnabled = allowByQuery && allowByFlag;

  if (!state.demoEnabled) {
    if (el.demoControlsSection) {
      el.demoControlsSection.remove();
    }
    return;
  }
  el.demoModeBadge.classList.remove("hidden");
  el.demoControlsSection.classList.remove("hidden");
  el.demoGuardNote.textContent =
    "demo=1 かつ公開プロトタイプ機能が有効な環境でのみ表示されます。";
}

function bindBaseEvents() {
  for (const keyButton of el.keys) {
    keyButton.addEventListener("click", () => onKeyInput(String(keyButton.dataset.key || "")));
  }
  for (const presetButton of el.presetButtons) {
    presetButton.addEventListener("click", () => applyPresetAmount(presetButton.dataset.prototypePreset || ""));
  }
  el.createQrBtn.addEventListener("click", issueQr);
  el.clearAmountBtn.addEventListener("click", resetAmount);
}

function bindDemoEvents() {
  if (!state.demoEnabled) return;
  el.demoDetectBtn.addEventListener("click", detectPayment);
  el.demoSuccessBtn.addEventListener("click", () => setDemoScenario("success", "成功"));
  el.demoShortageBtn.addEventListener("click", () => setDemoScenario("shortage", "金額不足"));
  el.demoOverBtn.addEventListener("click", () => setDemoScenario("overpay", "過入金"));
  el.demoDuplicateBtn.addEventListener("click", () => setDemoScenario("duplicate", "重複"));
  el.demoLateArrivalBtn.addEventListener("click", () => setDemoScenario("late_arrival", "期限切れ後着金"));
  el.demoOfflineBtn.addEventListener("click", () => {
    state.offline = !state.offline;
    el.demoOfflineBtn.textContent = state.offline ? "オンラインに戻す" : "オフライン切替";
    if (state.offline) {
      setStatus("offline", "オフライン中です。");
    } else {
      setStatus("idle", "オンラインに戻りました。");
    }
  });
  el.demoFastForwardBtn.addEventListener("click", () => {
    if (state.status !== "pending") {
      setStatus("review", "支払い待ち状態でのみタイマー早送りを実行できます。");
      return;
    }
    setStatus("expired", "タイマーを早送りしました。");
  });
}

async function init() {
  bindBaseEvents();
  initMotionShowcase();
  const config = await loadRuntimeConfig();
  guardDemoControls(config);
  bindDemoEvents();
  renderAmount();
  setStatus("idle", "金額を入力して請求を作成してください。");
}

void init();
