import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'JPYC 店頭決済案内',
    template: '%s | JPYC 店頭決済案内',
  },
  description: '店舗端末のQRから安全にJPYCを支払うための一般案内、利用規約、プライバシー、返金方針。',
  robots: { index: true, follow: true },
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>{children}</body>
    </html>
  );
}
