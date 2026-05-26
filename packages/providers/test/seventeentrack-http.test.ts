import { describe, expect, it, vi } from "vitest";
import {
  SeventeenTrackHttpError,
  seventeenTrackGetInfo,
  seventeenTrackRegister,
} from "../src/seventeentrack-http.js";

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const fail = (status: number, body = ""): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: new Headers(),
  }) as unknown as Response;

describe("seventeenTrackRegister", () => {
  it("POSTs the tracking number + carrier hint to /track/v2.2/register", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://api.17track.net/track/v2.2/register");
      expect((init?.headers as Record<string, string>)["17token"]).toBe("k1");
      const body = JSON.parse(String(init?.body ?? "[]"));
      expect(body).toEqual([{ number: "1Z999", carrier: "UPS" }]);
      return okJson({ code: 0, data: { accepted: [{ number: "1Z999" }] } });
    });
    await seventeenTrackRegister({
      apiKey: "k1",
      trackingNumber: "1Z999",
      carrier: "UPS",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("omits carrier when null", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "[]"));
      expect(body).toEqual([{ number: "1Z999" }]);
      return okJson({});
    });
    await seventeenTrackRegister({
      apiKey: "k1",
      trackingNumber: "1Z999",
      carrier: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  });
});

describe("seventeenTrackGetInfo", () => {
  it("returns parsed status when the API includes an `accepted` entry", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        code: 0,
        data: {
          accepted: [
            {
              number: "1Z999",
              carrier: 100002,
              track: { e: 40 },
              track_info: {
                latest_event: {
                  time_iso: "2026-05-23T12:00:00.000Z",
                  location: "Brooklyn, NY",
                  description: "Delivered, front porch",
                },
                estimated_delivery_date: {
                  source: "carrier",
                  from: "2026-05-22",
                  to: "2026-05-24",
                },
              },
            },
          ],
          rejected: [],
        },
      }),
    );
    const info = await seventeenTrackGetInfo({
      apiKey: "k1",
      trackingNumber: "1Z999",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.carrier).toBe("100002");
    expect(info.status).toBe("delivered");
    expect(info.lastScan?.location).toBe("Brooklyn, NY");
    expect(info.lastScan?.description).toContain("Delivered");
    expect(info.estimatedDeliveryAt?.toISOString()).toBe(
      "2026-05-24T00:00:00.000Z",
    );
  });

  it("returns null when the API rejects the number (unsupported carrier)", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        code: 0,
        data: {
          accepted: [],
          rejected: [{ number: "EXOTIC-1", error: { code: -1, message: "..." } }],
        },
      }),
    );
    const info = await seventeenTrackGetInfo({
      apiKey: "k1",
      trackingNumber: "EXOTIC-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(info).toBeNull();
  });

  it("maps in-transit numeric code 30 to 'in_transit'", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        code: 0,
        data: {
          accepted: [
            {
              number: "1Z999",
              carrier: 100002,
              track: { e: 30 },
            },
          ],
        },
      }),
    );
    const info = await seventeenTrackGetInfo({
      apiKey: "k1",
      trackingNumber: "1Z999",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(info?.status).toBe("in_transit");
  });

  it("maps 401 to SeventeenTrackHttpError with kind auth_failed", async () => {
    const fetchImpl = vi.fn(async () => fail(401, "unauthorized"));
    await expect(
      seventeenTrackGetInfo({
        apiKey: "bad",
        trackingNumber: "1Z999",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ failure: { kind: "auth_failed", status: 401 } });
  });

  it("maps 429 to rate_limited with retryAfter parsed from header", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => "",
        headers: new Headers({ "retry-after": "12" }),
      }) as unknown as Response,
    );
    await expect(
      seventeenTrackGetInfo({
        apiKey: "k1",
        trackingNumber: "1Z999",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "rate_limited", retryAfterMs: 12_000 },
    });
  });

  it("maps 500 to network failure", async () => {
    const fetchImpl = vi.fn(async () => fail(500, "internal"));
    try {
      await seventeenTrackGetInfo({
        apiKey: "k1",
        trackingNumber: "1Z999",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SeventeenTrackHttpError);
      if (e instanceof SeventeenTrackHttpError) {
        expect(e.failure.kind).toBe("network");
      }
    }
  });
});
