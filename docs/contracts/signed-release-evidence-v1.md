# Signed Release Evidence Contract v1

現行の machine verdict は `NO_GO`、`LIMITED_PILOT_GO`、`COMMERCIAL_GO_10` の3つだけです。draft、署名欠落、未知 verdict、期限切れ、取消、別 release、意味上 fail の証拠はすべて `NO_GO` です。

## Binding order

1. `release_manifest_v1` は commit、source、lockfile、migration、Node 24.17.0、image digest、environment、DB/backup/audit root、evidence/approval manifest hash、mode、trust policy を結合する。
2. release authority は repository 外で管理する Ed25519 private key で canonical payload を署名する。private key を本アプリ、環境変数、evidence bundleへ置かない。
3. `commercial_evidence_manifest_v1` は EXT-001..004、POC-001..003、PERF-001 の各内容 hash と同じ release fingerprint を結合する。
4. `commercial_approval_manifest_v1` は legal、AML、privacy、APPI、JPYC contract、confirmation、backscan、refund treasury を同じ release fingerprintへ結合する。limited mode は署名済み `limited_pilot_cap` も必要とする。
5. release manifest 内の `trust_policy`、deploy環境の trusted public key set、signer registry の三者すべてで許可された key/roleだけが有効。いずれかの取消リストにあるkeyは無効。
6. release authority、evidence verifier、legal、AML、privacy、APPI、technology、operations はそれぞれ別の `key_id` を使う。accountable role 間の鍵共有、release/evidence/approval 領域間の鍵共有、同一署名の role 転用は拒否する。
7. approval record は `approval_id`ごとに固定された `approver_role` と `approver_key_id` を持ち、その鍵が実際に当該 role で manifest を有効に署名し、release trust policy にも登録されていることを要求する。
8. `RELEASE_ENVIRONMENT_ID` は実行環境で必須とし、release、evidence、approval の全 fingerprint の `environment_id` と一致しない場合は別環境の証拠流用として拒否する。

## Safe generation and signing

1. `docs/production-evidence-templates/*.DRAFT.json` を作業用の新規ディレクトリへコピーする。template は `revocation_status: draft`、空署名なので gate を通らない。
2. release fingerprint、実測 evidence、承認文書、全 artifact hash、`issued_at`、短い `expires_at` を埋める。
3. `node scripts/production-validation/render-manifest-signing-payload.mjs --manifest <manifest.json> --output <payload.bin>` で署名対象を生成する。このスクリプトはprivate keyを読まない。
4. 隔離された承認者側環境で Ed25519 署名し、`algorithm=ed25519`、`encoding=base64`、公開鍵SHA-256の`key_id`、`signer_role`、公開鍵、署名をmanifestへ追加する。
   `signature_base64` は64-byte Ed25519署名の canonical Base64のみとし、前後空白、改行、過剰padding、非canonical pad-bitを拒否する。approval record には当該 role の署名鍵 `approver_key_id` を記録する。
5. release manifest は最後に作成し、署名済み evidence/approval manifest の最終ファイル hash を取り込んでから署名する。署名済みファイルを上書きせず、新しい release ID を発行する。
6. trusted public key、signer registry、revocation list はdeploy時に安全な設定経路から注入し、private keyは注入しない。
7. `issued_at < expires_at` を必須とし、有効期間の上限はrelease 24時間、evidence 7日、approval manifest/record 90日、許容clock skewは60秒とする。遠い将来日を無期限承認の代用にしない。

## Acceptance

- limited: signed capの全最大値以下のdeploy設定、期間内、全必須 evidence/approval/performance gate、`LIMITED_PILOT_GO`。
- commercial:全必須 gate、real payment/device/TLS/store drill/POC/PERF、`COMMERCIAL_GO_MODE=true`、`COMMERCIAL_GO_10`。
- 欠落、未知、別release、hash不一致、semantic fail、expired/revoked/untrusted key、role不足、blocker 1件以上は常に `NO_GO`。

過去の evidence artifact は履歴であり、現行契約に合わせて遡及編集しません。
