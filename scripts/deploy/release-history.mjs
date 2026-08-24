#!/usr/bin/env node
// M-047: canonical release-history recording for rollback identity.
// JSONL append-only with strict validation. Fail-closed on any invalid line.

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..", "..");
const HISTORY_FILE = resolve(ROOT_DIR, "runtime", "deploy", "release-history.jsonl");

const COMMIT_REGEX = /^[0-9a-f]{40}$/;
const DIGEST_REGEX = /^([a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?\/)?([a-z0-9]+([._-][a-z0-9]+)*\/)*[a-z0-9]+([._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;
const RELEASE_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const ENVIRONMENT_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const SCHEMA_VERSION_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const EVENT_ID_REGEX = /^[0-9a-f]{16}$/;

const RELEASE_ALLOWED_FIELDS = new Set([
  "event_id", "event_type", "released_at", "release_id", "commit", "image_digest",
  "environment", "db_schema_version", "status"
]);

const ROLLBACK_ALLOWED_FIELDS = new Set([
  "event_id", "event_type", "released_at", "release_id", "commit", "image_digest",
  "environment", "db_schema_version", "status", "from_release_id", "to_release_id"
]);

function validateString(value, maxLen) {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLen;
}

function validateISOUTC(ts) {
  if (typeof ts !== "string") return false;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return false;
  return d.toISOString() === ts;
}

function generateEventId(existingIds) {
  const ids = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  let eventId;
  do {
    eventId = randomBytes(8).toString("hex");
  } while (ids.has(eventId));
  return eventId;
}

function validateRecord(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("record must be a plain object");
  }
  const required = ["event_id", "event_type", "released_at", "release_id", "commit", "image_digest", "environment", "status"];
  for (const key of required) {
    if (!(key in obj)) {
      throw new Error(`missing required field: ${key}`);
    }
  }
  if (!validateString(obj.event_id, 16) || !EVENT_ID_REGEX.test(obj.event_id)) {
    throw new Error(`invalid event_id format (must be 16 hex): ${obj.event_id}`);
  }
  if (obj.event_type !== "release" && obj.event_type !== "rollback") {
    throw new Error(`invalid event_type (must be release|rollback): ${obj.event_type}`);
  }
  const allowedFields = obj.event_type === "release" ? RELEASE_ALLOWED_FIELDS : ROLLBACK_ALLOWED_FIELDS;
  for (const key of Object.keys(obj)) {
    if (!allowedFields.has(key)) {
      throw new Error(`unknown field for ${obj.event_type}: ${key}`);
    }
  }
  if (obj.event_type === "release") {
    if (obj.from_release_id !== undefined && obj.from_release_id !== null && obj.from_release_id !== "") {
      throw new Error("release must not have from_release_id");
    }
    if (obj.to_release_id !== undefined && obj.to_release_id !== null && obj.to_release_id !== "") {
      throw new Error("release must not have to_release_id");
    }
  } else {
    if (obj.from_release_id === undefined || obj.from_release_id === null || obj.from_release_id === "") {
      throw new Error("rollback requires from_release_id");
    }
    if (obj.to_release_id === undefined || obj.to_release_id === null || obj.to_release_id === "") {
      throw new Error("rollback requires to_release_id");
    }
    if (obj.release_id !== obj.to_release_id) {
      throw new Error("rollback release_id must equal to_release_id");
    }
    if (obj.from_release_id === obj.to_release_id) {
      throw new Error("rollback from_release_id and to_release_id must differ");
    }
  }
  if (!validateISOUTC(obj.released_at)) {
    throw new Error(`invalid released_at (must be UTC ISO timestamp): ${obj.released_at}`);
  }
  if (!validateString(obj.release_id, 128) || !RELEASE_ID_REGEX.test(obj.release_id)) {
    throw new Error(`invalid release_id format: ${obj.release_id}`);
  }
  if (!validateString(obj.commit, 40) || !COMMIT_REGEX.test(obj.commit)) {
    throw new Error(`invalid commit format (must be 40 hex): ${obj.commit}`);
  }
  if (!validateString(obj.image_digest, 255) || !DIGEST_REGEX.test(obj.image_digest)) {
    throw new Error(`invalid image_digest format (must be name@sha256:64hex): ${obj.image_digest}`);
  }
  if (!validateString(obj.environment, 128) || !ENVIRONMENT_REGEX.test(obj.environment)) {
    throw new Error(`invalid environment format: ${obj.environment}`);
  }
  if (obj.db_schema_version !== undefined && obj.db_schema_version !== null && obj.db_schema_version !== "") {
    if (!validateString(obj.db_schema_version, 128) || !SCHEMA_VERSION_REGEX.test(obj.db_schema_version)) {
      throw new Error(`invalid db_schema_version format: ${obj.db_schema_version}`);
    }
  }
  if (obj.status !== "applied" && obj.status !== "failed") {
    throw new Error(`invalid status (must be applied|failed): ${obj.status}`);
  }
  if (obj.from_release_id !== undefined && obj.from_release_id !== null && obj.from_release_id !== "") {
    if (!validateString(obj.from_release_id, 128) || !RELEASE_ID_REGEX.test(obj.from_release_id)) {
      throw new Error(`invalid from_release_id format: ${obj.from_release_id}`);
    }
  }
  if (obj.to_release_id !== undefined && obj.to_release_id !== null && obj.to_release_id !== "") {
    if (!validateString(obj.to_release_id, 128) || !RELEASE_ID_REGEX.test(obj.to_release_id)) {
      throw new Error(`invalid to_release_id format: ${obj.to_release_id}`);
    }
  }
}

function loadHistory() {
  if (!existsSync(HISTORY_FILE)) {
    return [];
  }
  const content = readFileSync(HISTORY_FILE, "utf8");
  const lines = content.trim().split("\n").filter((line) => line.trim() !== "");
  const records = [];
  const seenEventIds = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`invalid JSON at line ${i + 1}: ${e.message}`);
    }
    validateRecord(parsed);
    if (seenEventIds.has(parsed.event_id)) {
      throw new Error(`duplicate event_id at line ${i + 1}: ${parsed.event_id}`);
    }
    seenEventIds.add(parsed.event_id);
    records.push(parsed);
  }
  const byRelease = new Map();
  for (const r of records) {
    if (r.status === "applied") {
      const key = r.release_id;
      if (!byRelease.has(key)) byRelease.set(key, []);
      byRelease.get(key).push(r);
    }
  }
  for (const [rel, arr] of byRelease) {
    if (arr.length > 1) {
      const first = arr[0];
      for (let j = 1; j < arr.length; j++) {
        const cur = arr[j];
        if (first.commit !== cur.commit || first.image_digest !== cur.image_digest || first.environment !== cur.environment || (first.db_schema_version || "") !== (cur.db_schema_version || "")) {
          throw new Error(`conflicting applied records for release_id: ${rel}`);
        }
      }
    }
  }
  return records;
}

function appendRecord(record) {
  const records = loadHistory();
  const existingIds = new Set(records.map(r => r.event_id));
  if (existingIds.has(record.event_id)) {
    throw new Error(`duplicate event_id: ${record.event_id}`);
  }
  validateRecord(record);
  const dir = dirname(HISTORY_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(HISTORY_FILE, JSON.stringify(record) + "\n", "utf8");
}

function recordCmd(args) {
  if (args.length !== 4 && args.length !== 5) {
    console.error("usage: record <release_id> <commit> <image_digest> <environment> [db_schema_version]");
    process.exit(2);
  }
  const [release_id, commit, image_digest, environment, db_schema_version] = args;
  const records = loadHistory();
  for (const r of records) {
    if (r.release_id === release_id && r.status === "applied") {
      if (r.commit === commit && r.image_digest === image_digest && r.environment === environment && (r.db_schema_version || "") === (db_schema_version || "")) {
        console.log(`already recorded: ${release_id}`);
        return;
      }
      console.error(`conflicting release_id in history: ${release_id}`);
      process.exit(1);
    }
  }
  const eventId = generateEventId(records.map(r => r.event_id));
  const record = {
    event_id: eventId,
    event_type: "release",
    released_at: new Date().toISOString(),
    release_id,
    commit,
    image_digest,
    environment,
    db_schema_version: db_schema_version || "",
    status: "applied",
  };
  appendRecord(record);
  console.log(`recorded: ${release_id}`);
}

function recordRollbackCmd(args) {
  if (args.length !== 8) {
    console.error("usage: record-rollback <release_id> <commit> <image_digest> <environment> <db_schema_version> <from_release_id> <to_release_id> <status>");
    process.exit(2);
  }
  const [release_id, commit, image_digest, environment, db_schema_version, from_release_id, to_release_id, status] = args;
  if (status !== "applied" && status !== "failed") {
    console.error("status must be applied or failed");
    process.exit(2);
  }
  if (release_id !== to_release_id) {
    console.error("release_id must equal to_release_id");
    process.exit(2);
  }
  if (from_release_id === to_release_id) {
    console.error("from_release_id and to_release_id must differ");
    process.exit(2);
  }
  const records = loadHistory();
  const applied = records.filter(r => r.status === "applied");
  if (applied.length === 0) {
    console.error("no applied release found to rollback from");
    process.exit(1);
  }
  const latestApplied = applied[applied.length - 1];
  if (latestApplied.release_id !== from_release_id) {
    console.error(`from_release_id ${from_release_id} does not match latest applied release_id ${latestApplied.release_id}`);
    process.exit(1);
  }
  const toMatches = applied.filter(r => r.release_id === to_release_id);
  if (toMatches.length === 0) {
    console.error(`to_release_id ${to_release_id} has no applied release in history`);
    process.exit(1);
  }
  const first = toMatches[0];
  if (first.commit !== commit || first.image_digest !== image_digest || first.environment !== environment || (first.db_schema_version || "") !== (db_schema_version || "")) {
    console.error(`to_release_id ${to_release_id} canonical identity mismatch`);
    process.exit(1);
  }
  const eventId = generateEventId(records.map(r => r.event_id));
  const record = {
    event_id: eventId,
    event_type: "rollback",
    released_at: new Date().toISOString(),
    release_id,
    commit,
    image_digest,
    environment,
    db_schema_version,
    status,
    from_release_id,
    to_release_id,
  };
  appendRecord(record);
  console.log(`recorded rollback: ${release_id}`);
}

function listCmd(args) {
  if (args.length > 1) {
    console.error("usage: list [count]");
    process.exit(2);
  }
  let count = 10;
  if (args[0]) {
    if (!/^[1-9][0-9]{0,2}$/.test(args[0]) && args[0] !== "1000") {
      console.error("invalid count");
      process.exit(2);
    }
    count = parseInt(args[0], 10);
  }
  const records = loadHistory();
  const toShow = records.slice(-count);
  for (const r of toShow) {
    console.log(JSON.stringify(r));
  }
}

function getCurrentCmd(args) {
  if (args.length > 0) {
    console.error("usage: current");
    process.exit(2);
  }
  const records = loadHistory();
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].status === "applied") {
      console.log(JSON.stringify(records[i]));
      return;
    }
  }
  console.log("no applied release found");
  process.exit(1);
}

function getPreviousCmd(args) {
  if (args.length > 0) {
    console.error("usage: previous");
    process.exit(2);
  }
  const records = loadHistory();
  const applied = records.filter(r => r.status === "applied");
  if (applied.length < 2) {
    console.log("no previous applied release found");
    process.exit(1);
  }
  console.log(JSON.stringify(applied[applied.length - 2]));
}

function findByReleaseIdCmd(args) {
  if (args.length !== 1) {
    console.error("usage: find <release_id>");
    process.exit(2);
  }
  const targetReleaseId = args[0];
  const records = loadHistory();
  const matches = records.filter(r => r.release_id === targetReleaseId && r.status === "applied");
  if (matches.length === 0) {
    console.log("not found");
    process.exit(1);
  }
  if (matches.length > 1) {
    const first = matches[0];
    for (let j = 1; j < matches.length; j++) {
      const cur = matches[j];
      if (first.commit !== cur.commit || first.image_digest !== cur.image_digest || first.environment !== cur.environment || (first.db_schema_version || "") !== (cur.db_schema_version || "")) {
        console.error(`conflicting records for release_id: ${targetReleaseId}`);
        process.exit(1);
      }
    }
  }
  console.log(JSON.stringify(matches[matches.length - 1]));
}

function validateHistoryCmd(args) {
  if (args.length > 0) {
    console.error("usage: validate");
    process.exit(2);
  }
  try {
    loadHistory();
    console.log("history valid");
  } catch (e) {
    console.error(`history invalid: ${e.message}`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  switch (cmd) {
    case "record":
      recordCmd(args.slice(1));
      break;
    case "record-rollback":
      recordRollbackCmd(args.slice(1));
      break;
    case "list":
      listCmd(args.slice(1));
      break;
    case "current":
      getCurrentCmd(args.slice(1));
      break;
    case "previous":
      getPreviousCmd(args.slice(1));
      break;
    case "find":
      findByReleaseIdCmd(args.slice(1));
      break;
    case "validate":
      validateHistoryCmd(args.slice(1));
      break;
    default:
      console.error("usage: release-history.mjs {record <release_id> <commit> <digest> <env> [schema] | record-rollback <release_id> <commit> <digest> <env> <schema> <from> <to> <status> | list [count] | current | previous | find <release_id> | validate}");
      process.exit(2);
  }
}

main();