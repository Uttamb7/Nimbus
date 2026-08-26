FROM otel/opentelemetry-collector:0.158.0 AS collector
FROM alpine:3.22
RUN addgroup -S otel && adduser -S -G otel otel
COPY --from=collector /otelcol /otelcol
COPY otel-collector.yaml /etc/otelcol/config.yaml
USER otel
ENTRYPOINT ["/otelcol"]
CMD ["--config=/etc/otelcol/config.yaml"]
