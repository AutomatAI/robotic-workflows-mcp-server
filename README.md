# Automat Workflows MCP Server

A remote [MCP](https://modelcontextprotocol.io/) server that lets AI agents build, run, and manage Automat RPA workflows — the same operations humans perform in the studio.

The server is a thin forwarder: each tool calls an API-key-authenticated, single-project endpoint in the studio app (the "thin client"), which reuses studio's existing validation, versioning, and execution code.

> **Status:** all 31 tools are implemented as schema-complete stubs — each has its real input schema and returns spec-shaped data marked `_stub: true`; handlers forward to the thin client as it comes online. (Connection liveness uses MCP's built-in protocol-level [ping](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping), so there is no `ping` tool.)

## Endpoint

```
https://workflows.runautomat.com/api/mcp
```

Streamable HTTP, stateless. The Vercel default URL (`https://robotic-workflows-mcp-server.vercel.app/api/mcp`) also resolves.

## Authentication

A single shared API key, accepted three ways (checked in order):

| Source | Use |
| --- | --- |
| `?api_key=<KEY>` query param | Claude web/desktop connector (its UI has no header field) |
| `x-api-key: <KEY>` header | generic clients |
| `Authorization: Bearer <KEY>` header | Claude Code CLI |

> The v1 key is hardcoded in [`api/mcp.ts`](api/mcp.ts) and committed to this repo. It guards stub tools only. Before the tools touch real data, set `MCP_API_KEY` in the Vercel project environment to override it.

## Connect a client

Replace `<KEY>` with the API key.

**Claude web / desktop** — Settings → Connectors → Add custom connector → URL:

```
https://workflows.runautomat.com/api/mcp?api_key=<KEY>
```

**Claude Code**

```bash
claude mcp add --transport http automat \
  "https://workflows.runautomat.com/api/mcp?api_key=<KEY>"
```

**MCP Inspector**

```bash
npx @modelcontextprotocol/inspector
# Streamable HTTP → https://workflows.runautomat.com/api/mcp?api_key=<KEY>
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

The tool contract — the source of truth for both this server (`api/mcp.ts`) and the studio thin client that backs each tool. The design mirrors studio's own builder agent (`studio/lib/builder/ai/tools.ts`): a `read_workflow` + `edit_workflow(patch)` loop with server-side validation.

## Conventions

- **Transport.** Streamable HTTP (stateless), at `https://workflows.runautomat.com/api/mcp`.
- **Integration.** The MCP server is a thin forwarder. Each tool calls an API-key-authenticated, single-project endpoint in studio that reuses existing code (`WorkflowSchema`, `applyWorkflowPatch`, `runWorkflowWithGates`, the version RPCs). The MCP server holds no database credentials and no `@automat/runtime` internals.
- **Auth & scope.** One API key maps to one `project_id`. No tool takes `projectId`; the thin client resolves it from the key and enforces org/project RLS.
- **IDs.** All UUIDs: `workflowId`, `versionId`, `sessionId`, `scheduleId`, `taskId`.
- **Workflow definition.** The `@automat/runtime` `WorkflowSchema`: `{ name, description?, instructions?, notes?, settings, nodes[], edges[], sessionFields?, inputSchema?, outputSchema?, helpers?, files?, runtimeVersion? }`. Nodes are a discriminated union on `type` (`start`, `end`, `block`, `decision`, `document`, `hitl`; `api`/`process` reserved). Edges are `{ from, to, handle? }`.
- **Errors.** On failure a tool returns a result whose text is `{ "error": { "code", "message", "issues"? } }`. Codes: `not_found`, `validation_failed`, `version_conflict`, `duplicate_name`, `lifecycle_gated`, `forbidden`, `bad_request`, `rate_limited`. `issues[]` accompanies `validation_failed`.
- **Pagination.** List tools take `limit` (default 25, max 100) and `cursor`, and return `{ items, nextCursor }`.
- **Payload size.** Large data (logs, full definitions, run I/O) is opt-in or paginated.

Each tool below lists its **input**, **output**, and the studio code the thin client should **reuse**.

## Context & schema

### `list_runtime_versions`
Runtime versions a workflow can pin to. Needed only to choose a non-default version; `get_workflow_schema` and `create_workflow` default to `latest`.
- Input: none
- Output: `{ versions: [{ version, isLatest, releasedAt }] }`
- Reuse: runtime version registry.

### `get_workflow_schema`
The workflow/node JSON schema, node catalog, and examples — how the agent learns to construct definitions and patches.
- Input: `{ runtimeVersion?: string }` (default `latest`)
- Output: `{ runtimeVersion, jsonSchema, nodeCatalog: [{ type, summary, requiredFields, optionalFields, example }], edgeRules, examples: [{ title, definition }] }`
- Reuse: serialize `WorkflowSchema`/`NodeSchema` to JSON Schema at the requested version. The in-studio agent reads the runtime repo for this; external agents can't, so the thin client serves it.

## Workflows

### `list_workflows`
- Input: `{ status?, search?, limit?, cursor? }` (`status`: development | preview | active | disabled)
- Output: `{ items: [{ workflowId, name, description, status, activeVersionId, apiEnabled, apiUrlSlug, sessionCount, updatedAt }], nextCursor }`
- Reuse: `GET /api/workflows`.

### `create_workflow`
- Input: `{ name, description?, definition?, runtimeVersion? }` — `runtimeVersion` defaults to `latest`; omitting `definition` creates a `start → end` scaffold.
- Output: `{ workflowId, versionId, versionNumber, status: 'development' }`
- Reuse: `createWorkflowWithVersionViaRpc()`; validate with `WorkflowSchema`.

### `copy_workflow`
Clone a workflow (v1 = clone of the source's active version) into the same project. Schedules and runs are not copied.
- Input: `{ workflowId, name? }`
- Output: `{ workflowId, name }`
- Reuse: `POST /api/projects/[projectId]/workflows/[workflowId]/clone`.

### `read_workflow`
Read the active workflow at one of three granularities.
- Input: `{ workflowId, view: 'graph' | 'node' | 'full', nodeName? }` (`nodeName` required for `node`)
- Output: `{ _meta: { workflowId, versionId, versionNumber, status, apiEnabled, apiUrlSlug }, ... }`
  - `graph`: metadata, nodes (name/type/position + routing fields), edges — no per-node code
  - `node`: the named node's full content
  - `full`: the entire definition
- Reuse: `buildGraphView` + the workflow row.

### `update_workflow`
Workflow metadata, lifecycle, and API-trigger config — not the graph (use `edit_workflow`).
- Input: `{ workflowId, name?, description?, status?, apiEnabled?, apiUrlSlug? }`
- Output: `{ workflowId, name, description, status, apiEnabled, apiUrlSlug }`
- Reuse: `PATCH /api/workflows/[workflowId]`.
- Notes: `status: 'active'` requires an `activeVersionId` (else `lifecycle_gated`). Moving to `disabled` auto-pauses schedules. `name`/`description` also live in the definition; keep the row and active definition consistent.

### `delete_workflow`
- Input: `{ workflowId }`
- Output: `{ success: true }`
- Reuse: `DELETE /api/builder/workflow` (soft delete; cascades to sessions, schedules, channels).

## Editing

### `edit_workflow`
Apply a composite patch to the active definition. Validates against `WorkflowSchema`; on success, saves a new immutable version (one edit, one version); on failure, returns `issues[]`. There is no separate save tool.
- Input: `{ workflowId, patch, expectedActiveVersionId? }`
  ```ts
  patch = {
    nodes?: { add?: Node[], update?: [{ name, patch }], remove?: string[] },
    edges?: { add?: Edge[], remove?: Edge[] },
    // any top-level WorkflowSchema field: settings deep-merges, others replace
  }
  ```
  Apply order: `nodes.remove` (drops touching edges) → `nodes.add` → `nodes.update` (renaming via `patch.name` rewrites edges) → `edges.remove` → `edges.add` → top-level.
- Output: `{ ok: true, versionId, versionNumber, deduped }` or `{ error: { code, message, issues? } }`
- Reuse: `WorkflowPatchSchema` + `applyWorkflowPatch` + `validateAndUpdateWorkflow` + `create_workflow_version`.
- Notes: `expectedActiveVersionId` gives optimistic concurrency against concurrent human edits.

## Versions

### `list_versions`
- Input: `{ workflowId, limit?, cursor?, named?, source? }`
- Output: `{ items: [{ versionId, versionNumber, name, source, author, createdAt, isActive }], nextCursor, activeVersionId }`
- Reuse: `GET …/workflows/[workflowId]/versions`.

### `get_version`
- Input: `{ workflowId, versionId }`
- Output: `{ versionId, versionNumber, name, source, createdAt, definition }`
- Reuse: `GET …/versions/[versionId]`.

### `revert_to_version`
Non-destructive: appends the target definition as a new version.
- Input: `{ workflowId, versionId, expectedActiveVersionId? }`
- Output: `{ versionId, versionNumber, revertedFromVersionNumber }`
- Reuse: `POST …/versions/[versionId]/revert`.

## Schedules

A workflow can have multiple schedules. A schedule uses an RFC 5545 recurrence rule; run input comes from a linked project resource (`inputResourceName`), validated against the workflow's `inputSchema`. Source: `schedules/route.ts`.

### `list_schedules`
- Input: `{ workflowId }`
- Output: `{ items: [{ scheduleId, name, recurrenceRule, startAt, timezone, enabled, lastSession?: { id, status, createdAt, durationMs, errorMessage } }] }`
- Reuse: `GET …/schedules`.

### `create_schedule`
- Input: `{ workflowId, recurrenceRule, name?, startAt?, timezone?, enabled?, inputResourceName? }`
- Output: `{ scheduleId }`
- Reuse: `POST …/schedules` (`CreateScheduleBodySchema`; checks the resource exists and gates input against `inputSchema`).

### `update_schedule`
- Input: `{ workflowId, scheduleId, recurrenceRule?, name?, startAt?, timezone?, enabled?, inputResourceName? }` (set `enabled` to pause/resume)
- Output: `{ scheduleId }`
- Reuse: `PATCH …/schedules/[scheduleId]`.

### `delete_schedule`
- Input: `{ workflowId, scheduleId }`
- Output: `{ success: true }`
- Reuse: `DELETE …/schedules/[scheduleId]`.

## Runs

### `run_workflow`
Trigger a run of the active version.
- Input: `{ workflowId, input?, environment? }` (`environment`: development | staging | preview | production)
- Output: `{ sessionId, status: 'queued' }`
- Reuse: `runWorkflowWithGates()`. Validates `input` against `inputSchema`; `lifecycle_gated` if disabled or no active version.

### `list_runs`
- Input: `{ workflowId?, status?, limit?, cursor? }` (`status`: pending | queued | executing | paused | completed | failed | canceled)
- Output: `{ items: [{ sessionId, workflowId, status, source, startedAt, endedAt, durationMs }], nextCursor }`
- Reuse: `GET /api/sessions`.

### `get_run`
Run summary by default; deeper data via `include`.
- Input: `{ sessionId, include?: ('timeline' | 'io' | 'logs' | 'recording')[], logsCursor? }`
- Output: `{ sessionId, workflowId, versionId, status, source, input, output, outputSchemaValid, startedAt, endedAt, durationMs }` plus, when requested:
  - `timeline`: `[{ name, type, status, startedAt, endedAt, durationMs }]`
  - `nodeIO`: `[{ name, input, output }]`
  - `logs`: `{ entries: [{ ts, level, nodeName, message }], nextCursor }`
  - `recordingUrl`: string (when browser recording is enabled)
- Reuse: `sessions` + `session_attempts` (`recording_path`) + `session_nodes`; logs from Trigger.dev.

### `cancel_run`
- Input: `{ sessionId }`
- Output: `{ success: true, status: 'canceled' }`
- Reuse: Trigger.dev cancel + session status update. Not a public endpoint today; the thin client must wrap it.

## Human-in-the-loop

### `list_hitl_tasks`
- Input: `{ sessionId?, status?, limit?, cursor? }` (`status`: pending | completed | expired)
- Output: `{ items: [{ taskId, sessionId, workflowId, nodeName, prompt, actions: [{ id, label }], isApproval, fields, status, createdAt, expiresAt }], nextCursor }`
- Reuse: `GET /api/projects/[projectId]/hitl/tasks`.

### `complete_hitl_task`
Submit a human decision to resume a paused run.
- Input: `{ taskId, action, fields? }`
- Output: `{ success: true }`
- Reuse: `POST /api/projects/[projectId]/hitl/complete` (validates against the task's field schema; completes the wait token).

## Secrets

Project-scoped. Values are never returned. Final shape pending the studio secrets manager (the one open item).

### `list_secrets`
- Input: `{ limit?, cursor? }`
- Output: `{ items: [{ key, description?, updatedAt }], nextCursor }` — names only

### `set_secrets`
Upsert one or more secrets.
- Input: `{ secrets: [{ key, value, description? }] }`
- Output: `{ updated: string[] }` — keys only

### `delete_secret`
- Input: `{ key }`
- Output: `{ success: true }`

## Resources

Project resources are referenced by name from `block`/`document` nodes and schedule inputs.

### `list_resources`
- Input: `{ kind?: 'data' | 'file', search?, limit?, cursor? }`
- Output: `{ items: [{ name, kind, description?, updatedAt }], nextCursor }` — no values
- Reuse: `project_resources`.

### `get_resource`
- Input: `{ name }`
- Output: data → `{ name, kind: 'data', value, description?, updatedAt }`; file → `{ name, kind: 'file', downloadUrl, sizeBytes, contentType, updatedAt }`
- Reuse: `project_resources` (signed URL for files).

### `set_resource`
Upsert a data resource. File uploads are deferred (need a signed-URL or base64 path).
- Input: `{ name, value, description? }` — data resources only
- Output: `{ name }`
- Reuse: `project_resources` upsert.

### `delete_resource`
- Input: `{ name }`
- Output: `{ success: true }`

## Extractors

`document` nodes reference an extractor by `extractorId`. v1 is discover/reference only — authoring an extractor is a separate builder surface (its own definition, fields, and versions) and is deferred. When added, it should reuse this `read`/`edit(patch)` pattern.

### `list_extractors`
- Input: `{ search?, limit?, cursor? }`
- Output: `{ items: [{ extractorId, name, activeVersionId, description? }], nextCursor }`
- Reuse: studio extractors API.

### `get_extractor`
- Input: `{ extractorId, view?: 'summary' | 'full' }`
- Output: summary (name, fields overview, activeVersionId) or the full definition.
- Reuse: studio extractor read.

## Thin-client contract

Expose API-key-authenticated, single-project endpoints backing the tools above, reusing existing studio code:

| Capability | Reuse |
| --- | --- |
| project from key | key → `projects`; enforce RLS |
| schema | serialize `WorkflowSchema`/`NodeSchema` per runtime version |
| list/get/create/copy/delete workflow | `/api/workflows`, `/api/builder/workflow`, `create_workflow_with_version`, clone route |
| read (graph view) | `buildGraphView` |
| edit (patch) | `WorkflowPatchSchema` + `applyWorkflowPatch` + `validateAndUpdateWorkflow` + `create_workflow_version` |
| update metadata/lifecycle/api | `PATCH /api/workflows/[id]` |
| versions | `…/versions*` routes |
| schedules | `…/schedules*` routes |
| runs | `runWorkflowWithGates`, `/api/sessions`, `session_*` tables, Trigger.dev cancel |
| HITL | `/api/projects/[id]/hitl/*` |
| secrets | new secrets manager (shape TBD) |
| resources / extractors | `project_resources`, extractors API |

New work required (not reusable as-is):

1. API-key auth middleware that resolves `project_id` from a single-project key.
2. A `cancel_run` wrapper (no public endpoint today).
3. `get_workflow_schema` serving a runtime-version-pinned JSON schema.
4. Secrets-manager endpoints (list = names only, set = upsert, delete).

## Decisions

Resolved:

- One edit, one version. Every `edit_workflow` appends an immutable version; no coalescing.
- `get_run` is a single tool with an `include` parameter (logs paginated).
- No standalone `validate_workflow`; validation is inline in `edit_workflow`.
- Tools only, no MCP resources, for v1.
- `list_runtime_versions` replaces a project-context tool; schema/create default to `latest`.
- Extractor authoring and file-resource uploads are deferred; v1 is discover/reference only. Data-resource CRUD is included.

Open:

- Secrets shape — finalize against the studio secrets manager.

## Roadmap

- Wire tools to the studio thin client (replace the stubs).
- Per-project API keys (v1 uses one shared key).
- Extractor authoring and file-resource uploads.
