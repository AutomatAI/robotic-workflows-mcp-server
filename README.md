# Robotic Workflows MCP Server

A remote [MCP](https://modelcontextprotocol.io/) server that lets an AI agent **build, deploy, run, and debug RPA workflows** on [Automat](https://runautomat.com/) — browser/API automations that then run on their own schedule, deterministically, with no LLM tokens per run.

The agent authors the automation once (using tokens); the workflow then runs on a cron or on demand with no tokens per run. Token-cost is in *building* the automation, not *operating* it.

## What it does

This repo is the agent-facing layer: one Vercel Function ([`api/mcp.ts`](api/mcp.ts)) exposing an MCP tool surface that forwards to Automat Studio's public v1 API.

- **Discover** — `get_docs`, `get_workflow_schema`, and `list_*` tools so an agent can explore a project's workflows, schedules, secrets, and resources without prior context.
- **Build** — `create_workflow` and a composite-patch `edit_workflow` (plus a surgical find/replace `edit_node_code` for code changes), backed by `read_workflow` for the current graph/definition.
- **Manage** — version history, lifecycle promotion (`development` → `preview` → `active` → `disabled`), and schedules.
- **Run & debug** — `run_workflow`, `get_run` with timeline/IO/recording, and `cancel_run`.
- **`get_docs`** — serves the runtime's authoring model (code-node globals, `$('NodeName')`, `fetch`, worked examples) so an agent can write working `code` nodes with no access to the runtime source.
- **Pass-through auth** — the caller's Studio personal access token is forwarded per request; no credentials are stored in this repo.

See [Tools](#tools) below for the full reference.

## Endpoint

```
https://workflows.runautomat.com/api/mcp
```

Streamable HTTP, stateless. The Vercel default URL (`https://robotic-workflows-mcp-server.vercel.app/api/mcp`) also resolves.

## Authentication

**Pass-through.** The caller supplies a Studio **personal access token** (`pat_…`, minted in Studio → Settings → Personal access tokens); the server forwards it as a Bearer to the studio public v1 API per request. No tokens are stored or committed. The token is read three ways (checked in order):

| Source | Use |
| --- | --- |
| `?api_key=pat_…` query param | Claude web/desktop connector (its UI has no header field) |
| `x-api-key: pat_…` header | generic clients |
| `Authorization: Bearer pat_…` header | Claude Code CLI |

## Configuration (Vercel env)

| Var | Purpose |
| --- | --- |
| `STUDIO_API_BASE_URL` | Origin of the studio API. **Production: `https://studio.runautomat.com`** (stable). For a studio *preview* deploy, use that preview's URL (it changes per deploy). No trailing slash needed. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | **Leave UNSET for production** (the `studio.runautomat.com` custom domain is public). Set it only when `STUDIO_API_BASE_URL` points at a protection-enabled preview deploy. |
| `STUDIO_DEFAULT_PROJECT_ID` | Optional fallback project UUID when the connection does not provide one and `set_project` has not stored a selection. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis REST credentials used to persist `set_project` selections across serverless instances. Every acknowledged write is mirrored into token+connector-scoped memory, so the current instance preserves continuity during a later Redis read outage; absent/failed writes use the same bounded fallback. |
| `STUDIO_DOPPLER_PROJECT`, `STUDIO_DOPPLER_CONFIG` | Optional defaults for secret-management tools. |

**Auth note:** a PAT is scoped to the studio environment it was minted in. Use a token minted at `https://studio.runautomat.com/settings` for production — a preview/staging token will 401 against prod (different database).

## Connect a client

Replace `pat_…` with your personal access token. A PAT spans every project you can access, so a target project must be selected. Resolution is deterministic: `project_id` query → `x-project-id` header → remembered `set_project` selection → `STUDIO_DEFAULT_PROJECT_ID`. Explicit connection selectors therefore stay pinned even if `set_project` was called.

For a one-shot/stateless caller with no durable connection, skip `set_project` entirely and always pass `project_id` / `x-project-id`; this is the safest migration target and already takes precedence. For a recurring connector, `set_project` uses token+connector isolation when the caller supplies a stable `connection_id` query parameter, `x-connection-id` header, or `mcp-session-id` header. Treat `mcp-session-id` as caller-supplied identity; do not assume this stateless endpoint supplies one. Only when none of those identities is present does compatibility behavior use a PAT-global remembered bucket. Every bare caller sharing that PAT then shares one selection, so use a unique PAT per bare connector to prevent collisions. Connections pinned with `project_id` / `x-project-id` need no connector id. Secrets tools additionally need the Doppler identifiers (`dopplerProject`/`dopplerConfig` tool inputs, or `STUDIO_DOPPLER_PROJECT`/`STUDIO_DOPPLER_CONFIG`).

**Token tiers:** read tokens list/inspect (no definition JSON — `read_workflow` `full`/`node` need an authorship-tier PAT; `graph` degrades gracefully); write tokens also run workflows / stop sessions / complete HITL tasks; workflow, schedule, secret, and resource mutations need authorship (author role + write token). Tier ledger: studio `docs/PROGRAMMATIC_ACCESS.md`.

## Workflow lifecycle policy (for agents)

When building or changing workflows through this MCP server, **always follow this rollout ladder**:

| Stage | When to use |
| --- | --- |
| **`development`** | **Default for all agent work.** Create new workflows here; keep them here while iterating. A `{ dryRun: true }` input is only a workflow-defined convention, not a platform-enforced safety boundary; inspect the workflow before relying on it. |
| **`preview`** | Promote with `update_workflow(status:'preview')` **only when ready for the human to test** end-to-end (real emails/side effects if appropriate). Tell the user explicitly that it is in preview and ready for their review. |
| **`active`** | Promote with `update_workflow(status:'active')` **only after the user explicitly confirms go-live.** Required before production schedules and unattended cron. **Never activate on your own.** |
| **`disabled`** | Pause production; auto-pauses schedules. |

This policy is also baked into the MCP server `instructions` and `get_docs` topic `lifecycle` so connected agents see it on every session.

**Claude web / desktop** — Settings → Connectors → Add custom connector → URL:

```
https://workflows.runautomat.com/api/mcp?api_key=pat_…&project_id=<uuid>
```

**Claude Code**

```bash
claude mcp add --transport http automat \
  "https://workflows.runautomat.com/api/mcp?api_key=pat_…&project_id=<uuid>"
```

**MCP Inspector**

```bash
pnpm run inspector
# Streamable HTTP → https://workflows.runautomat.com/api/mcp?api_key=pat_…&project_id=<uuid>
```

## Development

```bash
pnpm install
pnpm run dev:local    # pinned Vercel CLI → http://localhost:3000/api/mcp
pnpm run inspector    # MCP Inspector
pnpm run verify       # typecheck, lint, format check, and tests with coverage
pnpm run deploy       # deploy (requires vercel login)
```

### Synchronize the Studio operation contract

Offline MCP contract tests consume the committed compact projection at
`contracts/studio-programmatic-access-operations.json`; they never import a
sibling Studio working tree. Refresh and verify it from an explicitly selected
Studio generated contract:

```bash
pnpm run contract:sync -- /path/to/studio/docs/generated/programmatic-access-contract.json
pnpm run contract:check -- /path/to/studio/docs/generated/programmatic-access-contract.json
```

Commit the compact projection with any mapping changes. It retains the contract
id/revision plus each operation's id, method, path, request location, query
schema, wrapper/effective tier, success status, pagination, and stable error
codes. The sync rejects duplicate ids/method+path keys, malformed metadata, and
query-location operations that still use `requestSchema`; output is sorted and
deterministic.

`pnpm run verify` remains fully offline: it validates the committed projection's
structure, internal consistency, and MCP assumptions, but cannot prove that the
file matches the latest Studio artifact without a source. Upstream freshness
remains the A8 automation dependency. During handoff, run the explicit
`contract:check -- <path>` command above against the intended Studio contract.

## Stack

[`mcp-handler`](https://github.com/vercel/mcp-handler) (wrapping [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)) as a single Vercel Function — no framework. The whole server is [`api/mcp.ts`](api/mcp.ts). It serves `/api/mcp`; a `/mcp` rewrite is not used because it collides with Vercel's built-in `/api` routing guard.

MCP does not import Runtime validity codes, schemas, or fixtures. Definition and
patch validation flows through Studio's public operations; richer Runtime issue
adoption requires a future Studio endpoint contract.

---

# Tools

Live reference for the 35 tools. Each forwards to the studio **public v1 API** (`STUDIO_API_BASE_URL` + `/api/v1/projects/{projectId}/*`), passing the caller's PAT; the project comes from the connection (`project_id`). The build/edit flow mirrors studio's own builder agent: `read_workflow` → `edit_workflow(patch)` with server-side validation.

## Conventions

- **Transport.** Streamable HTTP (stateless), at `https://workflows.runautomat.com/api/mcp`.
- **Scope.** One selected project per call context. No domain tool takes a `projectId`; choose it with `set_project` or connection/server configuration.
- **Workflow definition.** The `@automat/runtime` `WorkflowSchema`: `{ name, description?, instructions?, notes?, settings, nodes[], edges[], sessionFields?, inputSchema?, outputSchema?, helpers?, files?, runtimeVersion? }`. Nodes are a discriminated union on `type` (`start`, `end`, `block`, `decision`, `document`, `hitl`). Edges are `{ from, to, handle? }`. Call `get_workflow_schema` for the exact shape.
- **Errors.** On failure a tool returns result text `{ "error": { "code", "message", "issues"? } }`. Codes: `not_found`, `validation_failed`, `version_conflict`, `conflict`, `lifecycle_gated`, `forbidden`, `bad_request`, `rate_limited`, `unauthorized`, `internal_error`. `issues[]` accompanies `validation_failed`.
- **Pagination.** List tools take `limit` (default 25, max 100) and `cursor`, and return `{ items, nextCursor }`. Server-supported filters are forwarded before pagination. `list_resources(search)` scans complete Studio pages with a 10,000-row bound; it additionally returns `truncated`, and a non-null `nextCursor` continues a bounded scan.
- **Composite failures.** Multi-operation tools never hide partial completion. Their normal error envelope is accompanied by `partialResult`. A failed schedule pause reports reconciliation state (or `previousStatus` + `pauseOutcome:'unknown'`); a failed secret write reports only prior acknowledged `updated` keys plus `attemptedKey` + `outcome:'unknown'`.

Each tool lists its **input**, **output**, and effective Studio v1 operation. Internally, the single endpoint still uses legacy route names as a compatibility mapping and rewrites them at the Studio API client choke point.

The declared operation map is synchronized with Studio, and fixtures cover every
declared branch of tools that call multiple operations. This is operation-mapping
coverage, not a claim that every tool behavior or Studio capability is exhaustively tested.

## Context & schema

### `list_projects`
Discovery — the projects this token can access (allowlist-scoped tokens see only their allowlist). Use it to pick a `set_project` target.
- Input: `{ limit?, cursor? }`
- Output: `{ items: [{ projectId, name }], nextCursor, projectSelection }`; the bounded guidance names explicit selectors, connector-scoped `set_project`, and the shared token-scope caveat.
- → `GET /api/v1/projects` (the one project-agnostic list)

### `set_project`
Selects the target Studio project after validating the id against `list_projects`. Explicit `project_id` / `x-project-id` selectors take precedence. With `connection_id`, `x-connection-id`, or caller-supplied `mcp-session-id`, the remembered bucket is isolated by PAT + connector. Only connector-less callers use the compatibility PAT-global bucket, shared by all callers using that PAT.
- Input: `{ projectId }` (UUID — discover via `list_projects`)
- Output: `{ projectId, validated: true, selectionScope: 'connector' | 'token', warning? }`; token scope includes a bounded collision warning, while connector scope does not.
- → validates via `GET /api/v1/projects`

### `get_docs`
Authoring guide — **call first**. How to write `code`/`decision` nodes: globals (`$('NodeName')`, `fetch`, `secrets`, `page`/`context`, `logger`), async/`return` semantics, node types, browser/recording, schedules, **lifecycle rollout policy**, and worked examples.
- Input: `{ topic?: 'overview'|'codeNodes'|'nodeTypes'|'browser'|'secrets'|'schedules'|'lifecycle'|'examples' }`
- Output: the docs (all sections, or one `topic`)

### `list_runtime_versions`
- Input: none
- Output: `{ versions: [{ version, isLatest }], note }`
- Runtime-version selection isn't exposed by the API; returns `latest`.

### `get_workflow_schema`
- Input: `{ runtimeVersion?: string }` (default `latest`)
- Output: `{ runtimeVersion, jsonSchema }`
- → `GET /api/v1/schema`

## Workflows

### `list_workflows`
- Input: `{ status?, search?, limit?, cursor? }` (`status`: development | preview | active | disabled)
- Output: `{ items: [{ workflowId, name, description, status, activeVersionId, apiEnabled, apiUrlSlug, sessionCount, lastRunAt, updatedAt }], nextCursor }`
- → `GET /api/v1/projects/{projectId}/workflows` (`status`/`search` forwarded server-side)

### `create_workflow`
- Input: `{ name, description?, definition?, runtimeVersion? }` — omit `definition` for a minimal `start → end` scaffold. **Status defaults to `development` — keep it there while iterating.**
- Output: `{ workflowId, versionId, versionNumber, status }`
- → `POST /api/v1/projects/{projectId}/workflows`

### `copy_workflow`
- Input: `{ workflowId, name? }`
- Output: `{ workflowId, name }`
- Client-side: reads the source's active definition, then `create_workflow` with it. Schedules/runs not copied.

### `read_workflow`
- Input: `{ workflowId, view: 'graph' | 'node' | 'full', nodeName? }` (`nodeName` required for `node`)
- Output: `{ _meta: { workflowId, versionId, versionNumber, status, apiEnabled, apiUrlSlug }, ... }` — `graph` (nodes/edges + metadata — no code bodies, but per-node `codeChars`, decision `branches`/`elseLabel`, and a `helpers` index `[{name, description, codeChars}]`), `node` (one node incl. code), `full` (entire definition incl. helper code). Pass `_meta.versionId` to `edit_workflow`/`edit_node_code`.
- Tiers: `full`/`node` return definition JSON → authorship-tier PAT required (403 `forbidden` otherwise); `graph` works with any token, degrading to the server's lean names/types+edges view without authorship.
- → `GET /api/v1/projects/{projectId}/workflows/{id}?view=…`; the rich `graph` projection derives from `view=full`, falling back to the server's `view=graph` on a tier 403.

### `update_workflow`
- Input: `{ workflowId, name?, description?, status?, apiEnabled?, apiUrlSlug? }`
- Output: the updated workflow
- `status: active` needs a published version; `disabled` auto-pauses schedules. **Agent policy:** development while testing → preview when the human should validate → active only after explicit user go-live approval. → `PATCH /api/v1/projects/{projectId}/workflows/{id}`

### `delete_workflow`
- Input: `{ workflowId }` · Output: `{ success: true }` · soft delete → `DELETE /api/v1/projects/{projectId}/workflows/{id}`

## Editing

### `edit_workflow`
- Input: `{ workflowId, patch, expectedActiveVersionId? }`
  ```ts
  patch = {
    nodes?: { add?: Node[], update?: [{ name, patch }], remove?: string[] },
    edges?: {
      add?: Edge[],
      update?: [{ from, to, handle?, patch }],
      remove?: Edge[]
    },
    // any top-level WorkflowSchema field: settings deep-merges, others replace
  }
  ```
- Output: `{ ok: true, versionId, versionNumber, deduped }` or `{ error: { code, message, issues? } }`
- Client reads the active definition, applies the patch (order: `nodes.remove` → `nodes.add` → `nodes.update` [rename rewrites edges] → `edges.remove` → `edges.update` → `edges.add` → top-level), then PUTs the full definition. Edge removal/update matches `from`, `to`, and `handle`; omitting `handle` matches only an unhandled edge. The server validates → a new version (one edit, one version). `expectedActiveVersionId` (from `read_workflow`'s `_meta`) gives optimistic concurrency. → `GET` + `PUT /api/v1/projects/{projectId}/workflows/{id}`
- Best for structural edits; `nodes.update` replaces each patched field wholesale — for partial code changes use `edit_node_code`.

### `edit_node_code`
- Input: `{ workflowId, nodeName, oldString, newString, field?: 'code' | 'instructions' | 'expression', replaceAll?, expectedActiveVersionId? }`
- Output: `{ ok: true, versionId, versionNumber, deduped, replacements, fieldChars }` or `{ error: { code, message } }`
- Surgical find/replace inside one node — the agent sends only the changed snippet instead of resending a multi-KB `code` string. `oldString` must match exactly and occur once (or pass `replaceAll`); an ambiguous match returns the occurrence count, a miss returns the field sizes. `field: 'expression'` spans the legacy `expression` plus every decision `branches[i].expression`. Same read-modify-PUT + optimistic-concurrency path as `edit_workflow`. → `GET` + `PUT /api/v1/projects/{projectId}/workflows/{id}`

## Versions

### `list_versions`
- Input: `{ workflowId, limit?, cursor?, named?, source? }`
- Output: `{ items: [{ versionId, versionNumber, name, source, createdAt }], nextCursor, activeVersionId }` → `GET /api/v1/projects/{projectId}/workflows/{id}/versions`

### `get_version`
- Input: `{ workflowId, versionId }` · Output: `{ versionId, versionNumber, name, source, createdAt, definition }` → `GET …/versions/{versionId}`

### `revert_to_version`
- Input: `{ workflowId, versionId, expectedActiveVersionId? }` · Output: `{ versionId, versionNumber, revertedFromVersionNumber }` · non-destructive (appends a new version) → `POST …/versions/{versionId}/revert`

## Schedules

All schedules run in **UTC**. A workflow may have many; run input comes from a linked project resource (`inputResourceName`), gated against the workflow's `inputSchema`.

### `list_schedules`
- Input: `{ workflowId }` · Output: `{ items: [{ scheduleId, name, recurrenceRule, startAt, status, nextFireAt, inputResourceName }] }`

### `create_schedule`
- Input: `{ workflowId, recurrenceRule (RFC 5545 RRULE, UTC), name?, startAt? (UTC), enabled?, inputResourceName? }` — `enabled: false` creates it paused
- Output: `{ scheduleId }`; after a failed follow-up pause that reconciles as applied, `{ scheduleId, status:'paused', reconciled:true }`. An unreconciled failure uses the shared error envelope plus `{ partialResult:{ scheduleId, created:true, previousStatus, pauseOutcome:'unknown' } }`. → `POST /api/v1/projects/{projectId}/workflows/{id}/schedules`, optional `PATCH`, then reconciliation `GET`

### `update_schedule`
- Input: `{ workflowId, scheduleId, recurrenceRule?, name?, startAt?, enabled?, inputResourceName? }` — `enabled` maps to status active/paused
- Output: `{ scheduleId }` → `PATCH …/schedules/{scheduleId}`

### `delete_schedule`
- Input: `{ workflowId, scheduleId }` · Output: `{ success: true }` → `DELETE …/schedules/{scheduleId}`

## Runs

### `run_workflow`
- Input: `{ workflowId, input?, previewBranch? }` — `dryRun` has no universal platform meaning; pass it only when the workflow's input contract implements that convention
- Output: `{ sessionId, status: 'queued' }` · `input` validated against `inputSchema`; `lifecycle_gated` if disabled / no active version. → `POST /api/v1/projects/{projectId}/workflows/{id}/run`
- **Defaults to the stable production Trigger runtime** — studio resolves its deployment's default deploy tier (production on a prod studio). This is the path for all normal runs.
- **`previewBranch` is an explicit opt-in** — set it ONLY to run against a specific deployed preview-branch runtime (sends `environment=preview` + that branch). The branch must have a running preview worker or the run stalls in `queued`; that's why it's off by default and never inferred.

### `list_runs`
- Input: `{ workflowId?, status?, limit?, cursor? }` · Output: `{ items: [{ sessionId, workflowId, status, source, startedAt, endedAt, durationMs }], nextCursor }` → `GET /api/v1/projects/{projectId}/sessions`

### `get_run`
- Input: `{ sessionId, include?: ('timeline' | 'io' | 'logs' | 'recording')[], logsCursor? }`
- Output: `{ sessionId, workflowId, versionId, status, source, input, output, startedAt, endedAt, durationMs }` plus, when requested: `timeline` `[{ name, type, status, startedAt, endedAt, durationMs }]`, `nodeIO` `[{ name, input, output }]`, `recordingUrl`, `logs` `{ entries, nextCursor }`.
- timeline/io ← `GET /sessions/{id}/nodes`; recording ← the session; logs intentionally return `null` + `logsNote` because Studio does not retain a queryable execution log store.

### `cancel_run`
- Input: `{ sessionId }` · Output: `{ success: true, status: 'canceled' }` → `POST /sessions/{id}/stop`

## Human-in-the-loop

### `list_hitl_tasks`
- Input: `{ sessionId?, status?, limit?, cursor? }` (`status`: pending | responded | expired | canceled)
- Output: `{ items: [{ taskId, sessionId, workflowId, nodeName, prompt, isApproval, selectedAction, status, createdAt, expiresAt, respondedAt, respondedByName }], nextCursor }` (PII-light; free-form response/actions/field definitions are not returned) → `GET /api/v1/projects/{projectId}/hitl/tasks`

### `complete_hitl_task`
- Input: `{ taskId, action, fields?, secretKey? }`; each field value is a string or string array. `secretKey` is honored only for development-environment runs. Output: `{ success: true }` → `POST /api/v1/projects/{projectId}/hitl/tasks/{taskId}/complete`

## Secrets

Project-scoped. Values are never returned.

### `list_secrets`
- Input: `{ lifecycle?, limit?, cursor? }` · Output: `{ items: [{ key, last4, lifecycle, updatedAt }], nextCursor }`

### `set_secrets`
- Input: `{ secrets: [{ key, value }], dopplerProject?, dopplerConfig? }` · Output: `{ updated: [keys] }` · name-keyed PUT. If the current write errors, only prior acknowledgements appear in `updated`; `partialResult` reports `{ attemptedKey, outcome:'unknown', remainingKeys }` and never secret values.

### `delete_secret`
- Input: `{ key }` · Output: `{ success: true }` · resolves key→id

## Resources

Data resources, referenced by name from `block`/`document` nodes and schedule inputs. Each has a `lifecycle` (development | preview | active).

### `list_resources`
- Input: `{ lifecycle?, search?, limit?, cursor? }` · Output: `{ items: [{ resourceId, name, kind, description, lifecycle, updatedAt }], nextCursor, truncated? }`

### `get_resource`
- Input: `{ resourceId }` or `{ name, lifecycle? }` · Output: `{ resourceId, name, kind: 'data', value, description, lifecycle, updatedAt }`. A unique name-only match succeeds; multiple lifecycle rows return `conflict` and require `lifecycle` or `resourceId`.

### `set_resource`
- Input: `{ resourceId, value, description? }` to replace one row, `{ name, lifecycle, value, description? }` to upsert one stage, or `{ name, value, description? }` for compatibility name-only behavior. Name-only performs a complete bounded lookup: update one unique row, return `conflict` for multiple lifecycle rows, or create and seed all stages when absent. Outputs normalized `resourceId` fields. File-resource uploads are not supported.

### `delete_resource`
- Input: `{ resourceId }` or `{ name, lifecycle? }` · Output: `{ success: true, resourceId }`. Name-only follows the same unique-or-conflict rule as `get_resource`.

## Extractors

Read-only. `document` nodes reference an `extractorId`; authoring is not exposed.

### `list_extractors`
- Input: `{ search?, limit?, cursor? }` · Output: `{ items: [{ extractorId, name, activeVersionId, description }], nextCursor }`

### `get_extractor`
- Input: `{ extractorId, view?: 'summary' | 'full' }` · Output: `{ extractor }`

## Known gaps

- **Session logs**: Studio does not retain a queryable log store; `get_run` logs return `null` + a note. Use timeline and I/O data instead.
- Schedules are **UTC-only**.
- File-resource uploads and extractor authoring are not yet available.

## Roadmap

- Richer standardized MCP tool results and protocol metadata.
- Extractor authoring and file-resource uploads.
