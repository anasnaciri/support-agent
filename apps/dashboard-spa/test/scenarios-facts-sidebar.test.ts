// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  SCENARIOS_FACTS_SIDEBAR_STORAGE_KEY,
  buildReturnsFactsSidebarInput,
  buildShippingFactsSidebarInput,
  readScenariosFactsSidebarExpanded,
  sidebarFactGroups,
  writeScenariosFactsSidebarExpanded,
} from "../features/settings/ScenariosPage";

const memoryStorage = () => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  };
};

describe("scenarios facts sidebar state", () => {
  it("is collapsed by default and persists the user's toggle", () => {
    const storage = memoryStorage();

    expect(readScenariosFactsSidebarExpanded(storage)).toBe(false);

    writeScenariosFactsSidebarExpanded(true, storage);
    expect(storage.getItem(SCENARIOS_FACTS_SIDEBAR_STORAGE_KEY)).toBe(
      "open",
    );
    expect(readScenariosFactsSidebarExpanded(storage)).toBe(true);

    writeScenariosFactsSidebarExpanded(false, storage);
    expect(storage.getItem(SCENARIOS_FACTS_SIDEBAR_STORAGE_KEY)).toBe(
      "closed",
    );
    expect(readScenariosFactsSidebarExpanded(storage)).toBe(false);
  });
});

describe("shipping facts sidebar form", () => {
  it("trims fields, parses day thresholds, and clears optional blanks", () => {
    const result = buildShippingFactsSidebarInput({
      processingTime: " 1-2 business days ",
      deliveryTime: " 7-12 days ",
      shippingCost: " ",
      customsDuties: "",
      delayedAfterDays: "14",
      lostPackageInvestigationDays: "",
    });

    expect(result).toEqual({
      ok: true,
      input: {
        processingTime: "1-2 business days",
        deliveryTime: "7-12 days",
        shippingCost: null,
        customsDuties: null,
        delayedAfterDays: 14,
        lostPackageInvestigationDays: null,
      },
    });
  });
});

describe("returns facts sidebar form", () => {
  it("parses the return window and clears optional blanks", () => {
    const result = buildReturnsFactsSidebarInput({
      returnWindowDays: "45",
      returnShippingPayer: "",
      refundMethod: "original",
      refundProcessingTime: " ",
    });

    expect(result).toEqual({
      ok: true,
      input: {
        returnWindowDays: 45,
        returnShippingPayer: null,
        refundMethod: "original",
        refundProcessingTime: null,
      },
    });
  });
});

describe("sidebarFactGroups", () => {
  it("groups editable field facts and skips whole-block summary refs", () => {
    expect(
      sidebarFactGroups([
        {
          id: "shipping",
          namespace: "shipping",
          field: null,
          label: "Shipping",
          value: "summary",
        },
        {
          id: "shipping.delivery_time",
          namespace: "shipping",
          field: "delivery_time",
          label: "Delivery time",
          value: "7-12 days",
        },
        {
          id: "returns.return_window",
          namespace: "returns",
          field: "return_window",
          label: "Return window",
          value: null,
        },
      ]),
    ).toEqual([
      {
        id: "shipping",
        title: "Shipping & delivery",
        facts: [
          {
            id: "shipping.delivery_time",
            label: "Delivery time",
            value: "7-12 days",
          },
        ],
      },
      {
        id: "returns",
        title: "Returns & refunds",
        facts: [
          {
            id: "returns.return_window",
            label: "Return window",
            value: null,
          },
        ],
      },
    ]);
  });
});
