import { ROOT_CONTEXT, context, propagation, trace } from "@opentelemetry/api";

export function currentTraceContext() {
  const carrier = {};
  propagation.inject(context.active(), carrier);
  return Object.fromEntries(["traceparent", "tracestate"].filter((key) => carrier[key]).map((key) => [key, carrier[key]]));
}

export function continueTrace(carrier, task) {
  return context.with(propagation.extract(ROOT_CONTEXT, carrier || {}), task);
}

export function annotateTrace(attributes) {
  trace.getActiveSpan()?.setAttributes(Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)));
}

export async function startTracing() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  process.env.OTEL_SERVICE_NAME ||= process.env.SERVICE_NAME;
  const [
    { NodeTracerProvider },
    { BatchSpanProcessor },
    { resourceFromAttributes },
    { registerInstrumentations },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { UndiciInstrumentation },
    { AmqplibInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/instrumentation"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-amqplib"),
  ]);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => ["/health", "/observe"].includes(request.url) }),
      new UndiciInstrumentation({ ignoreRequestHook: (request) => ["/health", "/observe"].includes(request.path) }),
      new AmqplibInstrumentation(),
    ],
  });
  process.once("beforeExit", () => provider.shutdown());
  return provider;
}
