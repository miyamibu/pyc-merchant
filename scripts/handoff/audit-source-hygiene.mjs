#!/usr/bin/env node
// scripts/handoff/audit-source-hygiene.mjs
//
// Fails (exit 1) if the candidate handoff directory contains anything that
// should not be shipped in a clean source ZIP: node_modules, .git, data/,
// runtime/, __MACOSX, .DS_Store, local DB/WAL/SHM/sqlite files, local logs,
// private evidence, .claude/settings.local.json, .env / .env.production, etc.
//
// Defaults to auditing the current repo root, so it can be used as a CI
// guard. Pass a path argument to audit a different directory (e.g. an
// extracted handoff ZIP).
//
// Usage:
//   node scripts/handoff/audit-source-hygiene.mjs           # audit ./
//   node scripts/handoff/audit-source-hygiene.mjs path/to   # audit path/to

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const FORBIDDEN_DIRS = new Set([
  'node_modules',
  '.git',
  'data',
  'runtime',
  '__MACOSX',
  'artifacts',
  'deliverables',
  '.codex',
  '.agents',
]);

const FORBIDDEN_FILES = new Set([
  '.DS_Store',
  '.env',
  '.env.production',
]);

const FORBIDDEN_PATH_SUFFIXES = [
  '.claude/launch.json',
  '.claude/settings.local.json',
];

const FORBIDDEN_EXTENSIONS = new Set([
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

const SECRET_LIKE_FILENAMES = [
  /^id_rsa$/i,
  /^id_dsa$/i,
  /^id_ed25519$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^credentials(\..+)?$/i,
  /^secret(s|_.+)?$/i,
];

const PRIVATE_EVIDENCE_PREFIXES = [
  'docs/production/evidence/',
];

const EVIDENCE_KEEP_FILES = new Set([
  'docs/production/evidence/.gitkeep',
]);

const root = path.resolve(process.argv[2] || process.cwd());

async function walk(dir, rel = '') {
  const findings = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return [{ rel, kind: 'unreadable', detail: String(err?.message || err) }];
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRS.has(entry.name)) {
        findings.push({ rel: childRel, kind: 'forbidden_dir', detail: entry.name });
        continue;
      }
      const subFindings = await walk(childAbs, childRel);
      findings.push(...subFindings);
      continue;
    }

    if (FORBIDDEN_FILES.has(entry.name)) {
      findings.push({ rel: childRel, kind: 'forbidden_file', detail: entry.name });
      continue;
    }

    for (const suffix of FORBIDDEN_PATH_SUFFIXES) {
      if (childRel.endsWith(suffix)) {
        findings.push({ rel: childRel, kind: 'forbidden_path', detail: suffix });
      }
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      findings.push({ rel: childRel, kind: 'forbidden_ext', detail: ext });
    }

    for (const pattern of SECRET_LIKE_FILENAMES) {
      if (pattern.test(entry.name)) {
        findings.push({ rel: childRel, kind: 'secret_like_filename', detail: entry.name });
      }
    }

    for (const prefix of PRIVATE_EVIDENCE_PREFIXES) {
      if (childRel.startsWith(prefix) && !EVIDENCE_KEEP_FILES.has(childRel)) {
        findings.push({ rel: childRel, kind: 'private_evidence', detail: prefix });
      }
    }
  }
  return findings;
}

async function main() {
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: 'missing_target', target: root, detail: String(err?.message || err) }));
    process.exitCode = 1;
    return;
  }
  if (!stat.isDirectory()) {
    console.error(JSON.stringify({ ok: false, error: 'target_not_directory', target: root }));
    process.exitCode = 1;
    return;
  }

  const findings = await walk(root);
  const groups = {};
  for (const finding of findings) {
    if (!groups[finding.kind]) groups[finding.kind] = [];
    groups[finding.kind].push(finding.rel);
  }

  const ok = findings.length === 0;
  const result = {
    ok,
    audited_root: root,
    finding_count: findings.length,
    findings_by_kind: groups,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: 'audit_failed', detail: String(err?.message || err) }));
  process.exitCode = 1;
});
