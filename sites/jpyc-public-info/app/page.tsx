import Link from 'next/link';

const safetyChecks = [
  ['ネットワーク', 'Polygon（chain ID 137）'],
  ['トークン', 'JPYC（公式コントラクトを店舗端末で照合）'],
  ['支払い方法', '店舗端末に表示されたQRをウォレットで直接読み取る'],
  ['返金', '自動実行ではなく、確認・審査・承認後に外部ウォレットで対応'],
];

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main">本文へ移動</a>
      <div className="critical-banner" role="alert">
        <strong>このSiteから送金しないでください。</strong>
        <span>支払いは、店頭のMac端末に表示されたQRからのみ行います。</span>
      </div>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="JPYC 店頭決済案内 トップへ">
          <span className="brand-mark" aria-hidden="true">J</span>
          <span><strong>JPYC 店頭決済案内</strong><small>安全な支払い前確認</small></span>
        </Link>
        <nav aria-label="主要ナビゲーション">
          <Link href="/payment-guide">支払い方法</Link>
          <Link href="/security">安全対策</Link>
          <Link href="/faq">FAQ</Link>
          <Link href="/terms">規約</Link>
        </nav>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="eyebrow">NON-CUSTODIAL / POLYGON / JPYC</div>
          <h1 id="hero-title">店頭のQRを読み取り、<br />4項目を照合してから送金</h1>
          <p className="hero-copy">このSiteは一般案内とポリシーの確認専用です。請求金額、受取アドレス、支払いQR、ウォレット起動リンクは表示しません。</p>
          <div className="hero-actions">
            <Link className="button primary" href="/payment-guide">安全な支払い手順を見る</Link>
            <Link className="button secondary" href="/security">誤送金を防ぐ確認事項</Link>
          </div>
          <p className="microcopy">店舗スタッフが秘密鍵・シードフレーズ・ウォレットの復元情報を聞くことはありません。</p>
        </section>

        <section className="check-section" aria-labelledby="check-title">
          <div className="section-heading">
            <span>BEFORE YOU PAY</span>
            <h2 id="check-title">支払い前の4点確認</h2>
            <p>1つでも一致しない場合は送金せず、店舗スタッフへ確認してください。</p>
          </div>
          <div className="check-grid">
            {safetyChecks.map(([label, value], index) => (
              <article className="check-card" key={label}>
                <span className="step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <h3>{label}</h3>
                <p>{value}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="boundary-section" aria-labelledby="boundary-title">
          <div>
            <span className="pill safe">非カストディ</span>
            <h2 id="boundary-title">お客様の資産や鍵を預かりません</h2>
            <p>本サービスは、店舗の請求作成と入金確認、審査・返金証跡・精算・監査を支援します。お客様の秘密鍵を保管せず、サーバーが送金や返金を自動署名することもありません。</p>
          </div>
          <ul className="boundary-list">
            <li><strong>Site</strong><span>案内・規約・安全情報のみ</span></li>
            <li><strong>店舗端末</strong><span>請求、QR、入金確認、運用記録</span></li>
            <li><strong>お客様</strong><span>ご自身のウォレットで内容を確認して署名</span></li>
          </ul>
        </section>

        <section className="policy-links" aria-labelledby="policy-title">
          <div className="section-heading">
            <span>POLICIES & SUPPORT</span>
            <h2 id="policy-title">支払い前に確認する文書</h2>
          </div>
          <div className="link-grid">
            <Link href="/terms"><strong>利用規約</strong><span>サービスの利用条件と責任範囲</span></Link>
            <Link href="/privacy"><strong>プライバシー</strong><span>記録される情報と取扱方針</span></Link>
            <Link href="/refund-policy"><strong>返金ポリシー</strong><span>返金の確認・審査・承認手順</span></Link>
            <Link href="/contact"><strong>問い合わせ</strong><span>安全な問い合わせ方法</span></Link>
          </div>
        </section>
      </main>

      <footer>
        <div><strong>JPYC 店頭決済案内</strong><p>店舗端末のQRからのみ支払うための公開情報Site</p></div>
        <nav aria-label="フッターナビゲーション">
          <Link href="/privacy">プライバシー</Link>
          <Link href="/refund-policy">返金</Link>
          <Link href="/version">バージョン</Link>
          <Link href="/contact">問い合わせ</Link>
        </nav>
      </footer>
    </>
  );
}
