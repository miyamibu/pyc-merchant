#!/usr/bin/env node
// scripts/handoff/create-clean-source-zip.mjs
//
// Stage the repo into an ASCII-named clean source tree and produce a ZIP
// suitable for handoff. The output explicitly excludes node_modules, .git,
// data/, runtime/, artifacts/, deliverables/, __MACOSX, .DS_Store,
// .claude/settings.local.json, .claude/launch.json, .codex/, DB/WAL/SHM
// files, .env files, private evidence, and local logs.
//
// Usage:
//   node scripts/handoff/create-clean-source-zip.mjs
//   node scripts/handoff/create-clean-source-zip.mjs --out path/to/out
//   node scripts/handoff/create-clean-source-zip.mjs --root-name jpyc-merchant-ops
//
// After creation the script runs scripts/handoff/audit-source-hygiene.mjs on
// the staged directory to confirm cleanliness. Non-zero exit means the ZIP
// would not have been clean and is not produced.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

const repoRoot = path.resolve(process.cwd());
const rootName = arg('--root-name', 'jpyc-merchant-ops');
const outDir = path.resolve(arg('--out', path.join(repoRoot, 'deliverables', 'handoff')));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const zipName = `${rootName}-${stamp}.zip`;
const stagingParent = await fs.mkdtemp(path.join(os.tmpdir(), 'jpyc-handoff-'));
const stagingRoot = path.join(stagingParent, rootName);

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.codex',
  '.agents',
  '.claude',
  'data',
  'runtime',
  'artifacts',
  'deliverables',
  '__MACOSX',
]);

const EXCLUDE_FILES = new Set([
  '.DS_Store',
  '.env',
  '.env.production',
]);

const EXCLUDE_PATH_SUFFIXES = [
  '.claude/launch.json',
  '.claude/settings.local.json',
];

const EXCLUDE_EXT = new Set([
  '.db',
  '.db-shm',
  '.db-wal',
  '.sqlite',
  '.sqlite-shm',
  '.sqlite-wal',
  '.sqlite3',
  '.sqlite3-shm',
  '.sqlite3-wal',
  '.log',
  '.tmp',
]);

const EXCLUDE_PATH_PREFIXES = [
  'docs/production/evidence/',
  'deploy/nginx/certs/',
];

const KEEP_FILES = new Set([
  'docs/production/evidence/.gitkeep',
  'deploy/nginx/certs/.gitkeep',
]);

function shouldExcludeFile(rel, name) {
  if (EXCLUDE_FILES.has(name)) return true;
  for (const suffix of EXCLUDE_PATH_SUFFIXES) {
    if (rel.endsWith(suffix)) return true;
  }
  const ext = path.extname(name).toLowerCase();
  if (EXCLUDE_EXT.has(ext)) return true;
  for (const prefix of EXCLUDE_PATH_PREFIXES) {
    if (rel.startsWith(prefix) && !KEEP_FILES.has(rel)) return true;
  }
  return false;
}

async function copyTree(srcRoot, dstRoot, rel = '') {
  let entries;
  try {
    entries = await fs.readdir(srcRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const srcAbs = path.join(srcRoot, entry.name);
    const dstAbs = path.join(dstRoot, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name) && rel === '') continue;
      if (EXCLUDE_DIRS.has(entry.name) && rel !== '') continue;
      await fs.mkdir(dstAbs, { recursive: true });
      await copyTree(srcAbs, dstAbs, childRel);
    } else if (entry.isFile()) {
      if (shouldExcludeFile(childRel, entry.name)) continue;
      await fs.copyFile(srcAbs, dstAbs);
    }
  }
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  await fs.mkdir(stagingRoot, { recursive: true });
  await copyTree(repoRoot, stagingRoot);

  const auditScript = path.join(repoRoot, 'scripts', 'handoff', 'audit-source-hygiene.mjs');
  const audit = await run(process.execPath, [auditScript, stagingRoot]);
  process.stdout.write(audit.stdout);
  if (audit.stderr) process.stderr.write(audit.stderr);
  if (audit.code !== 0) {
    console.error(JSON.stringify({ ok: false, error: 'staging_audit_failed', staging_root: stagingRoot }));
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(outDir, { recursive: true });
  const zipPath = path.join(outDir, zipName);
  const zip = await run('zip', ['-r', '-q', zipPath, rootName], { cwd: stagingParent });
  if (zip.code !== 0) {
    console.error(JSON.stringify({
      ok: false,
      error: 'zip_failed',
      zip_path: zipPath,
      stdout: zip.stdout,
      stderr: zip.stderr,
    }));
    process.exitCode = 1;
    return;
  }

  const stat = await fs.stat(zipPath);
  console.log(JSON.stringify({
    ok: true,
    zip_path: zipPath,
    zip_size_bytes: stat.size,
    root_name: rootName,
    staging_root: stagingRoot,
  }, null, 2));

  await fs.rm(stagingParent, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: 'create_zip_failed', detail: String(err?.message || err) }));
  process.exitCode = 1;
});
