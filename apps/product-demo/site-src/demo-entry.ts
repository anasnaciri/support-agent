import {
  dashboardDemoPayload,
  type DashboardDemoState,
} from "../dashboard-demo-data";
import "./demo-dashboard.css";

const requested = new URL(window.location.href);
const surface = requested.searchParams.get("surface") === "fulfillment"
  ? "fulfillment"
  : "merchant";
const state = (requested.searchParams.get("state") ??
  (surface === "fulfillment"
    ? "fulfillment-resolution"
    : "customer-message")) as DashboardDemoState;
const fulfillmentView = requested.searchParams.get("view") === "list"
  ? "list"
  : "detail";

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const requestUrl = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    window.location.origin,
  );

  if (requestUrl.pathname.startsWith("/dashboard/")) {
    const payload = dashboardDemoPayload(
      `${requestUrl.pathname}${requestUrl.search}`,
      state,
    );
    return new Response(JSON.stringify(payload.body), {
      status: payload.status,
      headers: { "content-type": "application/json" },
    });
  }

  return nativeFetch(input, init);
};

const workspace = surface === "fulfillment" ? "demo-partner" : "demo-merchant";
const route = surface === "fulfillment"
  ? fulfillmentView === "list"
    ? "/fulfillment-operator/tickets"
    : "/fulfillment-operator/tickets/demo-escalation"
  : "/tickets/demo-ticket";
window.history.replaceState(
  null,
  "",
  `${route}?w=${workspace}&demoState=${state}`,
);

void import("../../dashboard-spa/main");
