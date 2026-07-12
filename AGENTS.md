# Agent guide — support-agent

You're working in `/Users/anasnaciri/personal/support-agent`, implementing the AI Support Operations Platform described in `master-plan.md`.

## Required reading, every session

1. **`todo.md`** — running checklist of what's done, what's next, and the invariants that must hold. Read this **first**, before any other file.

Read `master-plan.md` when you need architectural context, but it is not required reading for every session.

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
- Audit-log writes share the transaction with ticket state changes (§4 outbox)
- Ticket state machine guards every status transition (§10)
- Effect Service / Layer separation: Tags abstract in `services`; Live impls in `db` / `providers` / feature packages
- `pnpm build` is green before you stop

## Stack (locked-in)

- **DB / migrations:** Drizzle (Postgres)
- **Workflow queue:** pg-boss (Postgres-only, no Redis)
- **LLM:** Vercel AI SDK + OpenRouter first — **not** the hand-rolled per-provider Effect Layers from master-plan §7. The AI SDK is the provider abstraction; `LLMService` is a thin Effect wrapper over it. Dev can use a platform env key, but production design is tenant-supplied provider credentials / billing ownership by default for metered inference.
- **Customer conversations (inbound + outbound):** provider-neutral connector architecture. Core code exposes a generic conversation/mailbox service and generic tools; Gmail is only the first connector implementation, with Microsoft Graph, IMAP/SMTP, helpdesk, and marketing-message connectors later. The same tenant connection that reads incoming customer messages should send replies so threading and provider history stay natural.
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
- The pilot and the main/SaaS product are **two deploy/config variants of this one repo — not two branches and not two repos** (decided 2026-06-05; supersedes the earlier shared-feature-branch rule). Build every feature once on a normal feature branch off `main` and merge to `main`; there is no pilot branch to also merge into. What differs between the variants (custom-distribution Shopify install vs public self-serve OAuth, operator-provisioned vs self-service onboarding, `apps/admin`, the deploy bundle) is expressed as runtime configuration, a selectable layer, or per-variant config under `deploy/` — **never as forked source.** A pilot customer is delivered as a self-contained deployable artifact built from this repo in pilot mode, not a copy of the code. The first realizations: per-tenant credential resolution keys off the presence of a `shopify_app_provisioning` row (no flag), and the dashboard Connect gate keys off `SHOPIFY_CONNECT_REQUIRES_PROVISIONING`. See `master-plan.md` §19.6.
- If `pnpm build` fails, fix it before doing anything else.

## TDD

Follow test-driven development for every feature, bug fix, or behavior change:

1. **Red** — write a failing test that captures the new behavior or reproduces the bug. Run it and confirm it fails for the right reason.
2. **Green** — write the smallest amount of production code to make the test pass.
3. **Refactor** — clean up implementation and tests with the suite green. Re-run tests after each change.

Rules:
- No production code without a failing test that requires it.
- Tests live alongside the code they exercise, in the same package.
- If a bug slips through, the first commit of the fix is a failing regression test.
- Don't disable, skip, or weaken tests to make a build pass. Fix the cause.

## Commits

After completing every feature, fix, or self-contained task, write a commit using [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body — optional, explains the why>
```

- **Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`, `ci`, `perf`, `style`
- **Scope:** package or area, e.g. `agent-core`, `tools`, `dashboard`, `worker`, `shopify`
- **Subject:** imperative, lowercase, no trailing period, ≤72 chars
- **Breaking changes:** add `!` after the type/scope (`feat(api)!: …`) and a `BREAKING CHANGE:` footer
- One logical change per commit. If you find yourself writing "and" in the subject, split it.
- Match the style of recent commits in `git log` — the convention is already in use in this repo.
