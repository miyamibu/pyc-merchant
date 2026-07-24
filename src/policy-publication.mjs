export const POLICY_URL_KEYS = Object.freeze(["terms", "privacy", "refund"]);
export const POLICY_VERSION_KEYS = Object.freeze(["terms_version", "privacy_version", "refund_policy_version"]);

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
