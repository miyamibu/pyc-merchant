# Japanese Font And Capture Preflight

## Goal
操作マニュアル、研修動画インデックス、スクリーンショット、動画フレームで日本語が tofu glyph (`□` / `�`) にならないようにする。

## Context
店舗スタッフ向け資料は日本語表示が読めないだけで運用事故につながる。public page と生成成果物は共通して日本語フォントスタックを使い、キャプチャ前にフォント読み込み完了を待つ。

## Constraints
- production page は runtime CDN script に依存しない。
- フォント導入は capture/CI 環境に限定し、アプリのノンカストディ境界や本番設定を変更しない。
- 既存のOSフォントで十分な macOS では追加導入を必須にしない。

## Required Font Stack

```css
font-family:
  "Noto Sans JP",
  "Noto Sans CJK JP",
  "Hiragino Sans",
  "Yu Gothic",
  "Meiryo",
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  sans-serif;
```

## Capture Environment

- macOS: `Hiragino Sans` / `Yu Gothic` が利用できるため通常は追加不要。
- Linux: `fonts-noto-cjk` または同等の CJK フォントを入れる。
- CI/Docker: 画像/動画生成を行うジョブだけに CJK フォントパッケージを追加する。

## Browser Capture Rule

HTMLからスクリーンショット/動画フレームを作る場合は、次を満たしてから capture する。

```js
await document.fonts.ready;
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
```

## Done when
- `public/app.css` と生成HTMLが required font stack を含む。
- 生成成果物に `□` / `�` がない。
- `tests/operator-os-language.test.mjs` が tofu glyph を検出したら失敗する。

## Validation method
- `npm test -- tests/operator-os-language.test.mjs`
- 生成成果物をブラウザで開いて日本語見出しを確認する。

## Failure-handling behavior
- tofu glyph が出た場合、キャプチャを完了扱いにしない。
- Linux/CIでは `fonts-noto-cjk` の導入手順を evidence に残す。
