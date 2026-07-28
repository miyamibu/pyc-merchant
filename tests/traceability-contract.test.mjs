import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("PR1-PR14 and all 40 audit scenarios remain traceable", () => {
  const document = readFileSync(resolve(process.cwd(), "docs/qa/pr1-pr14-traceability.md"), "utf8");
  for (let index = 1; index <= 14; index += 1) {
    assert.match(document, new RegExp(`\\| PR${index} \\|`));
  }
  for (let index = 1; index <= 40; index += 1) {
    assert.match(document, new RegExp(`\\| ${index} \\|`));
  }
  assert.match(document, /release_decision: `NO_GO`/);
  assert.match(document, /UNVERIFIED/);
  assert.match(document, /BLOCKED_EXTERNAL/);
});
