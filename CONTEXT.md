# Support Operations

This context describes how a merchant-configured agent resolves customer-support
tickets while remaining constrained by scenario and safety policy.

## Language

**Scenario**:
A merchant-defined class of support situation with recognition guidance, an
action policy, a supplier handling mode, and a playbook.
_Avoid_: Category, case type

**Tool Permission**:
The decision for one agent tool invocation: run automatically (`allow`), require
manager approval (`ask`), or refuse (`deny`).
_Avoid_: Supplier mode, workflow mode

**Scenario Action Policy**:
The scenario-specific availability and tool-permission settings applied after a
ticket selects or resteers to that scenario.
_Avoid_: Agent defaults, playbook notes

**Supplier Handling Mode**:
The scenario policy for whether a supplier may be involved and whether customer
resolution waits for the supplier or continues after notification.
_Avoid_: Supplier permission, escalation permission

**Supplier**:
A party that provides the merchant's goods. A supplier may also fulfill an
order, but that responsibility must not be assumed.
_Avoid_: Warehouse, 3PL, fulfillment operator

**Fulfillment Operator**:
The party responsible for picking, packing, and dispatching a particular set of
order items. It may be the merchant, a supplier, a 3PL, a print-on-demand
partner, or a marketplace fulfillment network.
_Avoid_: Supplier, carrier

**Delivery Operator**:
The carrier or last-mile service responsible for a shipment after dispatch.
_Avoid_: Fulfillment operator, supplier

**Resolution Owner**:
The party accountable for the next operational action on a particular
fulfillment, shipment, or return. Ownership may move as the order progresses.
_Avoid_: Default supplier, integration

**Fulfillment Route**:
The merchant-defined relationship that associates order items or a fulfillment
with its Fulfillment Operator and available means of reaching it.
_Avoid_: Scenario, supplier default

**Logistics Connection**:
A configured channel through which the platform can read logistics facts or
request an action from a Resolution Owner, such as an API, operational email,
or constrained partner portal.
_Avoid_: Fulfillment operator, carrier
