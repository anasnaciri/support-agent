import { describe, expect, it } from "vitest";
import {
  returnReasonLabel,
  requestedResolutionLabel,
  parseReturnReason,
  parseRequestedResolution,
} from "../app/tickets/[id]/return-labels";

describe("return field labels", () => {
  it("humanises every known return reason", () => {
    expect(returnReasonLabel("defective")).toBe("Defective");
    expect(returnReasonLabel("wrong_item")).toBe("Wrong item");
    expect(returnReasonLabel("no_longer_needed")).toBe("No longer needed");
    expect(returnReasonLabel("arrived_late")).toBe("Arrived late");
    expect(returnReasonLabel("other")).toBe("Other");
  });

  it("humanises every known requested resolution", () => {
    expect(requestedResolutionLabel("refund")).toBe("Refund");
    expect(requestedResolutionLabel("replacement")).toBe("Replacement");
    expect(requestedResolutionLabel("exchange")).toBe("Exchange");
    expect(requestedResolutionLabel("store_credit")).toBe("Store credit");
    expect(requestedResolutionLabel("repair")).toBe("Repair");
  });
});

describe("return field parsers (defensive context reads)", () => {
  it("accepts only the closed vocabulary, null otherwise", () => {
    expect(parseReturnReason("defective")).toBe("defective");
    expect(parseReturnReason("nonsense")).toBeNull();
    expect(parseReturnReason(undefined)).toBeNull();
    expect(parseReturnReason(42)).toBeNull();

    expect(parseRequestedResolution("exchange")).toBe("exchange");
    expect(parseRequestedResolution("send_money")).toBeNull();
    expect(parseRequestedResolution(null)).toBeNull();
  });
});
