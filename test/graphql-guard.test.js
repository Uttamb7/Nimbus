import test from "node:test";
import assert from "node:assert/strict";
import { inspectQuery, RateLimiter } from "../src/graphql-guard.js";

test("GraphQL limits depth, complexity, and request rate", () => {
  assert.deepEqual(inspectQuery("{ services { name metrics { p95LatencyMs } } }"), { depth: 3, complexity: 4 });
  assert.throws(() => inspectQuery("{ services { metrics { requestCount } } }", { maxDepth: 2 }), /depth/);
  assert.throws(() => inspectQuery("{ services { name health } }", { maxComplexity: 2 }), /complexity/);
  let now = 100;
  const limiter = new RateLimiter(2, 10, () => now);
  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), false);
  now = 111;
  assert.equal(limiter.allow("client"), true);
});
