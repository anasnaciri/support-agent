import { describe, expect, it } from "vitest";
import { startOtel } from "../src/otel.js";

describe("startOtel", () => {
  it("returns a no-op handle when disabled", async () => {
    const handle = startOtel({
      serviceName: "test-service",
      enabled: false,
    });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("returns a no-op handle when no endpoint is configured", async () => {
    const original = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    try {
      const handle = startOtel({ serviceName: "test-service" });
      await expect(handle.shutdown()).resolves.toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = original;
      }
    }
  });
});
