// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { settings, shopCurrency, setRefundPolicy, setDiscountPolicy } = vi.hoisted(() => ({
  settings: vi.fn(),
  shopCurrency: vi.fn(),
  setRefundPolicy: vi.fn(),
  setDiscountPolicy: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  api: { settings, shopCurrency, setRefundPolicy, setDiscountPolicy },
}));
vi.mock("@/lib/session-context", () => ({ useWorkspaceCtx: () => ({ workspaceId: "w1" }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

const { PoliciesStep } = await import("../features/onboarding/steps/PoliciesStep");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("onboarding money policies", () => {
  it("offers complete refund and discount modes and persists always ask/deny", async () => {
    settings.mockResolvedValue({
      refundPolicy: { currencyCode: "EUR", askAboveMinorUnits: 1000, denyAboveMinorUnits: 5000, mode: "thresholds" },
      discountPolicy: {
        currencyCode: "EUR",
        askAbovePercentage: 10,
        maxPercentage: 25,
        askAboveFixedAmountMinorUnits: 500,
        maxFixedAmountMinorUnits: 1500,
        maxValidityDays: 45,
        mode: "thresholds",
      },
    });
    shopCurrency.mockResolvedValue({ currencyCode: "EUR" });
    setRefundPolicy.mockResolvedValue({ status: 200, body: null });
    setDiscountPolicy.mockResolvedValue({ status: 200, body: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(PoliciesStep, { onDone: vi.fn(), canEdit: true })));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(container.querySelector('[name="askAbovePercentage"]')).not.toBeNull();
    expect(container.querySelector('[name="askAboveFixedAmount"]')).not.toBeNull();
    expect(container.querySelector('[name="maxFixedAmount"]')).not.toBeNull();
    expect(container.querySelector('[name="maxValidityDays"]')).not.toBeNull();

    const setValue = (name: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
      input.value = value;
    };
    setValue("askAbove", "15");
    setValue("denyAbove", "60");
    setValue("askAbovePercentage", "12");
    setValue("maxPercentage", "30");
    setValue("askAboveFixedAmount", "6");
    setValue("maxFixedAmount", "20");
    setValue("maxValidityDays", "60");
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(setRefundPolicy).toHaveBeenLastCalledWith(
      { workspaceId: "w1" },
      { currencyCode: "EUR", askAboveMinorUnits: 1500, denyAboveMinorUnits: 6000, mode: "thresholds" },
    );
    expect(setDiscountPolicy).toHaveBeenLastCalledWith(
      { workspaceId: "w1" },
      { currencyCode: "EUR", askAbovePercentage: 12, maxPercentage: 30,
        askAboveFixedAmountMinorUnits: 600, maxFixedAmountMinorUnits: 2000,
        maxValidityDays: 60, mode: "thresholds" },
    );
    setRefundPolicy.mockClear();
    setDiscountPolicy.mockClear();

    const refundAsk = container.querySelector<HTMLInputElement>('[name="refundMode"][value="always_ask"]')!;
    const discountDeny = container.querySelector<HTMLInputElement>('[name="discountMode"][value="always_deny"]')!;
    expect(refundAsk).not.toBeNull();
    expect(discountDeny).not.toBeNull();
    await act(async () => { refundAsk.click(); discountDeny.click(); });
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

    expect(setRefundPolicy).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      { currencyCode: "EUR", askAboveMinorUnits: 1000, denyAboveMinorUnits: 5000, mode: "always_ask" },
    );
    expect(setDiscountPolicy).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      {
        currencyCode: "EUR", askAbovePercentage: 10, maxPercentage: 25,
        askAboveFixedAmountMinorUnits: 500, maxFixedAmountMinorUnits: 1500,
        maxValidityDays: 60, mode: "always_deny",
      },
    );
  });
});
