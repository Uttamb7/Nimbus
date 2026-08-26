import test from "node:test";
import assert from "node:assert/strict";
import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { continueTrace, currentTraceContext } from "../src/tracing.js";

test("W3C context survives an asynchronous event boundary", async () => {
  const provider = new NodeTracerProvider();
  provider.register();
  const tracer = trace.getTracer("nimbus-test");

  await tracer.startActiveSpan("order accepted", async (span) => {
    const carrier = currentTraceContext();
    assert.match(carrier.traceparent, /^00-[\da-f]{32}-[\da-f]{16}-01$/);
    await continueTrace(carrier, async () => {
      assert.equal(trace.getSpan(context.active()).spanContext().traceId, span.spanContext().traceId);
    });
    span.end();
  });
  await provider.shutdown();
});
