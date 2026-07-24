# Production Evidence Directory

実運用の検証証跡は、Git追跡対象外の `docs/production/evidence/<timestamp>/` にUTCタイムスタンプ単位で保存する。

## Directory convention

- `docs/production/evidence/<timestamp>/SUMMARY.md`
- `docs/production/evidence/<timestamp>/*.log`
- `docs/production/evidence/<timestamp>/*.json`
- `docs/production/evidence/<timestamp>/deploy-logs/`

## Minimum contents

- `check`, `test`, `audit`, `smoke`, `audit-chain`
- `deploy:check`
- `validate-public-invoice-api`
- `validate-wallet-launch`
- `validate-smoke-payment-flow`
- `validate-production-config`
- `validate-dependency-docker-hygiene`
- `validate-evidence-sanitization`
- backup / restore drill
- system info (`git-commit`, `node-version`, `npm-version`, `os`, `env-keys`)
- 実機証跡を残す場合は `device-validation/`
- 外部依存テンプレートを使う場合は `EXT-001-*.md` 〜 `EXT-004-*.md`
- 商用KPIテンプレートを使う場合は `POC-001.md` 〜 `POC-003.md`

テンプレートの追跡可能な正本は `docs/production-evidence-templates/` に置く。生成後の証跡や秘密情報を含み得る実行結果は、この正本ディレクトリへ書き戻さない。

## Device validation helper

- `npm run evidence:device:prepare`
- 出力先:
  - `docs/production/evidence/<timestamp>/device-validation/README.md`
  - `docs/production/evidence/<timestamp>/device-validation/screenshots/`
  - `docs/production/evidence/<timestamp>/device-validation/videos/`

## External validation helper

- `npm run evidence:external:prepare`
- 出力先:
  - `docs/production/evidence/<timestamp>/EXT-001-real-jpyc-payment.md`
  - `docs/production/evidence/<timestamp>/EXT-002-wallet-device-launch.md`
  - `docs/production/evidence/<timestamp>/EXT-003-public-fqdn-tls.md`
  - `docs/production/evidence/<timestamp>/EXT-004-store-ops-drill.md`
  - `docs/production/evidence/<timestamp>/POC-001.md`
  - `docs/production/evidence/<timestamp>/POC-002.md`
  - `docs/production/evidence/<timestamp>/POC-003.md`

## Rule

- 未実行項目は `PASS` と書かない。
- 実機・実JPYCが必要な項目は `BLOCKED_EXTERNAL_VALIDATION.md` とセットで管理する。
- 実運用証跡、秘密値、秘密鍵、署名権限をGitへコミットしない。
