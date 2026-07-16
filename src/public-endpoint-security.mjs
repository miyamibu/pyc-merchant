import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const MAX_RESPONSE_BYTES = 1_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4ToInteger(value) {
  const octets = String(value).split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function parseIpv6(value) {
  let raw = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (raw.includes("%")) raw = raw.split("%", 1)[0];
  const mappedIpv4 = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mappedIpv4) return { mappedIpv4: mappedIpv4[1] };
  if (!raw.includes("::") && raw.split(":").length !== 8) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  return groups.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
}

function ipv6InRange(value, prefix, bits) {
  const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
  return (value & mask) === (bits & mask);
}

export function isPublicIp(value) {
  const raw = String(value || "").trim().replace(/^\[|\]$/g, "");
  const family = net.isIP(raw);
  if (family === 4) {
    const integer = ipv4ToInteger(raw);
    if (integer == null) return false;
    const inRange = (start, end) => integer >= start && integer <= end;
    return ![
      [0x00000000, 0x00ffffff], // 0.0.0.0/8
      [0x0a000000, 0x0affffff], // RFC1918
      [0x64400000, 0x647fffff], // CGNAT
      [0x7f000000, 0x7fffffff], // loopback
      [0xa9fe0000, 0xa9feffff], // link-local
      [0xac100000, 0xac1fffff], // RFC1918
      [0xc0000000, 0xc00000ff], // IETF protocol assignments
      [0xc0000200, 0xc00002ff], // TEST-NET-1
      [0xc0a80000, 0xc0a8ffff], // RFC1918
      [0xc6120000, 0xc613ffff], // benchmark testing
      [0xc6336400, 0xc63364ff], // TEST-NET-2
      [0xcb007100, 0xcb0071ff], // TEST-NET-3
      [0xe0000000, 0xffffffff], // multicast/reserved
    ].some(([start, end]) => inRange(start, end));
  }
  if (family !== 6) return false;
  const parsed = parseIpv6(raw);
  if (!parsed) return false;
  // Reject all IPv4-embedded/transition IPv6 forms.  Unwrapping only the
  // familiar ::ffff:d.d.d.d spelling is insufficient because the same
  // address can be represented as ::ffff:0a00:0001, NAT64, 6to4, or Teredo.
  if (parsed.mappedIpv4) return false;
  return ![
    [0, 128], // unspecified
    [1, 128], // loopback
    [0x00000000000000000000ffff00000000n, 96], // IPv4-mapped
    [0x0064ff9b000000000000000000000000n, 96], // NAT64 well-known prefix
    [0x0064ff9b000100000000000000000000n, 48], // NAT64 local-use prefix
    [0x20020000000000000000000000000000n, 16], // 6to4
    [0x20010000000000000000000000000000n, 32], // Teredo
    [0x00000000000000000000000000000000n, 96], // IPv4-compatible / ::/96
    [0x01000000000000000000000000000000n, 8], // discard-only / special use
    [0x20010001000000000000000000000000n, 32], // IETF protocol assignments
    [0x20010002000000000000000000000000n, 48], // benchmarking
    [0xfc000000000000000000000000000000n, 7], // unique local
    [0xfe800000000000000000000000000000n, 10], // link-local
    [0x20010020000000000000000000000000n, 28], // ORCHIDv2 / special-use block
    [0x20010db8000000000000000000000000n, 32], // documentation
    [0xff000000000000000000000000000000n, 8], // multicast
  ].some(([bits, prefix]) => ipv6InRange(parsed, prefix, BigInt(bits)));
}

export function normalizePublicHostname(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!raw || net.isIP(raw) || !raw.includes(".")) return "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(raw)) return "";
  if (["localhost", "local", "test", "invalid", "example", "arpa"].some((suffix) => raw === suffix || raw.endsWith(`.${suffix}`))) return "";
  if (["example.com", "example.org", "example.net"].some((suffix) => raw === suffix || raw.endsWith(`.${suffix}`))) return "";
  return raw;
}

export function validatePublicHttpsUrl(raw, { baseUrl = null, expectedHostname = null } = {}) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""), baseUrl || undefined);
  } catch {
    return { ok: false, errors: ["invalid_url"], url: null, hostname: "" };
  }
  const hostname = normalizePublicHostname(parsed.hostname);
  const errors = [];
  if (parsed.protocol !== "https:") errors.push("https_required");
  if (parsed.port && parsed.port !== "443") errors.push("https_port_must_be_443");
  if (parsed.username || parsed.password) errors.push("credentials_forbidden");
  if (!hostname) errors.push("public_hostname_required");
  if (expectedHostname && hostname !== normalizePublicHostname(expectedHostname)) errors.push("redirect_hostname_mismatch");
  return { ok: errors.length === 0, errors, url: parsed, hostname };
}

export async function resolvePublicHostAddresses(hostname, { lookup = dns.lookup } = {}) {
  const normalized = normalizePublicHostname(hostname);
  if (!normalized) throw new Error("public hostname is invalid");
  const result = await lookup(normalized, { all: true, verbatim: true });
  const addresses = [...new Set((Array.isArray(result) ? result : [result]).map((entry) => String(entry?.address || entry || "").trim()).filter(Boolean))];
  if (addresses.length === 0) throw new Error("public hostname did not resolve");
  const privateAddresses = addresses.filter((address) => !isPublicIp(address));
  if (privateAddresses.length > 0) throw new Error(`public hostname resolved to private or reserved IP: ${privateAddresses.join(",")}`);
  return addresses;
}

export function createPinnedLookup(hostname, addresses) {
  const normalized = normalizePublicHostname(hostname);
  const pinned = [...new Set((addresses || []).map((address) => String(address || "").trim()).filter(isPublicIp))];
  if (!normalized || pinned.length === 0) throw new Error("pinned public lookup requires a public hostname and address");
  return (lookupHostname, options, callback) => {
    if (normalizePublicHostname(lookupHostname) !== normalized) {
      callback(new Error("pinned lookup hostname mismatch"));
      return;
    }
    const requestedFamily = Number(options?.family || 0);
    const selected = pinned.find((address) => requestedFamily === 0 || net.isIP(address) === requestedFamily);
    if (!selected) {
      callback(new Error("pinned lookup has no address for requested family"));
      return;
    }
    callback(null, selected, net.isIP(selected));
  };
}

function requestPinnedHttps(url, { addresses, lookup, headers, method, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request(parsed, {
      method,
      headers,
      lookup: createPinnedLookup(parsed.hostname, addresses),
      servername: parsed.hostname,
      rejectUnauthorized: true,
      timeout: timeoutMs,
    }, (response) => {
      response.on("error", reject);
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else response.destroy(new Error("response_too_large"));
      });
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        url: parsed.href,
      }));
    });
    request.on("timeout", () => request.destroy(new Error("request_timeout")));
    request.on("error", reject);
    if (body != null) request.write(body);
    request.end();
  });
}

export async function fetchPinnedPublicHttps(rawUrl, {
  headers = {},
  method = "GET",
  body = null,
  maxRedirects = 3,
  timeoutMs = 10_000,
  expectedHostname = null,
  lookup = dns.lookup,
} = {}) {
  let current = String(rawUrl || "");
  let initialHostname = null;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const validation = validatePublicHttpsUrl(current, {
      expectedHostname: initialHostname || expectedHostname,
    });
    if (!validation.ok) throw new Error(`public endpoint rejected: ${validation.errors.join(",")}`);
    if (!initialHostname) initialHostname = validation.hostname;
    const addresses = await resolvePublicHostAddresses(validation.hostname, { lookup });
    const result = await requestPinnedHttps(validation.url.href, {
      addresses,
      headers: { ...headers, host: validation.hostname },
      method,
      body,
      timeoutMs,
    });
    if (!REDIRECT_STATUSES.has(result.status)) return { ...result, addresses };
    const location = result.headers.location;
    if (!location) throw new Error("redirect_missing_location");
    if (redirectCount >= maxRedirects) throw new Error("redirect_limit_exceeded");
    current = new URL(location, validation.url).href;
  }
  throw new Error("redirect_limit_exceeded");
}
