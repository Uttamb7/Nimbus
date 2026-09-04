import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("console assets use live GraphQL data", async () => {
  const [html, script, styles] = await Promise.all([readFile("web/index.html", "utf8"), readFile("web/app.js", "utf8"), readFile("web/styles.css", "utf8")]);
  assert.match(html, /Nimbus Control/);
  assert.match(script, /serviceGraph/);
  assert.match(script, /injectFailure/);
  assert.match(script, /recentTraces/);
  assert.match(styles, /--critical/);
});
