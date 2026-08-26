import test from "node:test";
import assert from "node:assert/strict";
import {
  createPinnedLookup,
  fetchPinnedPublicHttps,
  isPublicIp,
  normalizePublicHostname,
  resolvePublicHostAddresses,
  validatePublicHttpsUrl,
} from "../src/public-endpoint-security.mjs";

test("public endpoint security rejects private, reserved, and mapped-private addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.10.20",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "198.51.100.10",
    "203.0.113.10",
    "::",
    "::1",
    "::ffff:192.168.1.1",
    "::ffff:a00:1",
    "::ffff:7f00:1",
    "::ffff:1.1.1.1",
    "64:ff9b::a00:1",
    "2002:0a00:0001::1",
    "2001:0000:4136:e378::1",
    // RFC 2928 2001::/23 special-purpose sub-blocks that must never classify
    // as public: benchmarking, AMT, AS112-v6, IETF protocol assignments,
    // ORCHIDv2.
    "2001:2::11",
    "2001:3::11",
    "2001:4::11",
    "2001:10::1",
    "2001:10::dead:beef",
    "2001:20::1",
    // SRv6 special-purpose prefix (RFC 9602).
    "5f00::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "ff02::1",
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
    assert.equal(isPublicIp(address), true, address);
  }
  // Globally-routable 2001:… allocations outside the special-purpose /23 must
  // stay public (guard against over-blocking real hosts).
  assert.equal(isPublicIp("2001:4860:4860::8888"), true, "2001:4860:4860::8888");
});

test("public endpoint URL validation requires HTTPS and a real public hostname", async () => {
  assert.equal(normalizePublicHostname(" PAY.MIYAMIBU.XYZ. "), "pay.miyamibu.xyz");
  assert.equal(normalizePublicHostname("localhost"), "");
  assert.equal(normalizePublicHostname("127.0.0.1"), "");

  const valid = validatePublicHttpsUrl("https://pay.miyamibu.xyz/healthz");
  assert.equal(valid.ok, true);
  assert.equal(valid.hostname, "pay.miyamibu.xyz");

  assert.equal(validatePublicHttpsUrl("http://pay.miyamibu.xyz/healthz").ok, false);
  assert.equal(validatePublicHttpsUrl("https://user:pass@pay.miyamibu.xyz/healthz").ok, false);
  assert.equal(validatePublicHttpsUrl("https://127.0.0.1/healthz").ok, false);
  assert.equal(validatePublicHttpsUrl("https://pay.miyamibu.xyz:8443/healthz").ok, false);
  assert.equal(
    validatePublicHttpsUrl("https://internal.example.net/healthz", { expectedHostname: "pay.miyamibu.xyz" }).ok,
    false,
  );
  await assert.rejects(
    fetchPinnedPublicHttps("https://other.miyamibu.xyz/healthz", {
      expectedHostname: "pay.miyamibu.xyz",
      lookup: async () => [{ address: "1.1.1.1" }],
    }),
    /redirect_hostname_mismatch/,
  );
});

test("DNS resolution is checked and mixed public/private results fail closed", async () => {
  const lookup = async (hostname, options) => {
    assert.equal(hostname, "pay.miyamibu.xyz");
    assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  };
  assert.deepEqual(
    await resolvePublicHostAddresses("pay.miyamibu.xyz", { lookup }),
    ["1.1.1.1", "2606:4700:4700::1111"],
  );

  await assert.rejects(
    resolvePublicHostAddresses("pay.miyamibu.xyz", {
      lookup: async () => [{ address: "1.1.1.1" }, { address: "192.168.1.20" }],
    }),
    /private or reserved IP/,
  );
  await assert.rejects(
    resolvePublicHostAddresses("pay.miyamibu.xyz", { lookup: async () => [] }),
    /did not resolve/,
  );
});

test("pinned lookup only serves the previously validated host and public addresses", () => {
  const lookup = createPinnedLookup("pay.miyamibu.xyz", ["1.1.1.1", "2606:4700:4700::1111"]);
  lookup("pay.miyamibu.xyz", { family: 4 }, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "1.1.1.1");
    assert.equal(family, 4);
  });
  lookup("pay.miyamibu.xyz", { family: 6 }, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "2606:4700:4700::1111");
    assert.equal(family, 6);
  });
  lookup("other.miyamibu.xyz", { family: 4 }, (error) => {
    assert.match(error?.message || "", /hostname mismatch/);
  });
});
