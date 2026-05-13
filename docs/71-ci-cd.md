# 71. CI/CD

## Goal
PR と main / release tag 時点で、Docker / deploy を含む実証直前品質ゲートを継続実行する。

## Workflow
- `.github/workflows/ci.yml`
- `validate` job
  - `npm ci`
  - `npm run check`
  - `npm test`
  - `npm run audit`
  - `npm run test:audit-chain`
  - `npm run deploy:check`
  - サーバー起動 + `npm run test:smoke`
  - `docker build .`
  - `docker compose -f docker-compose.prod.yml config`
- `production-validation-evidence` job
  - `npm run production:validate`
  - `docs/production/evidence/<timestamp>` を artifact 保存
  - artifact は repo/deploy validation 証跡であり、実機・実送金・公開TLS の GO 証跡そのものではない

## Post-run verification
- GitHub Actions 実行後は `npm run ci:verify:github -- --repo <owner>/<repo> --workflow ci.yml` で run / job / artifact を検証する
- token や repo 解決を事前確認したい時は `--dry-run` を使う
- 必要環境変数:
  - `GITHUB_TOKEN` または `GH_TOKEN`
  - `GITHUB_REPOSITORY` もしくは `--repo`
- `gh auth token` が利用可能なら token fallback として使う
- push 実行では以下を success とみなす
  - `validate` job
  - `production-validation-evidence` job
  - `production-validation-evidence-*` artifact

## Verify UX
- repo 未指定時は `--repo owner/name` / `GITHUB_REPOSITORY` / git remote origin のどれが必要かを明示する
- token 未設定時は `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth login` のどれで解消するかを明示する
- summary には workflow run URL と artifact URL を含める

## Constraints
- CI secret はテスト専用固定値のみ。
- 本番秘密値を使わない。
- `.env.production` は example をコピーした安全値で compose 検証だけ行う。
- smoke fail 時はサーバーログを job log に出して原因追跡しやすくする。

## Done when
- pull_request と main push / release tag push でCIが自動実行される。
- Docker が無いローカルでも GitHub Actions 上で build / compose config が継続検証される。
- main / release tag では production validation evidence artifact を取得できる。
