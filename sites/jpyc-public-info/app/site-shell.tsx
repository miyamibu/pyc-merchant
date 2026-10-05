import Link from 'next/link';
import type { ReactNode } from 'react';

export function SiteHeader() {
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
          <a href="/terms">規約</a>
        </nav>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer>
      <div><strong>JPYC 店頭決済案内</strong><p>店舗端末のQRからのみ支払うための公開情報Site</p></div>
      <nav aria-label="フッターナビゲーション">
        <a href="/privacy">プライバシー</a>
        <a href="/refund-policy">返金</a>
        <Link href="/version">バージョン</Link>
        <Link href="/contact">問い合わせ</Link>
      </nav>
    </footer>
  );
}

export function DocumentShell({ eyebrow, title, summary, children }: { eyebrow: string; title: string; summary: string; children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="document-main">
        <header className="document-hero">
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{summary}</p>
          <dl className="document-meta">
            <div><dt>文書ID</dt><dd>JPYC-PUBLIC-INFO-20260826</dd></div>
            <div><dt>版</dt><dd>1.0</dd></div>
            <div><dt>改定日</dt><dd>2026年8月26日</dd></div>
            <div><dt>対象</dt><dd>Polygon上のJPYC店頭支払い</dd></div>
          </dl>
        </header>
        <div className="document-layout">
          <aside className="document-notice" aria-label="重要な前提">
            <strong>重要</strong>
            <p>このSiteは一般案内専用です。請求、送金先、金額、支払いQR、個別の取引履歴は提供しません。</p>
            <Link href="/payment-guide">支払い手順を確認</Link>
          </aside>
          <article className="document-body">{children}</article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
