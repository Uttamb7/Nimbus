import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deploy } from "../scripts/deploy.js";

const digest = (character) => `ghcr.io/uttamb7/nimbus@sha256:${character.repeat(64)}`;
const report = () => ({
  decision: "PASS",
  reasons: [],
  cleanupErrors: [],
  images: { stable: { digest: digest("a") }, candidate: { digest: digest("b") } },
});

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), "nimbus-deploy-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, journal: join(directory, "deployment.json") };
}

test("local deployment applies the verified candidate and records its lifecycle", (t) => {
  const { journal } = workspace(t);
  const calls = [];
  const result = deploy(report(), {
    journalPath: journal,
    composeFile: "base.yaml",
    id: "deployment",
    now: () => "2026-11-27T12:00:00.000Z",
    runCompose: (compose, override) => {
      calls.push({ compose, override, contents: readFileSync(override, "utf8") });
      return { status: 0 };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.journal.transitions.map(({ status }) => status), [
    "PREPARING", "DEPLOYING", "SUCCEEDED",
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].compose, "base.yaml");
  assert.match(calls[0].contents, new RegExp(digest("b")));
  assert.equal(existsSync(calls[0].override), false);
  assert.equal(JSON.parse(readFileSync(journal, "utf8")).status, "SUCCEEDED");
});

test("failed candidate deployment restores the verified stable image", (t) => {
  const { journal } = workspace(t);
  const images = [];
  const result = deploy(report(), {
    journalPath: journal,
    runCompose: (compose, override) => {
      images.push(readFileSync(override, "utf8"));
      return { status: images.length === 1 ? 1 : 0 };
    },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.journal.transitions.map(({ status }) => status), [
    "PREPARING", "DEPLOYING", "ROLLING_BACK", "ROLLED_BACK",
  ]);
  assert.match(images[0], new RegExp(digest("b")));
  assert.match(images[1], new RegExp(digest("a")));
  assert.equal(JSON.parse(readFileSync(journal, "utf8")).status, "ROLLED_BACK");
});

test("failed rollback is retained as a terminal deployment failure", (t) => {
  const { journal } = workspace(t);
  let calls = 0;
  const result = deploy(report(), {
    journalPath: journal,
    runCompose: () => { calls += 1; return { status: 1 }; },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(calls, 2);
  assert.equal(result.journal.status, "FAILED");
  assert.match(result.journal.transitions.at(-1).reason, /rollback/);
});

test("invalid reports fail before Compose or journal writes", (t) => {
  const { journal } = workspace(t);
  let calls = 0;
  for (const invalid of [
    { ...report(), decision: "FAIL" },
    { ...report(), images: { ...report().images, stable: { digest: "invalid" } } },
    { ...report(), images: { ...report().images, candidate: { digest: `ghcr.io/uttamb7/nimbus:${"c".repeat(40)}` } } },
  ]) {
    assert.throws(() => deploy(invalid, {
      journalPath: journal,
      runCompose: () => { calls += 1; return { status: 0 }; },
    }));
  }
  assert.equal(calls, 0);
  assert.equal(existsSync(journal), false);
});
