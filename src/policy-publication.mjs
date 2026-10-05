import crypto from "node:crypto";
import { fetchPinnedPublicHttps, validatePublicHttpsUrl } from "./public-endpoint-security.mjs";
import {
  extractPolicyDocumentContent,
  POLICY_DOCUMENT_HEADERS,
  parsePolicyDocumentContent,
  isPolicyDocumentVersion,
} from "../sites/jpyc-public-info/app/policy-document.mjs";
export { POLICY_DOCUMENT_CONTRACT } from "../sites/jpyc-public-info/app/policy-document.mjs";

export const POLICY_URL_KEYS = Object.freeze(["terms", "privacy", "refund"]);
export const POLICY_VERSION_KEYS = Object.freeze(["terms_version", "privacy_version", "refund_policy_version"]);
export const POLICY_CONTENT_HASH_CANONICALIZATION = "sha256_utf8_exact_bytes_v1";
export const POLICY_CONTENT_HASH_KEYS = Object.freeze({
  terms: "terms_hash",
  privacy: "privacy_hash",
  refund: "refund_policy_hash",
});

export function isPublicPolicyHostname(value) {
  const host = String(value || "").trim().toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (!host || !host.includes(".")) return false;
  if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".test")
    || host.endsWith(".invalid")
    || host.endsWith(".example")
    || host.endsWith(".arpa")
  ) return false;
  return !["example.com", "example.org", "example.net"].some(
    (reservedHost) => host === reservedHost || host.endsWith(`.${reservedHost}`)
  );
}

export function isPublishedPolicyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && isPublicPolicyHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isPublishedPolicyVersion(value) {
  const version = String(value || "").trim();
  return Boolean(version) && !/(?:draft|pending|placeholder|example)/i.test(version);
}

export function isPublishedPolicyHash(value) {
  return /^[0-9a-f]{64}$/i.test(String(value || "").trim());
}

export function hashPolicyContent(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function verifyPolicyContentHashes(contents, hashes) {
  const submittedContents = contents && typeof contents === "object" && !Array.isArray(contents)
    ? contents
    : {};
  const submittedHashes = hashes && typeof hashes === "object" && !Array.isArray(hashes)
    ? hashes
    : {};
  const missingContentKeys = POLICY_URL_KEYS.filter(
    (key) => typeof submittedContents[key] !== "string" || !submittedContents[key].trim()
  );
  const computedHashes = {};
  const mismatchHashKeys = [];
  for (const key of POLICY_URL_KEYS) {
    const hashKey = POLICY_CONTENT_HASH_KEYS[key];
    const computed = hashPolicyContent(submittedContents[key]);
    computedHashes[hashKey] = computed;
    if (computed && computed !== String(submittedHashes[hashKey] || "").trim().toLowerCase()) {
      mismatchHashKeys.push(hashKey);
    }
  }
  return {
    ok: missingContentKeys.length === 0 && mismatchHashKeys.length === 0,
    canonicalization: POLICY_CONTENT_HASH_CANONICALIZATION,
    computed_hashes: computedHashes,
    missing_content_keys: missingContentKeys,
    mismatch_hash_keys: mismatchHashKeys,
  };
}

// Kept for callers of the previous candidate. Only a complete contract-v3
// document is accepted; this function no longer parses arbitrary visible HTML.
export const extractVisiblePolicyContent = extractPolicyDocumentContent;

export async function fetchPublishedPolicyPage(url) {
  const result = await fetchPinnedPublicHttps(url, {
    headers: { accept: "text/html", "accept-encoding": "identity", "cache-control": "no-cache" },
    maxRedirects: 0,
    timeoutMs: 3500,
    maxResponseBytes: 256_000,
  });
  return new Response(result.bodyBytes, { status: result.status, headers: result.headers });
}

export async function verifyPublishedPolicyPages(urls, hashes, { expectedVersions, fetchImpl = fetchPublishedPolicyPage } = {}) {
  const mismatchKeys = [];
  const unavailableKeys = [];
  const versionMismatchKeys = [];
  for (const key of POLICY_URL_KEYS) {
    const url = urls?.[key];
    const expected = String(hashes?.[POLICY_CONTENT_HASH_KEYS[key]] || "").toLowerCase();
    const expectedVersion = expectedVersions?.[key === "refund" ? "refund_policy_version" : `${key}_version`];
    // The consent caller also requires exact equality with its configured Site
    // origin and paths. Static hostname syntax alone never authorizes a socket.
    if (!isPublishedPolicyUrl(url) || !validatePublicHttpsUrl(url).ok || !isPublishedPolicyHash(expected)
      || !isPolicyDocumentVersion(expectedVersion)) {
      unavailableKeys.push(key);
      continue;
    }
    try {
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(3500) });
      if (response.status !== 200
        || response.headers.get("content-type") !== POLICY_DOCUMENT_HEADERS["content-type"]
        || response.headers.get("content-security-policy") !== POLICY_DOCUMENT_HEADERS["content-security-policy"]
        || response.headers.get("x-content-type-options") !== "nosniff"
        || response.headers.get("cache-control") !== "no-store"
        || response.headers.has("refresh") || response.headers.has("location")
        || response.headers.has("content-disposition") || response.headers.has("content-encoding")) {
        unavailableKeys.push(key);
        continue;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 256_000) throw new Error("policy page too large");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const content = extractPolicyDocumentContent(html);
      if (!content) unavailableKeys.push(key);
      else if (hashPolicyContent(content) !== expected) mismatchKeys.push(key);
      else if (parsePolicyDocumentContent(content).version !== expectedVersion) versionMismatchKeys.push(key);
    } catch {
      unavailableKeys.push(key);
    }
  }
  return { ok: mismatchKeys.length === 0 && unavailableKeys.length === 0 && versionMismatchKeys.length === 0,
    mismatch_keys: mismatchKeys, unavailable_keys: unavailableKeys, version_mismatch_keys: versionMismatchKeys };
}

export function extractPolicyObjectValues(content, constantName, requiredKeys) {
  const values = Object.fromEntries(requiredKeys.map((key) => [key, ""]));
  const blockMatch = String(content || "").match(new RegExp(`const\\s+${constantName}\\s*=\\s*\\{([\\s\\S]*?)\\};`, "m"));
  if (!blockMatch) return values;
  const pairRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*["'`]([^"'`]*)["'`]/g;
  for (const match of blockMatch[1].matchAll(pairRegex)) {
    if (Object.hasOwn(values, match[1])) values[match[1]] = String(match[2] || "").trim();
  }
  return values;
}

export function evaluatePolicyPublicationSource(content, { sourcePath = null } = {}) {
  const values = extractPolicyObjectValues(content, "POLICY_URLS", POLICY_URL_KEYS);
  const versions = extractPolicyObjectValues(content, "POLICY_VERSIONS", POLICY_VERSION_KEYS);
  const missingKeys = POLICY_URL_KEYS.filter((key) => !isPublishedPolicyUrl(values[key]));
  const missingVersionKeys = POLICY_VERSION_KEYS.filter((key) => !isPublishedPolicyVersion(versions[key]));
  return {
    ok: missingKeys.length === 0 && missingVersionKeys.length === 0,
    source_path: sourcePath,
    values,
    versions,
    missing_keys: missingKeys,
    missing_version_keys: missingVersionKeys,
    errors: [
      ...missingKeys.map((key) => `POLICY_URLS.${key} must be a production https URL`),
      ...missingVersionKeys.map((key) => `POLICY_VERSIONS.${key} must be a published non-placeholder version`),
    ],
  };
}

export function unavailablePolicyPublication({ sourcePath = null, message = "policy source could not be read" } = {}) {
  return {
    ok: false,
    source_path: sourcePath,
    values: Object.fromEntries(POLICY_URL_KEYS.map((key) => [key, ""])),
    versions: Object.fromEntries(POLICY_VERSION_KEYS.map((key) => [key, ""])),
    missing_keys: [...POLICY_URL_KEYS],
    missing_version_keys: [...POLICY_VERSION_KEYS],
    errors: [message],
  };
}

export function validatePolicyVersionSubmission(expectedVersions, body) {
  const isObject = Boolean(body) && typeof body === "object" && !Array.isArray(body);
  const submittedKeys = isObject ? Object.keys(body) : [];
  const missingKeys = POLICY_VERSION_KEYS.filter((key) => !isObject || !Object.hasOwn(body, key));
  const mismatchKeys = POLICY_VERSION_KEYS.filter(
    (key) => isObject && Object.hasOwn(body, key) && body[key] !== expectedVersions?.[key]
  );
  const unexpectedKeys = submittedKeys.filter((key) => !POLICY_VERSION_KEYS.includes(key));
  return {
    ok: missingKeys.length === 0 && mismatchKeys.length === 0 && unexpectedKeys.length === 0,
    missing_keys: missingKeys,
    mismatch_keys: mismatchKeys,
    unexpected_keys: unexpectedKeys,
  };
}
