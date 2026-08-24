import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";

test("Node child processes inherit the exact parent runtime binary", async () => {
  const childVersion = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--print", "process.version"],
      { env: { ...process.env, PATH: "/usr/bin:/bin" } },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout || "").trim());
      },
    );
  });

  assert.equal(childVersion, process.version);
});
