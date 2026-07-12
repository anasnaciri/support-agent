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
      // Always request English event translations (lang defaults to "en").
      expect(body).toEqual([{ number: "1Z999", carrier: "UPS", lang: "en" }]);
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
      expect(body).toEqual([{ number: "1Z999", lang: "en" }]);
      return okJson({});
    });
    await seventeenTrackRegister({
      apiKey: "k1",
      trackingNumber: "1Z999",
      carrier: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  });

  it("honors an explicit lang override", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "[]"));
      expect(body).toEqual([{ number: "1Z999", lang: "fr" }]);
      return okJson({});
    });
    await seventeenTrackRegister({
      apiKey: "k1",
      trackingNumber: "1Z999",
      carrier: null,
      lang: "fr",
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

  it("parses origin/destination country, transit days, and the checkpoint list", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        code: 0,
        data: {
          accepted: [
            {
              number: "LULU1000509755",
              carrier: 190271,
              track_info: {
                shipping_info: {
                  shipper_address: { country: "China" },
                  recipient_address: { country: "United States" },
                },
                latest_status: { status: "InTransit" },
                latest_event: {
                  time_iso: "2026-05-27T08:32:00.000Z",
                  location: "China",
                  description: "Item in transit to destination",
                },
                time_metrics: { days_after_order: 49, days_of_transit: 49 },
                tracking: {
                  providers: [
                    {
                      events: [
                        {
                          time_iso: "2026-05-27T08:32:00.000Z",
                          location: "China",
                          description: "Item in transit to destination",
                        },
                        {
                          time_iso: "2026-05-10T03:00:00.000Z",
                          description: "Delayed for postage assessment",
                          address: { city: "Shenzhen", country: "China" },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      }),
    );
    const info = await seventeenTrackGetInfo({
      apiKey: "k1",
      trackingNumber: "LULU1000509755",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.status).toBe("in_transit");
    expect(info.originCountry).toBe("China");
    expect(info.destinationCountry).toBe("United States");
    expect(info.transitDays).toBe(49);
    expect(info.checkpoints).toHaveLength(2);
    expect(info.checkpoints[0]?.description).toBe(
      "Item in transit to destination",
    );
    // location falls back to a composed address when the flat field is absent
    expect(info.checkpoints[1]?.location).toBe("Shenzhen, China");
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

  it("throws sync_pending when 17track has no accepted or rejected row yet", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        code: 0,
        data: {
          accepted: [],
          rejected: [],
        },
      }),
    );
    await expect(
      seventeenTrackGetInfo({
        apiKey: "k1",
        trackingNumber: "LULU1000630903",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "sync_pending",
        trackingNumber: "LULU1000630903",
      },
    });
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

  // Regression: prod ticket 03649e6f (2026-07-12). A failed delivery attempt
  // ("Delivery exception, Customer not available or business closed") arrived
  // as latest_status "DeliveryFailure" with no numeric track.e, fell through
  // the string mapping, and surfaced to the agent as status "unknown" — so
  // the playbooks' "exception status" trigger never fired.
  const statusOnlyResponse = (status: string) =>
    okJson({
      code: 0,
      data: {
        accepted: [
          {
            number: "LULU1000731943",
            carrier: 191997,
            track_info: {
              latest_status: { status },
              latest_event: {
                time_iso: "2026-07-11T03:18:00.000Z",
                location: "HONOLULU, HI, US",
                description:
                  "Delivery exception, Customer not available or business closed",
              },
            },
          },
        ],
      },
    });

  it("maps latest_status 'DeliveryFailure' to 'exception'", async () => {
    const fetchImpl = vi.fn(async () => statusOnlyResponse("DeliveryFailure"));
    const info = await seventeenTrackGetInfo({
      apiKey: "k1",
      trackingNumber: "LULU1000731943",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(info?.status).toBe("exception");
  });

  it("maps latest_status 'AvailableForPickup' to 'in_transit' (mirrors numeric 30)", async () => {
    const fetchImpl = vi.fn(async () =>
      statusOnlyResponse("AvailableForPickup"),
    );
    const info = await seventeenTrackGetInfo({
      apiKey: "k1",
      trackingNumber: "LULU1000731943",
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
