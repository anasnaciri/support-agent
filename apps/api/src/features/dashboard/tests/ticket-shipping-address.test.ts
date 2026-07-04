import { describe, expect, it, vi } from "vitest";
import {
  parseShippingAddressFields,
  updateTicketShippingAddress,
  type ShippingAddressView,
} from "../ticket-shipping-address.js";

const current: ShippingAddressView = {
  name: "Jane Doe",
  address1: "123 Main St",
  address2: null,
  city: "Brooklyn",
  province: "NY",
  country: "US",
  zip: "11201",
  phone: null,
};

const orderView = { orderId: "gid://shopify/Order/1001", address: current };

describe("updateTicketShippingAddress — operator fixes the order's Ship-to", () => {
  it("merges the submitted fields over the current address and saves", async () => {
    const update = vi.fn(
      async (args: { orderId: string; address: ShippingAddressView }) =>
        args.address,
    );
    const recordUpdated = vi.fn(async () => {});

    const outcome = await updateTicketShippingAddress({
      fields: { address1: "456 New St", address2: "Apt 2", zip: "11375" },
      loadOrder: async () => orderView,
      update,
      recordUpdated,
    });

    const merged: ShippingAddressView = {
      ...current,
      address1: "456 New St",
      address2: "Apt 2",
      zip: "11375",
    };
    expect(outcome).toEqual({ kind: "saved", address: merged });
    expect(update).toHaveBeenCalledWith({
      orderId: "gid://shopify/Order/1001",
      address: merged,
    });
    expect(recordUpdated).toHaveBeenCalledWith(merged);
  });

  it("returns the address as Shopify stored it, not the merged input", async () => {
    const normalized: ShippingAddressView = {
      ...current,
      address1: "456 New Street", // Shopify normalized the input
    };
    const outcome = await updateTicketShippingAddress({
      fields: { address1: "456 new st" },
      loadOrder: async () => orderView,
      update: async () => normalized,
      recordUpdated: async () => {},
    });
    expect(outcome).toEqual({ kind: "saved", address: normalized });
  });

  it("is a no-op without any submitted fields (order never loaded)", async () => {
    const loadOrder = vi.fn(async () => orderView);
    const outcome = await updateTicketShippingAddress({
      fields: {},
      loadOrder,
      update: async () => current,
      recordUpdated: async () => {},
    });
    expect(outcome).toEqual({ kind: "nothing_to_update" });
    expect(loadOrder).not.toHaveBeenCalled();
  });

  it("returns order_not_found when the ticket has no resolvable order", async () => {
    const update = vi.fn(async () => current);
    const outcome = await updateTicketShippingAddress({
      fields: { address1: "456 New St" },
      loadOrder: async () => null,
      update,
      recordUpdated: async () => {},
    });
    expect(outcome).toEqual({ kind: "order_not_found" });
    expect(update).not.toHaveBeenCalled();
  });

  it("starts from an all-null address when the order has none yet", async () => {
    const update = vi.fn(
      async (args: { orderId: string; address: ShippingAddressView }) =>
        args.address,
    );
    const outcome = await updateTicketShippingAddress({
      fields: { name: "Jane Doe", address1: "456 New St", city: "Queens" },
      loadOrder: async () => ({ ...orderView, address: null }),
      update,
      recordUpdated: async () => {},
    });
    expect(outcome).toEqual({
      kind: "saved",
      address: {
        name: "Jane Doe",
        address1: "456 New St",
        address2: null,
        city: "Queens",
        province: null,
        country: null,
        zip: null,
        phone: null,
      },
    });
  });

  it("maps a Shopify rejection to update_failed and skips the audit", async () => {
    const recordUpdated = vi.fn(async () => {});
    const outcome = await updateTicketShippingAddress({
      fields: { province: "XX" },
      loadOrder: async () => orderView,
      update: async () => {
        throw new Error("Province is not valid");
      },
      recordUpdated,
    });
    expect(outcome).toEqual({
      kind: "update_failed",
      error: "Province is not valid",
    });
    expect(recordUpdated).not.toHaveBeenCalled();
  });

  it("clears a field submitted as null while keeping the rest", async () => {
    const update = vi.fn(
      async (args: { orderId: string; address: ShippingAddressView }) =>
        args.address,
    );
    const outcome = await updateTicketShippingAddress({
      fields: { address2: null, zip: "11375" },
      loadOrder: async () => ({
        ...orderView,
        address: { ...current, address2: "Apt 9" },
      }),
      update,
      recordUpdated: async () => {},
    });
    expect(outcome).toEqual({
      kind: "saved",
      address: { ...current, address2: null, zip: "11375" },
    });
  });

  it("treats an all-clears submission as an update, not a no-op", async () => {
    const update = vi.fn(
      async (args: { orderId: string; address: ShippingAddressView }) =>
        args.address,
    );
    const outcome = await updateTicketShippingAddress({
      fields: { phone: null },
      loadOrder: async () => ({
        ...orderView,
        address: { ...current, phone: "+1 555 000 0000" },
      }),
      update,
      recordUpdated: async () => {},
    });
    expect(outcome).toEqual({
      kind: "saved",
      address: { ...current, phone: null },
    });
  });

  it("never downgrades a stored address over an audit hiccup", async () => {
    const outcome = await updateTicketShippingAddress({
      fields: { address1: "456 New St" },
      loadOrder: async () => orderView,
      update: async (args) => args.address,
      recordUpdated: async () => {
        throw new Error("audit db down");
      },
    });
    expect(outcome.kind).toBe("saved");
  });
});

describe("parseShippingAddressFields — wire values → edit fields", () => {
  it("maps absent / non-string to keep, blank to clear, text to trimmed set", () => {
    expect(
      parseShippingAddressFields({
        address1: "  456 New St ", // set (trimmed)
        address2: "", // clear
        city: "   ", // clear (whitespace-only)
        zip: 11375, // non-string → keep
        country: null, // non-string → keep
        // province, name, phone absent → keep
      }),
    ).toEqual({
      address1: "456 New St",
      address2: null,
      city: null,
    });
  });

  it("returns an empty object for an empty body", () => {
    expect(parseShippingAddressFields({})).toEqual({});
  });
});
