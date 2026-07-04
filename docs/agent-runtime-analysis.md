# Agent runtime — flow, retries & uncaught edge cases

Investigation of `packages/services/src/agent-runtime.ts` (the `tick`/`tickBody` spine)
plus its worker dispatch (`apps/worker/src/index.ts`), retry model
(`workflow-job.ts`, `workflow-queue-live.ts`, `workflow-dead-letter.ts`) and the
out-of-band recovery crons.

Edge cases are labelled **E1–E13** and colour-coded by severity. ✅ = confirmed in
code · 🔎 = needs a quick verify. See [§ Edge-case catalogue](#edge-case-catalogue)
for the write-ups.

> **Rendering note.** If your viewer threw `UnknownDiagramError: No diagram type
> detected …`, it fed this file's prose into Mermaid instead of parsing only the
> fenced ` ```mermaid ` blocks. Use a viewer that understands Markdown (GitHub,
> VS Code Markdown Preview Mermaid Support, Obsidian), **or** render the
> prose-free standalone diagrams in [`docs/diagrams/`](./diagrams/) — paste any
> `.mmd` file into <https://mermaid.live>:
>
> - `01-dispatch-retry.mmd` — top-level dispatch + retry/redelivery
> - `02-tickbody-preloop.mmd` — load, approval-resume, park guards
> - `03-agent-loop.mmd` — the per-turn agent loop
> - `04-state-machine.mmd` — ticket state machine

---

## 1. Top-level dispatch + retry / redelivery model

```mermaid
flowchart TD
    EV[/"DomainEvent<br/>(pg-boss job, at-least-once)"/] --> TICK["tick(event)"]

    TICK -->|"message.received ONLY"| C3{"C3 ProcessedMessageStore<br/>already seen?"}
    C3 -->|yes| DROP["return Completed (drop)"]
    C3 -->|no| LOCK
    TICK -->|"customer.replied / approval / timer / …<br/>(no top-level dedup)"| LOCK

    LOCK["pg_advisory_lock(ticket|thread)<br/>BLOCKING · no timeout"]:::warn --> BODY["tickBody(event)<br/>wrapped in catchAllCause"]
    BODY --> RES{"WorkflowResult"}

    RES -->|"Failed retryable:true"| THROW["worker throws"]
    RES -->|"Completed / Paused* /<br/>HumanTakeoverRequired /<br/>Failed retryable:false"| DONE["job COMPLETE"]

    THROW --> PGB{"pg-boss<br/>retryLimit 5 · backoff"}
    PGB -->|retry| REPLAY["replay WHOLE tick from turn 0<br/>(LLM re-samples → new callId)"]:::warn
    REPLAY --> TICK
    PGB -->|exhausted| DL["workflow.events.dead"]
    DL --> DLC["dead-letter consumer<br/>park ticket → human_takeover"]

    DONE -.->|"C3 claim written AFTER tick,<br/>only if NOT retryable-Failed"| C3CLAIM["ProcessedMessageStore.claim"]

    REPLAY -. "E1: side-effect tools w/o idempotencyKey<br/>re-run (key falls back to volatile callId)" .-> REPLAY
    DLC -. "E12: msg.received lookup uses provider=undefined<br/>→ may miss the ticket" .-> DLC

    classDef warn fill:#fff3cd,stroke:#b45309,color:#191919;
```

**Out-of-band recovery crons** (each its own pg-boss queue, all best-effort):

```mermaid
flowchart LR
    subgraph crons["worker crons"]
        AM["approval-maintenance<br/>expire overdue · republish lost decisions"]
        RD["reply-delivery-retry<br/>re-send failed replies · auto-resolve"]
        TS["timer-sweep"]
        REN["gmail / graph / imap renewals"]
        SN["supplier-notify outbox"]
        RET["retention-sweep"]
        LC["llm-credits"]
    end
    AM --> TICKET[(tickets / approvals)]
    RD --> TICKET
    RD -. "E10: 'skip' marks row sent though nothing sent;<br/>auto-resolve runs WITHOUT the per-ticket lock" .-> RD
    classDef x fill:#fde2e2,stroke:#b91c1c;
```

---

## 2. tickBody — pre-loop (load, approval-resume, park guards)

```mermaid
flowchart TD
    START["tickBody"] --> LOAD["1. load/create ticket + audit (1 tx)<br/>unique(tenant,thread) guards double-create"]
    LOAD --> KIND{event.type}

    KIND -->|approval.approved| AA["approval-resume"]
    KIND -->|approval.rejected| AR["→ human_takeover"]
    KIND -->|"inbound / timer / supplier / resumed"| ID

    subgraph resume["approval.approved resume"]
        AA --> AA1{"status == resolved?"}
        AA1 -->|yes| AADUP["dup-skip → Completed"]
        AA1 -->|no| AA2{"approval rejected/<br/>cancelled/expired?"}
        AA2 -->|yes| AAF["Failed"]
        AA2 -->|no| AA3{"past expiry?"}
        AA3 -->|yes| AAH["→ human_takeover"]
        AA3 -->|no| AA4["decode input · policy re-check"]
        AA4 -->|"deny / bad input"| AAH
        AA4 -->|ok| AA5["C2 marker → EXECUTE gated tool"]
        AA5 -->|fail| AAPARK["park (reply-failure | approved_tool_failed)"]
        AA5 -->|ok| AARES["resolve ★ASSUMES TOOL TERMINAL"]:::warn
    end

    AARES -. "E5: refund.create as gated tool →<br/>resolves with NO customer reply" .-> AARES
    AA1 -. "E6: only guards 'resolved';<br/>reopened/handed-back ticket can run stale draft" .-> AA1

    ID["3. customer identification (Shopify)<br/>4. order-identity verify (may set identityVerified)<br/>5. photo signals + dup-photo hash store"]:::warn
    ID -. "E8: these RUN even when the ticket is about to be HELD;<br/>E3: writes are fail-OPEN → can drop the disclosure flag" .-> ID
    ID --> G1{"status ==<br/>waiting_for_approval<br/>(pending row)?"}
    G1 -->|yes| P1["PausedWaitingForApproval"]
    G1 -->|no| G2{"status ==<br/>human_takeover?"}
    G2 -->|yes| P2["PausedForHumanTakeover"]
    G2 -->|no| G3{"status ==<br/>waiting_for_supplier<br/>(non-passthrough)?"}
    G3 -->|yes| P3["PausedWaitingForSupplier"]
    G3 -->|no| RO{"resolved + inbound reply?"}
    RO -->|yes| ROPEN["reopen: resolved → in_progress"]
    RO -->|no| LOOP["AGENT LOOP →"]
    ROPEN --> LOOP

    classDef warn fill:#fff3cd,stroke:#b45309,color:#191919;
```

---

## 3. tickBody — the agent loop

```mermaid
flowchart TD
    L0["for turn in 0..maxTurnsPerTick<br/>(counter SHARED across handoffs — E? known)"] --> LLM["llm.runToolCalling<br/>NO TIMEOUT at runtime layer"]:::warn
    LLM -. "E4: hung provider pins tick + advisory lock;<br/>E7: unclassified deterministic 400 → 5 wasted retries" .-> LLM

    LLM -->|"Credential Missing/Revoked"| H1["→ human_takeover"]
    LLM -->|"ContextTooLarge / SafetyBlocked"| H1
    LLM -->|"any other _tag"| RT["Failed retryable:true → pg-boss retry"]
    LLM -->|decision| D{decision.type}

    D -->|final_message| FM{"status == resolved?"}
    FM -->|no| FMR["resolve<br/>(InvalidTransition → PausedForHumanTakeover)"]
    FM -->|yes| FMC["Completed"]
    FMR --> FMC
    FMR -. "E2: NO check that a reply was actually sent →<br/>ticket can resolve in silence" .-> FMR

    D -->|handoff| HO["swap agent (allowlist) · continue"]
    D -->|"wait_for_customer / escalate_supplier"| HN["→ human_takeover ('not wired')"]:::warn
    HN -. "E13: decision dead-ends, but supplier.escalate TOOL works" .-> HN
    D -->|tool_call| TC

    subgraph tool["tool_call path"]
        TC["push assistant msg → handoff pseudo-tool?<br/>tryGet → decode schema"] --> C2{"C2 marker dedup<br/>(sideEffect ≠ none)"}
        C2 -->|hit| C2D["push deduped result · continue"]
        C2 -->|miss| RFLAG["refund mismatch flag (best-effort)"]
        RFLAG --> PERM["perms.check + shouldForceReplyApproval<br/>(allow→ask disclosure backstop)"]
        PERM -->|deny| DENY["tool result 'denied' · continue"]
        PERM -->|ask| ASK["create approval + park + audit (1 tx)<br/>+ email / push (best-effort) → PausedWaitingForApproval"]
        PERM -->|allow| EXE["EXECUTE outside tx (Effect.timeout if declared)<br/>→ audit + C2 marker (1 tx)"]
        EXE -->|ask_customer| WC["→ waiting_for_customer"]
        EXE -->|"supplier.escalate {escalated}"| WS["→ waiting_for_supplier"]
        EXE -->|"reply SEND failure"| RPARK["parkForReplyDeliveryFailure → human_takeover<br/>(NEVER resolves)"]
        EXE -->|else| PUSH["push tool result · loop"]
    end

    C2 -. "E1: keyless side-effect tools (update_status,<br/>update_context, merchant.notify) NOT deduped on replay" .-> C2

    L0 -->|loop exhausted| MTE["max_turns_exceeded → human_takeover"]

    classDef warn fill:#fff3cd,stroke:#b45309,color:#191919;
```

---

## 4. Ticket state machine (as driven by the runtime)

```mermaid
stateDiagram-v2
    [*] --> new: create (inbound / ticket)
    new --> in_progress: agent loop
    in_progress --> waiting_for_approval: tool perm = ask
    in_progress --> waiting_for_customer: conversation.ask_customer
    in_progress --> waiting_for_supplier: supplier.escalate {escalated}
    in_progress --> resolved: final_message
    in_progress --> human_takeover: escalate (creds / max_turns / not-wired / reply-send fail)

    waiting_for_approval --> resolved: approval.approved (terminal tool)
    waiting_for_approval --> human_takeover: approval.rejected / expired / approved-tool-fail
    waiting_for_approval --> waiting_for_approval: stray event HELD

    waiting_for_customer --> in_progress: customer.replied
    waiting_for_supplier --> in_progress: supplier.updated
    waiting_for_supplier --> waiting_for_supplier: stray event HELD

    human_takeover --> in_progress: dashboard "hand back" / reply delivered on retry
    human_takeover --> human_takeover: stray event HELD

    resolved --> in_progress: inbound reply (reopen)
    resolved --> [*]

    note right of human_takeover
        Terminal-ish sink: most uncaught
        edge cases funnel here (safe but
        needs a human). E2 is the exception —
        it lands in resolved silently.
    end note
```

---

## Edge-case catalogue

Severity: 🔴 high · 🟠 medium · 🟡 lower.

| ID | Sev | What's not caught | Confirmed |
|----|-----|-------------------|-----------|
| **E1** | 🔴 | Side-effecting tools **without an `idempotencyKey`** (`ticket.update_status`, `ticket.update_context`, `merchant.notify`) re-execute on pg-boss retry — the C2 key falls back to `decision.callId`, which the LLM regenerates on every re-sample. | ✅ |
| **E2** | 🔴 | A ticket can `resolve` via `final_message` with **no customer reply ever sent** — the runtime never asserts an outbound message happened. Reply-delivery park only fires on a *send error*, not on the agent skipping the reply. | ✅ |
| **E3** | 🔴 | The `order_customer_mismatch` / `refund_customer_mismatch` flags are written **fail-open** (`catchAll → current`). `shouldForceReplyApproval` reads in-memory `current.context`; a DB blip on that write drops the flag → the cross-customer disclosure gate doesn't fire → auto-reply leaks another customer's order. | ✅ |
| **E4** | 🟠 | **No timeout on `llm.runToolCalling`** at the runtime layer (tools honour `tool.timeout`; the LLM call doesn't). A hung provider pins the tick *while holding the `pg_advisory_lock`* → every other event for that ticket blocks; job can expire/redeliver underneath. | ✅ |
| **E5** | 🟠 | Approval-resume **assumes the gated tool is terminal** and always `resolve`s after it. If `refund.create` is the gated action (conditional-threshold), approving issues the refund and resolves with no customer reply. | ✅ |
| **E6** | 🟠 | Approval-resume's redelivery dup guard only checks `status == resolved`. A ticket that went `waiting_for_approval → expired → human_takeover → handed back → in_progress` can still run a stale `approved` draft. | 🔎 |
| **E7** | 🟠 | Only `ContextTooLarge` / `SafetyBlocked` / `Credential*` short-circuit; any other LLM `_tag` is treated as transient. A deterministic 400 (e.g. tenant model-override → non-existent model id) burns all 5 retries before dead-lettering, every message. | ✅ |
| **E8** | 🟠 | Park guards run **after** customer-identification / identity-verify / photo-hash steps, so a reply to a *held* ticket still mutates context and records image hashes. "Held" events aren't inert. | ✅ |
| **E9** | 🟡 | Top-level `ProcessedMessageStore` dedup covers **`message.received` only** — `customer.replied`, `timer.expired`, etc. rely solely on C2 + the lock (compounds E1). | ✅ |
| **E10** | 🟡 | Reply-delivery cron marks a row **`sent` on "skip"** though nothing was sent (draft silently dropped, data reads "sent"); its auto-resolve runs **without the per-ticket advisory lock**. | ✅ |
| **E11** | 🟡 | `ToolExecutionStore` / `ProcessedMessageStore` are optional — if a deploy forgets to wire them, **all dedup silently degrades** (same failure class as the connector-cron prod outage). No boot-time assertion. | ✅ |
| **E12** | 🟡 | Dead-letter consumer looks up `message.received` tickets with `provider=undefined` (tickBody uses the parsed provider). If `findByThreadId` filters on provider, a dead-lettered inbound may not find its ticket → dangles un-parked. | 🔎 |
| **E13** | 🟡 | The `escalate_supplier` / `wait_for_customer` *decision types* still dead-end to human ("not wired"), but supplier escalation is wired via the `supplier.escalate` *tool* — a model emitting the decision gets parked instead. | ✅ |

### Where to start
**E1**, **E2**, **E3** have real customer/security impact and small, testable fixes:
- **E1** — give the three tools idempotency keys, or scope the C2 marker to `deliveryScopeFor(event)` instead of the volatile `callId` for keyless tools.
- **E2** — track "did an outbound reply fire this tick?" and flag/withhold resolve when `final_message` lands with none.
- **E3** — make the disclosure-guard write **fail-closed**: if the flag can't persist, force the reply to approval (or fail the tick retryable) rather than letting it auto-send.
