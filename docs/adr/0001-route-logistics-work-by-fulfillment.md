# Route logistics work by fulfillment, not by default operator

The platform will resolve the current Resolution Owner from the affected
fulfillment, shipment, or return before taking logistics action. A scenario may
say that outside help is allowed and whether to wait, but it must not select a
default operator: one order can be split across merchant stock, a dropshipper,
a 3PL, Amazon MCF, and different carriers. Provider-neutral, action-specific
tools will route through a Fulfillment Route and a capability-bearing Logistics
Connection; partner portal, API, and operational-email delivery are connection
variants rather than separate agent workflows. If the route is absent or
ambiguous, the runtime must fall back to the merchant instead of guessing.

This preserves typed permissions and audit behavior across providers while
allowing provider plugins to expose only the actions they genuinely support.
Migration 0048 renamed the original operator-specific schema and machine
identities to Fulfillment Operator terminology. The next routing migration may
generalize them further, but it must not weaken the rule that every execution
consults `PermissionService`.
