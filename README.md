# Robotic Workflows MCP Server

A remote [MCP](https://modelcontextprotocol.io/) server that lets AI agents build, run, and manage RPA workflows, powered by Automat AI (https://runautomat.com/).

The server is a thin forwarder: each tool calls the studio app's keyless agent API (`/api/agent/*`), which resolves the project from the API key and reuses studio's existing validation, versioning, and execution code.

> **Status:** live. All 31 tools forward to the studio API. Connection liveness uses MCP's built-in protocol-level [ping](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping), so there is no `ping` tool.

## Endpoint

```
https://workflows.runautomat.com/api/mcp
```

Streamable HTTP, stateless. The Vercel default URL (`https://robotic-workflows-mcp-server.vercel.app/api/mcp`) also resolves.

## Authentication

**Pass-through.** The caller supplies a project-scoped studio key (`ak_…`); the server forwards it to the studio API per request. No keys are stored or committed. The key is read three ways (checked in order):

| Source | Use |
| --- | --- |
| `?api_key=ak_…` query param | Claude web/desktop connector (its UI has no header field) |
| `x-api-key: ak_…` header | generic clients |
| `Authorization: Bearer ak_…` header | Claude Code CLI |

## Configuration (Vercel env)

| Var | Purpose |
| --- | --- |
| `STUDIO_API_BASE_URL` | Origin of the studio agent API. **Studio preview URLs change per deploy** — update this each studio redeploy (or point at a stable alias once preview protection is lifted). |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Optional — only if the studio deployment is protected. |

## Connect a client

Replace `ak_…` with your project-scoped studio key.

**Claude web / desktop** — Settings → Connectors → Add custom connector → URL:

```
https://workflows.runautomat.com/api/mcp?api_key=ak_…
```

**Claude Code**

```bash
claude mcp add --transport http automat \
  "https://workflows.runautomat.com/api/mcp?api_key=ak_…"
```

**MCP Inspector**

```bash
npx @modelcontextprotocol/inspector
# Streamable HTTP → https://workflows.runautomat.com/api/mcp?api_key=ak_…
```

## Development

```bash
npm install
npm run dev          # vercel dev → http://localhost:3000/api/mcp
npm run inspector    # MCP Inspector
vercel --prod        # deploy (requires vercel login)
```

## Stack

[`mcp-handler`](https://github.com/vercel/mcp-handler) (wrapping [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)) as a single Vercel Function — no framework. The whole server is [`api/mcp.ts`](api/mcp.ts). It serves `/api/mcp`; a `/mcp` rewrite is not used because it collides with Vercel's built-in `/api` routing guard.

---

# Tools

Live reference for the 31 tools. Each forwards to the studio **agent API** (`STUDIO_API_BASE_URL` + `/api/agent/*`), passing the caller's project-scoped key; the project is resolved from the key. The build/edit flow mirrors studio's own builder agent: `read_workflow` → `edit_workflow(patch)` with server-side validation.

## Conventions

- **Transport.** Streamable HTTP (stateless), at `https://workflows.runautomat.com/api/mcp`.
- **Scope.** One key = one project. No tool takes a `projectId`.
- **Workflow definition.** The `@automat/runtime` `WorkflowSchema`: `{ name, description?, instructions?, notes?, settings, nodes[], edges[], sessionFields?, inputSchema?, outputSchema?, helpers?, files?, runtimeVersion? }`. Nodes are a discriminated union on `type` (`start`, `end`, `block`, `decision`, `document`, `hitl`). Edges are `{ from, to, handle? }`. Call `get_workflow_schema` for the exact shape.
- **Errors.** On failure a tool returns result text `{ "error": { "code", "message", "issues"? } }`. Codes: `not_found`, `validation_failed`, `version_conflict`, `conflict`, `lifecycle_gated`, `forbidden`, `bad_request`, `rate_limited`, `unauthorized`, `internal_error`. `issues[]` accompanies `validation_failed`.
- **Pagination.** List tools take `limit` (default 25, max 100) and `cursor`, and return `{ items, nextCursor }` (the cursor wraps the API's page number).

Each tool lists its **input**, **output**, and the backing `/api/agent` call.

## Context & schema

### `list_runtime_versions`
- Input: none
- Output: `{ versions: [{ version, isLatest }], note }`
- Runtime-version selection isn't exposed by the API; returns `latest`.

### `get_workflow_schema`
- Input: `{ runtimeVersion?: string }` (default `latest`)
- Output: `{ runtimeVersion, jsonSchema }`
- → `GET /api/agent/schema`

## Workflows

### `list_workflows`
- Input: `{ status?, search?, limit?, cursor? }` (`status`: development | preview | active | disabled)
- Output: `{ items: [{ workflowId, name, description, status, activeVersionId, apiEnabled, apiUrlSlug, sessionCount, lastRunAt, updatedAt }], nextCursor }`
- → `GET /api/agent/workflows` (`status`/`search` filtered client-side)

### `create_workflow`
- Input: `{ name, description?, definition?, runtimeVersion? }` — omit `definition` for a minimal `start → end` scaffold
- Output: `{ workflowId, versionId, versionNumber, status }`
- → `POST /api/agent/workflows`

### `copy_workflow`
- Input: `{ workflowId, name? }`
- Output: `{ workflowId, name }`
- Client-side: reads the source's active definition, then `create_workflow` with it. Schedules/runs not copied.

### `read_workflow`
- Input: `{ workflowId, view: 'graph' | 'node' | 'full', nodeName? }` (`nodeName` required for `node`)
- Output: `{ _meta: { workflowId, versionId, versionNumber, status, apiEnabled, apiUrlSlug }, ... }` — `graph` (nodes/edges + metadata, no node code), `node` (one node), `full` (entire definition). Pass `_meta.versionId` to `edit_workflow`.
- → `GET /api/agent/workflows/{id}`; `graph`/`node` views derived client-side.

### `update_workflow`
- Input: `{ workflowId, name?, description?, status?, apiEnabled?, apiUrlSlug? }`
- Output: the updated workflow
- `status: active` needs a published version; `disabled` auto-pauses schedules. → `PATCH /api/agent/workflows/{id}`

### `delete_workflow`
- Input: `{ workflowId }` · Output: `{ success: true }` · soft delete → `DELETE /api/agent/workflows/{id}`

## Editing

### `edit_workflow`
- Input: `{ workflowId, patch, expectedActiveVersionId? }`
  ```ts
  patch = {
    nodes?: { add?: Node[], update?: [{ name, patch }], remove?: string[] },
    edges?: { add?: Edge[], remove?: Edge[] },
    // any top-level WorkflowSchema field: settings deep-merges, others replace
  }
  ```
- Output: `{ ok: true, versionId, versionNumber, deduped }` or `{ error: { code, message, issues? } }`
- Client reads the active definition, applies the patch (order: `nodes.remove` → `nodes.add` → `nodes.update` [rename rewrites edges] → `edges.remove` → `edges.add` → top-level), then PUTs the full definition. The server validates → a new version (one edit, one version). `expectedActiveVersionId` (from `read_workflow`'s `_meta`) gives optimistic concurrency. → `GET` + `PUT /api/agent/workflows/{id}`

## Versions

### `list_versions`
- Input: `{ workflowId, limit?, cursor?, named?, source? }`
- Output: `{ items: [{ versionId, versionNumber, name, source, createdAt }], nextCursor, activeVersionId }` → `GET /api/agent/workflows/{id}/versions`

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
- Output: `{ scheduleId }` → `POST /api/agent/workflows/{id}/schedules`

### `update_schedule`
- Input: `{ workflowId, scheduleId, recurrenceRule?, name?, startAt?, enabled?, inputResourceName? }` — `enabled` maps to status active/paused
- Output: `{ scheduleId }` → `PATCH …/schedules/{scheduleId}`

### `delete_schedule`
- Input: `{ workflowId, scheduleId }` · Output: `{ success: true }` → `DELETE …/schedules/{scheduleId}`

## Runs

### `run_workflow`
- Input: `{ workflowId, input?, environment? }` (`environment`: development | staging | preview | production, default production)
- Output: `{ sessionId, status: 'queued' }` · `input` validated against `inputSchema`; `lifecycle_gated` if disabled / no active version. `environment` is sent as a query param. → `POST /api/agent/workflows/{id}/run`

### `list_runs`
- Input: `{ workflowId?, status?, limit?, cursor? }` · Output: `{ items: [{ sessionId, workflowId, status, source, startedAt, endedAt, durationMs }], nextCursor }` → `GET /api/agent/sessions`

### `get_run`
- Input: `{ sessionId, include?: ('timeline' | 'io' | 'logs' | 'recording')[], logsCursor? }`
- Output: `{ sessionId, workflowId, versionId, status, source, input, output, startedAt, endedAt, durationMs }` plus, when requested: `timeline` `[{ name, type, status, startedAt, endedAt, durationMs }]`, `nodeIO` `[{ name, input, output }]`, `recordingUrl`, `logs` `{ entries, nextCursor }`.
- timeline/io ← `GET /sessions/{id}/nodes`; recording ← the session; **logs ← `/sessions/{id}/logs` (best-effort — returns `null` + `logsNote` until that endpoint is deployed).**

### `cancel_run`
- Input: `{ sessionId }` · Output: `{ success: true, status: 'canceled' }` → `POST /sessions/{id}/stop`

## Human-in-the-loop

### `list_hitl_tasks`
- Input: `{ sessionId?, status?, limit?, cursor? }` (`status`: pending | completed | expired)
- Output: `{ items: [{ taskId, sessionId, workflowId, nodeName, prompt, actions, isApproval, fields, status, createdAt, expiresAt }], nextCursor }` → `GET /api/agent/hitl/tasks`

### `complete_hitl_task`
- Input: `{ taskId, action, fields? }` · Output: `{ success: true }` → `POST /api/agent/hitl/tasks/{taskId}/complete`

## Secrets

Project-scoped. Values are never returned.

### `list_secrets`
- Input: `{ lifecycle?, limit?, cursor? }` · Output: `{ items: [{ key, last4, lifecycle, updatedAt }], nextCursor }`

### `set_secrets`
- Input: `{ secrets: [{ key, value, description?, lifecycle? }] }` · Output: `{ updated: [keys] }` · upsert by key (resolves key→id, then PUT or POST)

### `delete_secret`
- Input: `{ key }` · Output: `{ success: true }` · resolves key→id

## Resources

Data resources, referenced by name from `block`/`document` nodes and schedule inputs. Each has a `lifecycle` (development | preview | active).

### `list_resources`
- Input: `{ kind?, lifecycle?, search?, limit?, cursor? }` · Output: `{ items: [{ name, kind, description, lifecycle, updatedAt }], nextCursor }`

### `get_resource`
- Input: `{ name, lifecycle? }` · Output: `{ name, kind: 'data', value, description, lifecycle, updatedAt }`

### `set_resource`
- Input: `{ name, value, description?, lifecycle? }` · Output: `{ name }` · upsert by name; omitting `lifecycle` seeds all stages. File-resource uploads not supported.

### `delete_resource`
- Input: `{ name, lifecycle? }` · Output: `{ success: true }`

## Extractors

Read-only. `document` nodes reference an `extractorId`; authoring is not exposed.

### `list_extractors`
- Input: `{ search?, limit?, cursor? }` · Output: `{ items: [{ extractorId, name, activeVersionId, description }], nextCursor }`

### `get_extractor`
- Input: `{ extractorId, view?: 'summary' | 'full' }` · Output: `{ extractor }`

## Known gaps

- **Session logs**: studio `/api/agent/sessions/{id}/logs` is pending; `get_run` logs return `null` + a note until it's deployed.
- Schedules are **UTC-only**.
- File-resource uploads and extractor authoring are not yet available.

## Roadmap

- Per-project API keys (today the caller's project-scoped studio key is forwarded as-is).
- Session logs + recording surfaced once the studio endpoint lands.
- Extractor authoring and file-resource uploads.
