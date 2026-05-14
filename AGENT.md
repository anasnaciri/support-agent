# Agent guide — support-agent

You're working in `/Users/anasnaciri/personal/support-agent`, implementing the AI Support Operations Platform described in `master-plan.md`.

## Required reading, every session

1. **`todo.md`** — running checklist of what's done, what's next, and the invariants that must hold. Read this **first**, before any other file.
2. **`master-plan.md`** — full architecture (§§1–20). Source of truth for design decisions.

## Required action, every session

Before ending a session, **update `todo.md`**:

- Tick boxes for work you completed (only after verifying with a command — build, test, grep)
- Add boxes for work you discovered or that became necessary
- Move items between phases if the order shifted
- Record any deviation from `master-plan.md` here **and** in a memory entry

Update it even if the session was small. The point of `todo.md` is that the next session — or the next person — picks up cold.

## Invariants you must not regress

From master-plan §16 (dependency rule) and §20 (never moves earlier):

- `agent-core` imports nothing from `services`, `tools`, `db`, or `providers`
- `PermissionService` is consulted before every tool execution (§9). Until it exists, no tool may execute autonomously.
- Audit-log writes share the transaction with case state changes (§4 outbox)
- Case state machine guards every status transition (§10)
- Effect Service / Layer separation: Tags abstract in `services`; Live impls in `db` / `providers` / feature packages
- `pnpm build` is green before you stop

## Stack (locked-in)

- **DB / migrations:** Drizzle (Postgres)
- **Workflow queue:** pg-boss (Postgres-only, no Redis)
- **LLM:** Vercel AI SDK + OpenRouter — **not** the hand-rolled per-provider Effect Layers from master-plan §7. The AI SDK is the provider abstraction; `LLMService` is a thin Effect wrapper over it.
- **Email — customer-facing (inbound + outbound):** the **tenant's own mailbox** via OAuth. Gmail first (scope `gmail.modify` — covers read, send, thread modify; no delete), Microsoft Graph (Outlook) later. The same connection that reads incoming customer email is what sends the reply, so replies thread naturally and land in the merchant's Sent folder.
- **Email — platform/system mail:** Resend, from a single platform domain. Used only for emails that come from the platform itself (manager invites to the dashboard, approval-link emails to managers, billing, system alerts). Never used for customer replies.

## Where code goes

| Concern | Package |
| --- | --- |
| Effect Service Tags (abstract) | `packages/services` |
| Service Live impls (Postgres repos) | `packages/db` |
| LLM Live impl (AI SDK wrapper) | `packages/providers` |
| Typed tools (`defineTool`) | `packages/tools` |
| Agent configs (prompt + model + tools + permissions) | `packages/agents` |
| HTTP + webhook edge | `apps/api` |
| Queue consumers, cron, timers | `apps/worker` |
| Dashboard (Phase 3) | `apps/dashboard` (not yet scaffolded) |
| Plugin SDK + first-party plugins | `packages/plugins/*` |

## Working style

- Don't widen scope past what the user asked for. If you spot adjacent issues, note them in `todo.md` rather than fixing them silently.
- Prefer editing existing files over adding new ones.
- Stack picks are locked. Don't propose alternatives unless one is actively broken.
- If `pnpm build` fails, fix it before doing anything else.
