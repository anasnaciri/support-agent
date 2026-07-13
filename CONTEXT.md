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
