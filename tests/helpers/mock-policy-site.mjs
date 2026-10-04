// Test-only HTTPS/DNS transport. No public Site or external DNS is contacted.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { POLICY_DOCUMENT_HEADERS, renderPolicyDocument } from "../../sites/jpyc-public-info/app/policy-document.mjs";

const originalLookup = dns.lookup;
const originalRequest = https.request;
dns.lookup = async (host, options) => host === "miyamibu.xyz"
  ? [{ address: "1.1.1.1", family: 4 }]
  : originalLookup(host, options);
https.request = (url, options, callback) => {
  if (url.hostname !== "miyamibu.xyz") return originalRequest(url, options, callback);
  const request = new EventEmitter();
  request.write = () => {};
  request.destroy = (error) => { if (error) request.emit("error", error); request.emit("close"); };
  request.end = () => queueMicrotask(() => {
    options.lookup(url.hostname, { family: 4 }, (error, address) => {
      if (error || address !== "1.1.1.1") return request.destroy(error || new Error("unpinned fixture request"));
      const key = url.pathname === "/refund-policy" ? "refund" : url.pathname.slice(1);
      const contents = JSON.parse(readFileSync(process.env.POLICY_SITE_FIXTURE_PATH, "utf8"));
      const content = contents[key];
      const response = new PassThrough();
      response.statusCode = typeof content === "string" ? 200 : 404;
      response.headers = POLICY_DOCUMENT_HEADERS;
      callback(response);
      let html = typeof content === "string" ? renderPolicyDocument(content) : "missing";
      if (contents.$markerOverrides?.[key]) html = html.replace(createHash("sha256").update(content).digest("hex"), contents.$markerOverrides[key]);
      if (contents.$htmlOverrides?.[key]) html = contents.$htmlOverrides[key];
      response.end(html);
      response.on("end", () => request.emit("close"));
    });
  });
  return request;
};
