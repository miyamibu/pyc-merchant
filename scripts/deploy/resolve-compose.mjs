#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

function commandSucceeds(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

export function resolveDockerCompose({ env = process.env } = {}) {
  const dockerComposePlugin = commandSucceeds("docker", ["compose", "version"], env);
  if (dockerComposePlugin.ok) {
    return {
      available: true,
      kind: "docker-compose-plugin",
      command: ["docker", "compose"],
      version: dockerComposePlugin.stdout || null,
    };
  }

  const standalone = commandSucceeds("docker-compose", ["version"], env);
  if (standalone.ok) {
    return {
      available: true,
      kind: "docker-compose-standalone",
      command: ["docker-compose"],
      version: standalone.stdout || null,
    };
  }

  return {
    available: false,
    code: "DOCKER_COMPOSE_UNAVAILABLE",
    command: [],
    diagnostics: {
      docker_compose_plugin: {
        status: dockerComposePlugin.status,
        stderr: dockerComposePlugin.stderr,
      },
      docker_compose_standalone: {
        status: standalone.status,
        stderr: standalone.stderr,
      },
    },
  };
}

function parseArgs(argv) {
  return new Set(argv);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = resolveDockerCompose();
  if (args.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.has("--print-lines")) {
    for (const part of result.command) console.log(part);
  } else {
    console.log(result.available ? result.command.join(" ") : result.code);
  }
  process.exit(result.available ? 0 : 2);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  main();
}
