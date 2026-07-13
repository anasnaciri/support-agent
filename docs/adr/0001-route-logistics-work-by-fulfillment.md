# Route logistics work by fulfillment, not by default supplier

The platform will resolve the current Resolution Owner from the affected
fulfillment, shipment, or return before taking logistics action. A scenario may
say that outside help is allowed and whether to wait, but it must not select a
default supplier: one order can be split across merchant stock, a dropshipper,
a 3PL, Amazon MCF, and different carriers. Provider-neutral, action-specific
tools will route through a Fulfillment Route and a capability-bearing Logistics
Connection; supplier portal, API, and operational-email delivery are connection
variants rather than separate agent workflows. If the route is absent or
ambiguous, the runtime must fall back to the merchant instead of guessing.

This preserves typed permissions and audit behavior across providers while
allowing provider plugins to expose only the actions they genuinely support.
The existing `supplier.escalate`, supplier tables, and
`waiting_for_supplier` state remain compatibility surfaces until a tested
expand/contract migration generalizes them; this decision does not authorize a
flag-day rename or weaken the rule that every execution consults
`PermissionService`.
