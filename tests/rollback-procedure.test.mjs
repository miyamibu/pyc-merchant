import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const SCRIPTS = path.join(ROOT, "scripts", "deploy");

function withTempRepo(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jpyc-rollback-"));
  const bin = path.join(tmp, "bin");
  const scripts = path.join(tmp, "scripts", "deploy");
  const runtime = path.join(tmp, "runtime", "deploy");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });

  fs.copyFileSync(path.join(SCRIPTS, "release-history.mjs"), path.join(scripts, "release-history.mjs"));
  fs.copyFileSync(path.join(SCRIPTS, "release-history.sh"), path.join(scripts, "release-history.sh"));
  fs.copyFileSync(path.join(SCRIPTS, "rollback.sh"), path.join(scripts, "rollback.sh"));

  const callLog = path.join(tmp, "call-log.jsonl");

  const stub = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };

  const scriptStub = (name, body) => {
    const p = path.join(scripts, name);
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };

  const systemctlCounterFile = path.join(tmp, "systemctl-counter");

  stub("systemctl", `echo "systemctl \$@" >> "${callLog}"
    if [[ "\$1" = "restart" && "\$2" = "jpyc-payment-terminal.service" ]]; then
      if [[ -n "\${SYSTEMCTL_FAIL_ALL:-}" ]]; then
        exit 1
      fi
      if [[ -n "\${SYSTEMCTL_FAIL_FIRST:-}" ]]; then
        if [[ ! -f "\${SYSTEMCTL_COUNTER_FILE}" ]]; then
          echo 0 > "\${SYSTEMCTL_COUNTER_FILE}"
        fi
        count=\$(cat "\${SYSTEMCTL_COUNTER_FILE}")
        if [[ \$count -eq 0 ]]; then
          echo 1 > "\${SYSTEMCTL_COUNTER_FILE}"
          exit 1
        fi
      fi
    fi
    exit 0
  `);
  stub("sleep", `echo "sleep \$@" >> "${callLog}"`);
  scriptStub("backup-sqlite.sh", `echo "backup-sqlite.sh \$@" >> "${callLog}"
    if [[ -n "\${BACKUP_FAIL:-}" ]]; then
      exit 1
    fi
    exit 0
  `);
  scriptStub("healthcheck.sh", `echo "healthcheck.sh \$@" >> "${callLog}"
    if [[ -n "\${HEALTHCHECK_ALWAYS_FAIL:-}" ]]; then
      exit 1
    fi
    exit 0
  `);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALL_LOG: callLog,
    SYSTEMCTL_COUNTER_FILE: systemctlCounterFile,
    NODE_BIN: process.execPath,
  };

  const run = (script, args, extraEnv = {}) => {
    const child = spawnSync("bash", [script, ...args], {
      cwd: tmp,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
    if (child.error) throw child.error;
    return { stdout: child.stdout, stderr: child.stderr, status: child.status };
  };

  const readLog = () => {
    if (!fs.existsSync(callLog)) return [];
    return fs.readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
  };

  const readHistory = () => {
    const hp = path.join(runtime, "release-history.jsonl");
    if (!fs.existsSync(hp)) return [];
    return fs.readFileSync(hp, "utf8").trim().split("\n").filter(Boolean);
  };

  const seedHistory = (releaseId, commit, digest, environment, schema) => {
    const hist = path.join(scripts, "release-history.sh");
    const r = run(hist, ["record", releaseId, commit, digest, environment, schema]);
    assert.equal(r.status, 0, `seed record ${releaseId} failed: stdout=${r.stdout} stderr=${r.stderr}`);
  };

  fn({ tmp, bin, scripts, runtime, run, readLog, readHistory, env, seedHistory, systemctlCounterFile });
}

const COMMIT_1 = "a".repeat(40);
const COMMIT_2 = "b".repeat(40);
const DIGEST_1 = "registry.invalid/jpyc-terminal@sha256:" + "1".repeat(64);
const DIGEST_2 = "registry.invalid/jpyc-terminal@sha256:" + "2".repeat(64);

test("M-047 release-history canonical record idempotency/conflict/current/previous/find/list/validate", () => {
  withTempRepo(({ scripts, run, readHistory }) => {
    const hist = path.join(scripts, "release-history.sh");

    const r1 = run(hist, ["record", "rel-1", COMMIT_1, DIGEST_1, "commercial", "3"]);
    assert.equal(r1.status, 0, `record rel-1 failed: stdout=${r1.stdout} stderr=${r1.stderr}`);

    const r2 = run(hist, ["record", "rel-2", COMMIT_2, DIGEST_2, "commercial", "3"]);
    assert.equal(r2.status, 0, `record rel-2 failed: stdout=${r2.stdout} stderr=${r2.stderr}`);

    const r3 = run(hist, ["record", "rel-2", COMMIT_2, DIGEST_2, "commercial", "3"]);
    assert.equal(r3.status, 0, `idempotent record rel-2 failed: stdout=${r3.stdout} stderr=${r3.stderr}`);

    const lines = readHistory();
    assert.equal(lines.length, 2);
    const rec1 = JSON.parse(lines[0]);
    const rec2 = JSON.parse(lines[1]);
    assert.equal(rec1.release_id, "rel-1");
    assert.equal(rec1.commit, COMMIT_1);
    assert.equal(rec1.image_digest, DIGEST_1);
    assert.equal(rec1.environment, "commercial");
    assert.equal(rec1.db_schema_version, "3");
    assert.equal(rec2.release_id, "rel-2");
    assert.equal(rec2.commit, COMMIT_2);
    assert.equal(rec2.image_digest, DIGEST_2);
    assert.equal(rec2.environment, "commercial");
    assert.equal(rec2.db_schema_version, "3");

    const find1 = run(hist, ["find", "rel-1"]);
    assert.equal(find1.status, 0, `find rel-1 failed: stdout=${find1.stdout} stderr=${find1.stderr}`);
    assert.match(find1.stdout, /"release_id":"rel-1"/);

    const find2 = run(hist, ["find", "rel-2"]);
    assert.equal(find2.status, 0, `find rel-2 failed: stdout=${find2.stdout} stderr=${find2.stderr}`);
    assert.match(find2.stdout, /"release_id":"rel-2"/);

    const cur = run(hist, ["current"]);
    assert.equal(cur.status, 0, `current failed: stdout=${cur.stdout} stderr=${cur.stderr}`);
    assert.match(cur.stdout, /"release_id":"rel-2"/);

    const prev = run(hist, ["previous"]);
    assert.equal(prev.status, 0, `previous failed: stdout=${prev.stdout} stderr=${prev.stderr}`);
    assert.match(prev.stdout, /"release_id":"rel-1"/);

    const list = run(hist, ["list"]);
    assert.equal(list.status, 0, `list failed: stdout=${list.stdout} stderr=${list.stderr}`);
    assert.match(list.stdout, /rel-1/);
    assert.match(list.stdout, /rel-2/);

    const val = run(hist, ["validate"]);
    assert.equal(val.status, 0, `validate failed: stdout=${val.stdout} stderr=${val.stderr}`);
  });
});

test("M-047 release-history rejects conflicting same release_id with different digest", () => {
  withTempRepo(({ scripts, run, readHistory }) => {
    const hist = path.join(scripts, "release-history.sh");

    const r1 = run(hist, ["record", "rel-1", COMMIT_1, DIGEST_1, "commercial", "3"]);
    assert.equal(r1.status, 0, `record rel-1 failed: stdout=${r1.stdout} stderr=${r1.stderr}`);

    const r2 = run(hist, ["record", "rel-1", COMMIT_1, DIGEST_2, "commercial", "3"]);
    assert.equal(r2.status, 1, `conflicting record should fail: stdout=${r2.stdout} stderr=${r2.stderr}`);
    assert.match(r2.stderr, /conflicting release_id in history/);

    const lines = readHistory();
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.release_id, "rel-1");
    assert.equal(rec.image_digest, DIGEST_1);
  });
});

test("M-047 release-history image_digest validation accepts valid OCI and rejects invalid", () => {
  withTempRepo(({ scripts, run }) => {
    const hist = path.join(scripts, "release-history.sh");

    const valid = [
      "registry.invalid/jpyc-terminal@sha256:" + "a".repeat(64),
      "registry.invalid:5000/jpyc-terminal@sha256:" + "b".repeat(64),
      "registry.invalid/ns/jpyc-terminal@sha256:" + "c".repeat(64),
      "jpyc-terminal@sha256:" + "d".repeat(64),
      "my.registry.com/path/to/image@sha256:" + "e".repeat(64),
    ];

    for (let i = 0; i < valid.length; i++) {
      const digest = valid[i];
      const releaseId = "rel-valid-" + i;
      const r = run(hist, ["record", releaseId, COMMIT_1, digest, "commercial", "3"]);
      assert.equal(r.status, 0, `valid digest ${digest} should pass: stdout=${r.stdout} stderr=${r.stderr}`);
    }

    const invalid = [
      "REGISTRY.INVALID/jpyc-terminal@sha256:" + "a".repeat(64),
      "registry.invalid/jpyc-terminal@sha256:" + "A".repeat(64),
      "https://registry.invalid/jpyc-terminal@sha256:" + "a".repeat(64),
      "registry.invalid/jpyc-terminal:latest",
      "registry.invalid//jpyc-terminal@sha256:" + "a".repeat(64),
      "registry.invalid/../jpyc-terminal@sha256:" + "a".repeat(64),
      "registry.invalid/jpyc-terminal@sha256:" + "a".repeat(63),
      "registry.invalid/jpyc-terminal@sha256:" + "a".repeat(65),
    ];

    for (let i = 0; i < invalid.length; i++) {
      const digest = invalid[i];
      const releaseId = "rel-invalid-" + i;
      const r = run(hist, ["record", releaseId, COMMIT_1, digest, "commercial", "3"]);
      assert.equal(r.status, 1, `invalid digest ${digest} should fail: stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /invalid image_digest format/);
    }
  });
});

test("M-047 rollback plan selects previous release, prints service, leaves env/history/log/lock unchanged", () => {
  withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory }) => {
    const hist = path.join(scripts, "release-history.sh");
    const rollback = path.join(scripts, "rollback.sh");

    run(hist, ["record", "rel-1", COMMIT_1, DIGEST_1, "commercial", "3"]);
    run(hist, ["record", "rel-2", COMMIT_2, DIGEST_2, "commercial", "3"]);

    const envFile = path.join(tmp, ".env.test");
    const envContent = `APP_IMAGE_REF=${DIGEST_2}
RELEASE_ID=rel-2
KEEP=value
`;
    fs.writeFileSync(envFile, envContent, { mode: 0o600 });

    const beforeEnvBytes = fs.readFileSync(envFile);
    const beforeEnvMode = fs.statSync(envFile).mode & 0o777;
    const beforeHistory = readHistory();
    const beforeLog = readLog();
    const lockPath = envFile + ".rollback-lock";
    const beforeLockExists = fs.existsSync(lockPath);

    assert.equal(beforeLockExists, false, "lock file should not exist before rollback");

    const out = run(rollback, [envFile]);

    assert.equal(out.status, 0, `plan mode failed: stdout=${out.stdout} stderr=${out.stderr}`);
    assert.match(out.stdout, /target\s+:\s+rel-1/);
    assert.match(out.stdout, /jpyc-payment-terminal\.service/);

    const afterEnvBytes = fs.readFileSync(envFile);
    assert.deepEqual(afterEnvBytes, beforeEnvBytes, "env file bytes must be unchanged in plan mode");

    const afterEnvMode = fs.statSync(envFile).mode & 0o777;
    assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be unchanged in plan mode");

    const afterHistory = readHistory();
    assert.deepEqual(afterHistory, beforeHistory, "history must be unchanged in plan mode");

    const afterLog = readLog();
    assert.deepEqual(afterLog, beforeLog, "call log must be unchanged in plan mode");

    const afterLockExists = fs.existsSync(lockPath);
    assert.equal(afterLockExists, false, "lock file should not exist after rollback plan");
  });
});

test("M-047 rollback apply pre-existing lock contention exits 15 leaves state unchanged", () => {
  withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory, seedHistory }) => {
    const hist = path.join(scripts, "release-history.sh");
    const rollback = path.join(scripts, "rollback.sh");

    seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
    seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");

    const envFile = path.join(tmp, ".env.test");
    const envContent = `APP_IMAGE_REF=${DIGEST_2}
RELEASE_ID=rel-2
KEEP=value
`;
    fs.writeFileSync(envFile, envContent, { mode: 0o600 });

    const beforeEnvBytes = fs.readFileSync(envFile);
    const beforeEnvMode = fs.statSync(envFile).mode & 0o777;
    const beforeHistory = readHistory();
    const beforeLog = readLog();

    const lockPath = envFile + ".rollback-lock";
    fs.mkdirSync(lockPath, { mode: 0o700 });
    const beforeLockExists = fs.existsSync(lockPath);
    assert.equal(beforeLockExists, true, "pre-existing lock directory should exist");

    const out = run(rollback, [envFile, "--apply"]);

    assert.equal(out.status, 15, `expected status 15 got ${out.status}: stdout=${out.stdout} stderr=${out.stderr}`);
    assert.match(out.stderr, /another rollback apply is in progress/);

    const afterLockExists = fs.existsSync(lockPath);
    assert.equal(afterLockExists, true, "pre-existing lock directory should remain");

    const afterEnvBytes = fs.readFileSync(envFile);
    assert.deepEqual(afterEnvBytes, beforeEnvBytes, "env file bytes must be unchanged");

    const afterEnvMode = fs.statSync(envFile).mode & 0o777;
    assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be unchanged");

    const afterHistory = readHistory();
    assert.deepEqual(afterHistory, beforeHistory, "history must be unchanged");

    const afterLog = readLog();
    assert.deepEqual(afterLog, beforeLog, "call log must be unchanged");

    const backupFiles = fs.readdirSync(tmp).filter(f => f.startsWith(".env.test.rollback-backup."));
    assert.equal(backupFiles.length, 0, "no env backup file should have been created");
  });
});

test("M-047 rollback apply success updates env records history removes lock", () => {
  withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory, seedHistory }) => {
    const hist = path.join(scripts, "release-history.sh");
    const rollback = path.join(scripts, "rollback.sh");

    seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
    seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");

    const envFile = path.join(tmp, ".env.test");
    const envContent = `APP_IMAGE_REF=${DIGEST_2}
RELEASE_ID=rel-2
KEEP=value
`;
    fs.writeFileSync(envFile, envContent, { mode: 0o640 });

    const beforeEnvBytes = fs.readFileSync(envFile);
    const beforeEnvMode = fs.statSync(envFile).mode & 0o777;
    const beforeHistory = readHistory();
    const beforeLog = readLog();

    const out = run(rollback, [envFile, "--apply"]);

    assert.equal(out.status, 0, `apply failed: stdout=${out.stdout} stderr=${out.stderr}`);
    assert.match(out.stdout, /Rollback completed successfully/);
    assert.match(out.stdout, /from: rel-2/);
    assert.match(out.stdout, /to  : rel-1/);

    const afterLog = readLog();
    assert.equal(afterLog.length, 3, "call log must have exactly 3 entries: backup, systemctl, healthcheck");
    assert.match(afterLog[0], /^backup-sqlite\.sh/);
    assert.match(afterLog[1], /^systemctl restart jpyc-payment-terminal\.service/);
    assert.match(afterLog[2], /^healthcheck\.sh/);

    const afterEnvBytes = fs.readFileSync(envFile);
    const expectedEnvContent = `APP_IMAGE_REF=${DIGEST_1}
RELEASE_ID=rel-1
KEEP=value
`;
    assert.equal(afterEnvBytes.toString(), expectedEnvContent, "env file content must match target release with KEEP preserved");

    const afterEnvMode = fs.statSync(envFile).mode & 0o777;
    assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be preserved");

    const backupFiles = fs.readdirSync(path.dirname(envFile)).filter(f => f.startsWith(".env.test.rollback-backup."));
    assert.equal(backupFiles.length, 1, "exactly one env backup file must exist");
    const backupPath = path.join(path.dirname(envFile), backupFiles[0]);
    const backupBytes = fs.readFileSync(backupPath);
    const backupMode = fs.statSync(backupPath).mode & 0o777;
    assert.deepEqual(backupBytes, beforeEnvBytes, "backup file bytes must equal original env bytes");
    assert.equal(backupMode, beforeEnvMode, "backup file mode must equal original env mode");

    const afterHistory = readHistory();
    assert.equal(afterHistory.length, beforeHistory.length + 1, "history must gain exactly one rollback event");
    const rollbackEvent = JSON.parse(afterHistory[afterHistory.length - 1]);
    assert.equal(rollbackEvent.event_type, "rollback");
    assert.equal(rollbackEvent.status, "applied");
    assert.equal(rollbackEvent.release_id, "rel-1");
    assert.equal(rollbackEvent.to_release_id, "rel-1");
    assert.equal(rollbackEvent.from_release_id, "rel-2");
    assert.equal(rollbackEvent.commit, COMMIT_1);
    assert.equal(rollbackEvent.image_digest, DIGEST_1);
    assert.equal(rollbackEvent.environment, "commercial");
    assert.equal(rollbackEvent.db_schema_version, "3");

    const lockPath = envFile + ".rollback-lock";
    const afterLockExists = fs.existsSync(lockPath);
    assert.equal(afterLockExists, false, "owned lock directory must be removed after successful apply");
  });
});

test("M-047 rollback apply BACKUP_FAIL exits nonzero before env mutation, no backup, lock removed, call log only backup", () => {
  withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory, seedHistory }) => {
    const hist = path.join(scripts, "release-history.sh");
    const rollback = path.join(scripts, "rollback.sh");

    seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
    seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");

    const envFile = path.join(tmp, ".env.test");
    const envContent = `APP_IMAGE_REF=${DIGEST_2}
RELEASE_ID=rel-2
KEEP=value
`;
    fs.writeFileSync(envFile, envContent, { mode: 0o640 });

    const beforeEnvBytes = fs.readFileSync(envFile);
    const beforeEnvMode = fs.statSync(envFile).mode & 0o777;
    const beforeHistory = readHistory();
    const beforeLog = readLog();

    const out = run(rollback, [envFile, "--apply"], { BACKUP_FAIL: "1" });

    assert.equal(out.status, 1, `expected nonzero exit on backup failure, got ${out.status}: stdout=${out.stdout} stderr=${out.stderr}`);

    const afterEnvBytes = fs.readFileSync(envFile);
    assert.deepEqual(afterEnvBytes, beforeEnvBytes, "env file bytes must be unchanged when backup fails");

    const afterEnvMode = fs.statSync(envFile).mode & 0o777;
    assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be unchanged when backup fails");

    const afterHistory = readHistory();
    assert.deepEqual(afterHistory, beforeHistory, "history must be unchanged when backup fails");

    const afterLog = readLog();
    assert.equal(afterLog.length, 1, "call log must contain only backup invocation");
    assert.match(afterLog[0], /^backup-sqlite\.sh/);

    const backupFiles = fs.readdirSync(path.dirname(envFile)).filter(f => f.startsWith(".env.test.rollback-backup."));
    assert.equal(backupFiles.length, 0, "no env backup file should have been created");

    const lockPath = envFile + ".rollback-lock";
    const afterLockExists = fs.existsSync(lockPath);
    assert.equal(afterLockExists, false, "lock directory must be removed after backup failure");
  });
});

test("M-047 rollback apply SYSTEMCTL_FAIL_FIRST exits 12, env restored, backup matches original, failed rollback event recorded, restoration restart invoked, lock removed", () => {
  withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory, seedHistory }) => {
    const hist = path.join(scripts, "release-history.sh");
    const rollback = path.join(scripts, "rollback.sh");

    seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
    seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");

    const envFile = path.join(tmp, ".env.test");
    const envContent = `APP_IMAGE_REF=${DIGEST_2}
RELEASE_ID=rel-2
KEEP=value
`;
    fs.writeFileSync(envFile, envContent, { mode: 0o640 });

    const beforeEnvBytes = fs.readFileSync(envFile);
    const beforeEnvMode = fs.statSync(envFile).mode & 0o777;
    const beforeHistory = readHistory();

    const out = run(rollback, [envFile, "--apply"], { SYSTEMCTL_FAIL_FIRST: "1" });

    assert.equal(out.status, 12, `expected exit 12 on systemctl failure, got ${out.status}: stdout=${out.stdout} stderr=${out.stderr}`);

    const afterEnvBytes = fs.readFileSync(envFile);
    assert.deepEqual(afterEnvBytes, beforeEnvBytes, "env file bytes must be restored exactly after systemctl failure");

    const afterEnvMode = fs.statSync(envFile).mode & 0o777;
    assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be restored exactly after systemctl failure");

    const backupFiles = fs.readdirSync(path.dirname(envFile)).filter(f => f.startsWith(".env.test.rollback-backup."));
    assert.equal(backupFiles.length, 1, "exactly one env backup file must exist");
    const backupPath = path.join(path.dirname(envFile), backupFiles[0]);
    const backupBytes = fs.readFileSync(backupPath);
    const backupMode = fs.statSync(backupPath).mode & 0o777;
    assert.deepEqual(backupBytes, beforeEnvBytes, "backup file bytes must equal original env bytes");
    assert.equal(backupMode, beforeEnvMode, "backup file mode must equal original env mode");

    const afterHistory = readHistory();
    assert.equal(afterHistory.length, beforeHistory.length + 1, "history must gain exactly one failed rollback event");
    const rollbackEvent = JSON.parse(afterHistory[afterHistory.length - 1]);
    assert.equal(rollbackEvent.event_type, "rollback");
    assert.equal(rollbackEvent.status, "failed");
    assert.equal(rollbackEvent.release_id, "rel-1");
    assert.equal(rollbackEvent.to_release_id, "rel-1");
    assert.equal(rollbackEvent.from_release_id, "rel-2");
    assert.equal(rollbackEvent.commit, COMMIT_1);
    assert.equal(rollbackEvent.image_digest, DIGEST_1);
    assert.equal(rollbackEvent.environment, "commercial");
    assert.equal(rollbackEvent.db_schema_version, "3");

    const afterLog = readLog();
    assert.match(afterLog[0], /^backup-sqlite\.sh/);
    assert.match(afterLog[1], /^systemctl restart jpyc-payment-terminal\.service/);
    assert.match(afterLog[2], /^systemctl restart jpyc-payment-terminal\.service/, "restoration restart must be invoked");

    const lockPath = envFile + ".rollback-lock";
    const afterLockExists = fs.existsSync(lockPath);
    assert.equal(afterLockExists, false, "lock directory must be removed after systemctl failure");
  });
});

test("M-047 rollback apply SYSTEMCTL_FAIL_ALL exits 12, env still restored byte-for-byte when restoration restart also fails, restore failure surfaced to stderr, failed rollback event recorded, no healthcheck attempted, lock removed", () => {
  withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory, seedHistory }) => {
    const hist = path.join(scripts, "release-history.sh");
    const rollback = path.join(scripts, "rollback.sh");

    seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
    seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");

    const envFile = path.join(tmp, ".env.test");
    const envContent = `APP_IMAGE_REF=${DIGEST_2}
RELEASE_ID=rel-2
KEEP=value
`;
    fs.writeFileSync(envFile, envContent, { mode: 0o640 });

    const beforeEnvBytes = fs.readFileSync(envFile);
    const beforeEnvMode = fs.statSync(envFile).mode & 0o777;
    const beforeHistory = readHistory();

    const out = run(rollback, [envFile, "--apply"], { SYSTEMCTL_FAIL_ALL: "1" });

    assert.equal(out.status, 12, `expected exit 12 when both target restart and restoration restart fail, got ${out.status}: stdout=${out.stdout} stderr=${out.stderr}`);
    assert.match(out.stderr, /restore failed/, "restoration restart failure must not be masked; caller must report restore failure");

    const afterEnvBytes = fs.readFileSync(envFile);
    assert.deepEqual(afterEnvBytes, beforeEnvBytes, "env file bytes must be restored exactly even when restoration restart fails");

    const afterEnvMode = fs.statSync(envFile).mode & 0o777;
    assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be restored exactly even when restoration restart fails");

    const backupFiles = fs.readdirSync(path.dirname(envFile)).filter(f => f.startsWith(".env.test.rollback-backup."));
    assert.equal(backupFiles.length, 1, "exactly one env backup file must exist");
    const backupPath = path.join(path.dirname(envFile), backupFiles[0]);
    const backupBytes = fs.readFileSync(backupPath);
    const backupMode = fs.statSync(backupPath).mode & 0o777;
    assert.deepEqual(backupBytes, beforeEnvBytes, "backup file bytes must equal original env bytes");
    assert.equal(backupMode, beforeEnvMode, "backup file mode must equal original env mode");

    const afterHistory = readHistory();
    assert.equal(afterHistory.length, beforeHistory.length + 1, "history must gain exactly one failed rollback event");
    const rollbackEvent = JSON.parse(afterHistory[afterHistory.length - 1]);
    assert.equal(rollbackEvent.event_type, "rollback");
    assert.equal(rollbackEvent.status, "failed");
    assert.equal(rollbackEvent.release_id, "rel-1");
    assert.equal(rollbackEvent.to_release_id, "rel-1");
    assert.equal(rollbackEvent.from_release_id, "rel-2");
    assert.equal(rollbackEvent.commit, COMMIT_1);
    assert.equal(rollbackEvent.image_digest, DIGEST_1);
    assert.equal(rollbackEvent.environment, "commercial");
    assert.equal(rollbackEvent.db_schema_version, "3");

    const appliedRollbackEvents = afterHistory.filter(line => {
      const parsed = JSON.parse(line);
      return parsed.event_type === "rollback" && parsed.status === "applied";
    });
    assert.equal(appliedRollbackEvents.length, 0, "no applied rollback event must exist");

    const afterLog = readLog();
    assert.match(afterLog[0], /^backup-sqlite\.sh/);
    assert.match(afterLog[1], /^systemctl restart jpyc-payment-terminal\.service/);
    assert.match(afterLog[2], /^systemctl restart jpyc-payment-terminal\.service/, "restoration restart must still be invoked");
    assert.equal(afterLog.length, 3, "call log must contain backup and two systemctl restarts only; healthcheck must not be reached");

    const lockPath = envFile + ".rollback-lock";
    const afterLockExists = fs.existsSync(lockPath);
    assert.equal(afterLockExists, false, "lock directory must be removed when restoration restart also fails");
  });
});

test("M-047 rollback apply HEALTHCHECK_ALWAYS_FAIL exits 13 after 30 attempts, env restored, backup matches original, failed rollback event recorded, previous release restart invoked, lock removed", () => {
  withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory, seedHistory }) => {
    const hist = path.join(scripts, "release-history.sh");
    const rollback = path.join(scripts, "rollback.sh");

    seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
    seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");

    const envFile = path.join(tmp, ".env.test");
    const envContent = `APP_IMAGE_REF=${DIGEST_2}
RELEASE_ID=rel-2
KEEP=value
HEALTHCHECK_URL=http://127.0.0.1:4173/healthz
`;
    fs.writeFileSync(envFile, envContent, { mode: 0o640 });

    const beforeEnvBytes = fs.readFileSync(envFile);
    const beforeEnvMode = fs.statSync(envFile).mode & 0o777;
    const beforeHistory = readHistory();

    const out = run(rollback, [envFile, "--apply"], { HEALTHCHECK_ALWAYS_FAIL: "1" });

    assert.equal(out.status, 13, `expected exit 13 on healthcheck failure, got ${out.status}: stdout=${out.stdout} stderr=${out.stderr}`);

    const afterEnvBytes = fs.readFileSync(envFile);
    assert.deepEqual(afterEnvBytes, beforeEnvBytes, "env file bytes must be restored exactly after healthcheck failure");

    const afterEnvMode = fs.statSync(envFile).mode & 0o777;
    assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be restored exactly after healthcheck failure");

    const backupFiles = fs.readdirSync(path.dirname(envFile)).filter(f => f.startsWith(".env.test.rollback-backup."));
    assert.equal(backupFiles.length, 1, "exactly one env backup file must exist");
    const backupPath = path.join(path.dirname(envFile), backupFiles[0]);
    const backupBytes = fs.readFileSync(backupPath);
    const backupMode = fs.statSync(backupPath).mode & 0o777;
    assert.deepEqual(backupBytes, beforeEnvBytes, "backup file bytes must equal original env bytes");
    assert.equal(backupMode, beforeEnvMode, "backup file mode must equal original env mode");

    const afterHistory = readHistory();
    assert.equal(afterHistory.length, beforeHistory.length + 1, "history must gain exactly one failed rollback event");
    const rollbackEvent = JSON.parse(afterHistory[afterHistory.length - 1]);
    assert.equal(rollbackEvent.event_type, "rollback");
    assert.equal(rollbackEvent.status, "failed");
    assert.equal(rollbackEvent.release_id, "rel-1");
    assert.equal(rollbackEvent.to_release_id, "rel-1");
    assert.equal(rollbackEvent.from_release_id, "rel-2");
    assert.equal(rollbackEvent.commit, COMMIT_1);
    assert.equal(rollbackEvent.image_digest, DIGEST_1);
    assert.equal(rollbackEvent.environment, "commercial");
    assert.equal(rollbackEvent.db_schema_version, "3");

    const afterLog = readLog();
    assert.match(afterLog[0], /^backup-sqlite\.sh/);
    assert.match(afterLog[1], /^systemctl restart jpyc-payment-terminal\.service/);
    const healthcheckCalls = afterLog.filter(l => l.startsWith("healthcheck.sh"));
    assert.equal(healthcheckCalls.length, 30, "healthcheck.sh must be called exactly 30 times");
    assert.match(afterLog[afterLog.length - 1], /^systemctl restart jpyc-payment-terminal\.service/, "previous release restart must be invoked after restoration");

    const lockPath = envFile + ".rollback-lock";
    const afterLockExists = fs.existsSync(lockPath);
    assert.equal(afterLockExists, false, "lock directory must be removed after healthcheck failure");
  });
});

test("M-047 rollback apply RECORD_ROLLBACK_APPLIED_FAIL exits 14, env restored, backup matches original, failed rollback event recorded, restoration restart invoked, lock removed, healthcheck attempted", () => {
  withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory, seedHistory }) => {
    const hist = path.join(scripts, "release-history.sh");
    const rollback = path.join(scripts, "rollback.sh");

    seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
    seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");

    const envFile = path.join(tmp, ".env.test");
    const envContent = `APP_IMAGE_REF=${DIGEST_2}
RELEASE_ID=rel-2
KEEP=value
HEALTHCHECK_URL=http://127.0.0.1:4173/healthz
`;
    fs.writeFileSync(envFile, envContent, { mode: 0o640 });

    const beforeEnvBytes = fs.readFileSync(envFile);
    const beforeEnvMode = fs.statSync(envFile).mode & 0o777;
    const beforeHistory = readHistory();

    const wrapperDir = path.join(tmp, "node-wrapper");
    fs.mkdirSync(wrapperDir, { recursive: true });
    const wrapperPath = path.join(wrapperDir, "node");

    const wrapperScript = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ": \"${REAL_NODE_BIN:?REAL_NODE_BIN not set}\"",
      'if [[ "${1:-}" == */release-history.mjs && "${2:-}" == "record-rollback" && "${!#:-}" == "applied" ]]; then',
      '  echo "Simulated failure: record-rollback applied" >&2',
      "  exit 1",
      "fi",
      'exec "$REAL_NODE_BIN" "$@"',
    ].join("\n") + "\n";
    fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

    const out = run(rollback, [envFile, "--apply"], {
      NODE_BIN: wrapperPath,
      REAL_NODE_BIN: process.execPath,
    });

    assert.equal(out.status, 14, `expected exit 14 on record-rollback applied failure, got ${out.status}: stdout=${out.stdout} stderr=${out.stderr}`);
    assert.match(out.stderr, /Simulated failure: record-rollback applied/);

    const afterEnvBytes = fs.readFileSync(envFile);
    assert.deepEqual(afterEnvBytes, beforeEnvBytes, "env file bytes must be restored exactly after record-rollback applied failure");

    const afterEnvMode = fs.statSync(envFile).mode & 0o777;
    assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be restored exactly after record-rollback applied failure");

    const backupFiles = fs.readdirSync(path.dirname(envFile)).filter(f => f.startsWith(".env.test.rollback-backup."));
    assert.equal(backupFiles.length, 1, "exactly one env backup file must exist");
    const backupPath = path.join(path.dirname(envFile), backupFiles[0]);
    const backupBytes = fs.readFileSync(backupPath);
    const backupMode = fs.statSync(backupPath).mode & 0o777;
    assert.deepEqual(backupBytes, beforeEnvBytes, "backup file bytes must equal original env bytes");
    assert.equal(backupMode, beforeEnvMode, "backup file mode must equal original env mode");

    const afterHistory = readHistory();
    assert.equal(afterHistory.length, beforeHistory.length + 1, "history must gain exactly one rollback event");
    const rollbackEvent = JSON.parse(afterHistory[afterHistory.length - 1]);
    assert.equal(rollbackEvent.event_type, "rollback");
    assert.equal(rollbackEvent.status, "failed", "rollback event status must be failed, not applied");
    assert.equal(rollbackEvent.release_id, "rel-1");
    assert.equal(rollbackEvent.to_release_id, "rel-1");
    assert.equal(rollbackEvent.from_release_id, "rel-2");
    assert.equal(rollbackEvent.commit, COMMIT_1);
    assert.equal(rollbackEvent.image_digest, DIGEST_1);
    assert.equal(rollbackEvent.environment, "commercial");
    assert.equal(rollbackEvent.db_schema_version, "3");

    const appliedRollbackEvents = afterHistory.filter(line => {
      const parsed = JSON.parse(line);
      return parsed.event_type === "rollback" && parsed.status === "applied";
    });
    assert.equal(appliedRollbackEvents.length, 0, "no applied rollback event must exist");

    const afterLog = readLog();
    assert.match(afterLog[0], /^backup-sqlite\.sh/);
    assert.match(afterLog[1], /^systemctl restart jpyc-payment-terminal\.service/);
    const healthcheckCalls = afterLog.filter(l => l.startsWith("healthcheck.sh"));
    assert.equal(healthcheckCalls.length, 1, "healthcheck.sh must be called exactly once before history failure");
    assert.match(afterLog[afterLog.length - 1], /^systemctl restart jpyc-payment-terminal\.service/, "restoration restart must be invoked");

    const lockPath = envFile + ".rollback-lock";
    const afterLockExists = fs.existsSync(lockPath);
    assert.equal(afterLockExists, false, "lock directory must be removed after record-rollback applied failure");
  });
});

test("M-047 rollback fail-closed pre-apply guards (table-driven)", () => {
  const cases = [
    {
      name: "target schema mismatch",
      setupHistory: ({ seedHistory }) => {
        seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "2");
        seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");
      },
      envContent: `APP_IMAGE_REF=${DIGEST_2}\nRELEASE_ID=rel-2\nKEEP=value\n`,
      args: ["--apply"],
      expectExit: 8,
      expectStderr: /DB schema version mismatch/,
    },
    {
      name: "target environment mismatch",
      setupHistory: ({ seedHistory }) => {
        seedHistory("rel-1", COMMIT_1, DIGEST_1, "staging", "3");
        seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");
      },
      envContent: `APP_IMAGE_REF=${DIGEST_2}\nRELEASE_ID=rel-2\nKEEP=value\n`,
      args: ["--apply"],
      expectExit: 9,
      expectStderr: /environment mismatch/,
    },
    {
      name: "env identity mismatch with exactly one APP_IMAGE_REF and RELEASE_ID",
      setupHistory: ({ seedHistory }) => {
        seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
        seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");
      },
      envContent: `APP_IMAGE_REF=${DIGEST_1}\nRELEASE_ID=rel-1\nKEEP=value\n`,
      args: ["--apply"],
      expectExit: 11,
      expectStderr: /env file APP_IMAGE_REF\/RELEASE_ID does not match current history identity/,
    },
    {
      name: "duplicate APP_IMAGE_REF",
      setupHistory: ({ seedHistory }) => {
        seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
        seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");
      },
      envContent: `APP_IMAGE_REF=${DIGEST_2}\nAPP_IMAGE_REF=${DIGEST_1}\nRELEASE_ID=rel-2\nKEEP=value\n`,
      args: ["--apply"],
      expectExit: 10,
      expectStderr: /env file must contain exactly one APP_IMAGE_REF and one RELEASE_ID/,
    },
    {
      name: "missing RELEASE_ID",
      setupHistory: ({ seedHistory }) => {
        seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
        seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");
      },
      envContent: `APP_IMAGE_REF=${DIGEST_2}\nKEEP=value\n`,
      args: ["--apply"],
      expectExit: 10,
      expectStderr: /env file must contain exactly one APP_IMAGE_REF and one RELEASE_ID/,
    },
    {
      name: "env file is a symlink",
      setupHistory: ({ seedHistory }) => {
        seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
        seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");
      },
      createSymlink: true,
      targetEnvContent: `APP_IMAGE_REF=${DIGEST_2}\nRELEASE_ID=rel-2\nKEEP=value\n`,
      args: ["--apply"],
      expectExit: 2,
      expectStderr: /env file must not be a symlink/,
    },
    {
      name: "explicit --to current release",
      setupHistory: ({ seedHistory }) => {
        seedHistory("rel-1", COMMIT_1, DIGEST_1, "commercial", "3");
        seedHistory("rel-2", COMMIT_2, DIGEST_2, "commercial", "3");
      },
      envContent: `APP_IMAGE_REF=${DIGEST_2}\nRELEASE_ID=rel-2\nKEEP=value\n`,
      args: ["--to", "rel-2", "--apply"],
      expectExit: 7,
      expectStderr: /refusing to roll back to the currently running release/,
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      withTempRepo(({ tmp, scripts, runtime, run, readLog, readHistory, seedHistory }) => {
        tc.setupHistory({ seedHistory });

        let envFile;
        let targetFile;
        let beforeEnvBytes;
        let beforeEnvMode;

        if (tc.createSymlink) {
          targetFile = path.join(tmp, ".env.target");
          fs.writeFileSync(targetFile, tc.targetEnvContent, { mode: 0o640 });
          beforeEnvBytes = fs.readFileSync(targetFile);
          beforeEnvMode = fs.statSync(targetFile).mode & 0o777;

          envFile = path.join(tmp, ".env.test");
          fs.symlinkSync(targetFile, envFile);
        } else {
          envFile = path.join(tmp, ".env.test");
          fs.writeFileSync(envFile, tc.envContent, { mode: 0o640 });
          beforeEnvBytes = fs.readFileSync(envFile);
          beforeEnvMode = fs.statSync(envFile).mode & 0o777;
        }

        const beforeHistory = readHistory();
        const beforeLog = readLog();
        const lockPath = envFile + ".rollback-lock";
        const beforeLockExists = fs.existsSync(lockPath);
        assert.equal(beforeLockExists, false, "lock file should not exist before rollback");

        const rollback = path.join(scripts, "rollback.sh");
        const out = run(rollback, [envFile, ...tc.args]);

        assert.equal(out.status, tc.expectExit, `expected exit ${tc.expectExit} got ${out.status}: stdout=${out.stdout} stderr=${out.stderr}`);
        assert.match(out.stderr, tc.expectStderr, `stderr should match expected pattern for ${tc.name}`);

        if (tc.createSymlink) {
          const symlinkExists = fs.existsSync(envFile);
          assert.equal(symlinkExists, true, "symlink must remain after fail-closed rejection");

          const targetBytes = fs.readFileSync(targetFile);
          assert.deepEqual(targetBytes, beforeEnvBytes, "target file bytes must be unchanged after fail-closed rejection");

          const targetMode = fs.statSync(targetFile).mode & 0o777;
          assert.equal(targetMode, beforeEnvMode, "target file mode must be unchanged after fail-closed rejection");
        } else {
          const afterEnvBytes = fs.readFileSync(envFile);
          assert.deepEqual(afterEnvBytes, beforeEnvBytes, "env file bytes must be unchanged after fail-closed rejection");

          const afterEnvMode = fs.statSync(envFile).mode & 0o777;
          assert.equal(afterEnvMode, beforeEnvMode, "env file mode must be unchanged after fail-closed rejection");
        }

        const afterHistory = readHistory();
        assert.deepEqual(afterHistory, beforeHistory, "history must be unchanged after fail-closed rejection");

        const afterLog = readLog();
        assert.deepEqual(afterLog, beforeLog, "call log must be unchanged after fail-closed rejection");

        const backupFiles = fs.readdirSync(tmp).filter(f => f.startsWith(".env.test.rollback-backup.") || f.startsWith(".env.target.rollback-backup."));
        assert.equal(backupFiles.length, 0, "no env backup file should have been created after fail-closed rejection");

        const afterLockExists = fs.existsSync(lockPath);
        assert.equal(afterLockExists, false, "lock directory must not exist after fail-closed rejection");
      });
    });
  }
});