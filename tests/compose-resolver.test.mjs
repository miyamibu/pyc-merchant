import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDockerCompose } from "../scripts/deploy/resolve-compose.mjs";

function makeBin(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-resolver-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return { dir, file };
}

test("compose resolver prefers docker compose plugin", () => {
  const docker = makeBin("docker", 'if [[ "$1 $2" == "compose version" ]]; then echo "Docker Compose version v2"; exit 0; fi; exit 1');
  const result = resolveDockerCompose({ env: { ...process.env, PATH: docker.dir } });
  assert.equal(result.available, true);
  assert.deepEqual(result.command, ["docker", "compose"]);
});

test("compose resolver falls back to docker-compose", () => {
  const docker = makeBin("docker", "exit 1");
  const standalone = makeBin("docker-compose", 'if [[ "$1" == "version" ]]; then echo "docker-compose version 1"; exit 0; fi; exit 1');
  const result = resolveDockerCompose({ env: { ...process.env, PATH: `${docker.dir}${path.delimiter}${standalone.dir}` } });
  assert.equal(result.available, true);
  assert.deepEqual(result.command, ["docker-compose"]);
});

test("compose resolver reports unavailable when neither command exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-resolver-empty-"));
  const result = resolveDockerCompose({ env: { ...process.env, PATH: dir } });
  assert.equal(result.available, false);
  assert.equal(result.code, "DOCKER_COMPOSE_UNAVAILABLE");
});
