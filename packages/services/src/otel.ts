import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export interface OtelOptions {
  readonly serviceName: string;
  readonly otlpEndpoint?: string;
  readonly enabled?: boolean;
}

export interface OtelHandle {
  readonly shutdown: () => Promise<void>;
}

/**
 * Wires OpenTelemetry NodeSDK with the OTLP HTTP exporter and standard
 * auto-instrumentations. No-op when `enabled` is false (default: derived
 * from OTEL_EXPORTER_OTLP_ENDPOINT being set).
 *
 * Call this once at app boot, before importing any code you want traced.
 */
export const startOtel = (opts: OtelOptions): OtelHandle => {
  const endpoint = opts.otlpEndpoint ?? process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const enabled = opts.enabled ?? Boolean(endpoint);

  if (!enabled) {
    return { shutdown: async () => {} };
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.serviceName,
    }),
    traceExporter: new OTLPTraceExporter(
      endpoint ? { url: `${endpoint}/v1/traces` } : {},
    ),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  return {
    shutdown: () => sdk.shutdown(),
  };
};
