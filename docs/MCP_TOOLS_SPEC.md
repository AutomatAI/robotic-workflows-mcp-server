# Automat Workflows MCP — Tool Specification

Status: **draft for review** · Audience: (1) MCP server implementation (schemas now, dummy bodies), (2) thin-client contract for studio.

This spec defines every tool the MCP server will expose so AI agents can **build, manage, run, and debug** Automat RPA workflows end-to-end. It mirrors the proven interface of studio's own builder agent (`studio/lib/builder/ai/tools.ts`): a `read_workflow` + `edit_workflow(patch)` loop with server-side validation.

---

## 1. Architecture & conventions

- **Transport:** Streamable HTTP (stateless), deployed on Vercel. Endpoint: `https://workflows.runautomat.com/api/mcp`.
- **Integration model (decided):** the MCP server is a **thin forwarder**. Each tool calls an **API-key-authenticated, single-project-scoped** endpoint in studio (the "thin client") that **reuses existing studio code** (RPCs, `WorkflowSchema`, `applyWorkflowPatch`, `runWorkflowWithGates`, etc.). The MCP server holds no DB credentials and embeds no `@automat/runtime` internals.
- **Auth & scoping (decided):** one API key ⇒ one `project_id`. **No tool takes `projectId`** — scope is implicit from the key. The thin client resolves the project from the key and enforces org/project RLS.
- **IDs:** all UUIDs — `workflowId`, `versionId`, `sessionId`, `scheduleId`, `taskId`.
- **Workflow definition:** the canonical `@automat/runtime` `WorkflowSchema`: `{ name, description?, instructions?, notes?, settings, nodes[], edges[], sessionFields?, inputSchema?, outputSchema?, helpers?, files?, runtimeVersion? }`. Nodes are a discriminated union by `type` (`start`/`end`/`block`/`decision`/`document`/`hitl`; `api`/`process` reserved). Edges: `{ from, to, handle? }`.
- **Error convention (all tools):** on failure, return an MCP error result whose text is a JSON object:
  ```json
  { "error": { "code": "version_conflict", "message": "…", "issues": [{ "path": "nodes.2.type", "message": "…" }] } }
  ```
  Stable codes: `not_found`, `validation_failed`, `version_conflict`, `duplicate_name`, `lifecycle_gated`, `forbidden`, `bad_request`, `rate_limited`. `issues[]` present for `validation_failed`.
- **Pagination:** list tools accept `limit` (default 25, max 100) + `cursor`; return `{ items, nextCursor }`.
- **Result size:** large payloads (logs, full definitions, run IO) are opt-in or paginated to respect agent context limits.

---

## 2. Tool catalog

> For each tool: **Input** (params + types), **Output**, **Thin-client reuse** (what studio code/endpoint backs it), **Notes**.

### A. Context & schema

#### `list_runtime_versions`
Lists the runtime versions a workflow can be pinned to. Agents only need this to choose a non-default version — `get_workflow_schema` and `create_workflow` default to `latest`.
- **Input:** none
- **Output:** `{ versions: [{ version, isLatest, releasedAt }] }`
- **Reuse:** runtime version registry / release list.

#### `get_workflow_schema`
Returns the workflow/node schema + catalog so the agent knows how to construct valid definitions and patches. Pinned to a runtime version.
- **Input:** `{ runtimeVersion?: string }` (defaults to `latest`)
- **Output:** `{ runtimeVersion, jsonSchema, nodeCatalog: [{ type, summary, requiredFields, optionalFields, example }], edgeRules, examples: [{ title, definition }] }`
- **Reuse:** serialize `WorkflowSchema`/`NodeSchema` to JSON Schema at the requested runtime version; curate 2–3 worked examples.
- **Notes:** studio's agent self-serves this by reading the runtime repo; external agents can't, so the thin client must serve a curated schema. Consider exposing as an MCP **resource** too.

### B. Workflow CRUD

#### `list_workflows`
- **Input:** `{ status?: 'development'|'preview'|'active'|'disabled', search?: string, limit?, cursor? }`
- **Output:** `{ items: [{ workflowId, name, description, status, activeVersionId, apiEnabled, apiUrlSlug, sessionCount, updatedAt }], nextCursor }`
- **Reuse:** `GET /api/workflows` logic (already paginated, with stats).

#### `create_workflow`
- **Input:** `{ name: string, description?: string, definition?: Workflow, runtimeVersion?: string }` — `runtimeVersion` defaults to `latest`; if `definition` omitted, create a minimal `start → end` scaffold.
- **Output:** `{ workflowId, versionId, versionNumber, status: 'development' }`
- **Reuse:** `createWorkflowWithVersionViaRpc()` (`create_workflow_with_version`). Validate `definition` with `WorkflowSchema`.

#### `copy_workflow`
Clone an existing workflow (v1 = clone of source's active version) into the same project.
- **Input:** `{ workflowId, name?: string }`
- **Output:** `{ workflowId, name }`
- **Reuse:** `POST /api/projects/[projectId]/workflows/[workflowId]/clone`. New workflow starts `development`, `apiEnabled:false`. Schedules/sessions not copied.

#### `read_workflow`
Read the current (active) workflow at three granularities — keeps reads cheap.
- **Input:** `{ workflowId, view: 'graph'|'node'|'full', nodeName?: string }` (`nodeName` required when `view:'node'`)
- **Output (all views include `_meta`):** `{ _meta: { workflowId, versionId, versionNumber, status, apiEnabled, apiUrlSlug }, ...viewPayload }`
  - `graph`: metadata + nodes (name/type/position + routing fields) + edges, **no per-node code** ← reuse `buildGraphView`
  - `node`: the named node's full content
  - `full`: entire definition JSON
- **Reuse:** `buildGraphView` (studio) + workflow row metadata.

#### `update_workflow`
Update workflow metadata + lifecycle + API trigger config (everything that is NOT the graph definition).
- **Input:** `{ workflowId, name?, description?, status?: 'development'|'preview'|'active'|'disabled', apiEnabled?: boolean, apiUrlSlug?: string }`
- **Output:** `{ workflowId, name, description, status, apiEnabled, apiUrlSlug }`
- **Reuse:** `PATCH /api/workflows/[workflowId]` (status/api) + name/description update.
- **Notes:** `status:'active'` requires an `activeVersionId` (else `lifecycle_gated`/`bad_request`). Switching to `disabled` auto-pauses schedules (existing cascade). `name`/`description` also live in the definition — thin client should keep the row and active definition consistent.

#### `delete_workflow`
- **Input:** `{ workflowId }`
- **Output:** `{ success: true }`
- **Reuse:** `DELETE /api/builder/workflow` (soft delete; cascades to sessions/schedules/channels).

### C. Editing (the build loop)

#### `edit_workflow`
Apply a composite patch to the workflow's active definition. **Auto-saves on valid schema; returns field-level errors if invalid (no separate save tool).**
- **Input:** `{ workflowId, patch: WorkflowPatch, expectedActiveVersionId?: string }`
  - `WorkflowPatch` (mirror `WorkflowPatchSchema`):
    ```ts
    {
      nodes?: { add?: Node[], update?: [{ name: string, patch: object }], remove?: string[] },
      edges?: { add?: Edge[], remove?: Edge[] },
      // plus any top-level WorkflowSchema fields (settings deep-merges; others replace)
      name?, description?, instructions?, notes?, settings?, sessionFields?,
      inputSchema?, outputSchema?, helpers?, files?, runtimeVersion?
    }
    ```
  - Apply order (reuse studio semantics): `nodes.remove` (drops touching edges) → `nodes.add` → `nodes.update` (rename via `patch.name` auto-rewrites edges) → `edges.remove` → `edges.add` → top-level (`settings` deep-merge, others replace).
- **Output (success):** `{ ok: true, versionId, versionNumber, deduped: boolean }`
- **Output (failure):** `{ error: { code:'validation_failed'|'version_conflict', message, issues? } }`
- **Reuse:** `applyWorkflowPatch` + `validateAndUpdateWorkflow` (`WorkflowSchema.safeParse`) + `create_workflow_version` RPC.
- **Notes / decision (resolved):** auto-save creates a **new immutable version per call** — **1 edit = 1 version, no coalescing**. `expectedActiveVersionId` gives optimistic concurrency against concurrent human edits.
- **Validation (resolved):** validation is **inline only** — `edit_workflow` validates and returns `issues[]` on failure. No standalone `validate_workflow` tool.

### D. Versions

#### `list_versions`
- **Input:** `{ workflowId, limit?, cursor?, named?: boolean, source?: string }`
- **Output:** `{ items: [{ versionId, versionNumber, name, source, author, createdAt, isActive }], nextCursor, activeVersionId }`
- **Reuse:** `GET /api/projects/[projectId]/workflows/[workflowId]/versions`.

#### `get_version`
- **Input:** `{ workflowId, versionId }`
- **Output:** `{ versionId, versionNumber, name, source, createdAt, definition }`
- **Reuse:** `GET …/versions/[versionId]`.

#### `revert_to_version`
Non-destructive clone-forward: appends the target definition as a new version.
- **Input:** `{ workflowId, versionId, expectedActiveVersionId?: string }`
- **Output:** `{ versionId, versionNumber, revertedFromVersionNumber }`
- **Reuse:** `POST …/versions/[versionId]/revert`.

### E. Schedules

A workflow may have multiple schedules (RFC 5545 recurrence).
- **Shape (from `schedules/route.ts`):** `{ scheduleId, name?, recurrence_rule (RFC 5545), start_at?, timezone?, enabled, input_resource_name? }`. Input is supplied via a linked `project_resource` (`input_resource_name`), gated against the workflow's `inputSchema`.

#### `list_schedules`
- **Input:** `{ workflowId }`
- **Output:** `{ items: [{ scheduleId, name, recurrenceRule, startAt, timezone, enabled, lastSession?: { id, status, createdAt, durationMs, errorMessage } }] }`
- **Reuse:** `GET …/schedules`.

#### `create_schedule`
- **Input:** `{ workflowId, recurrenceRule: string, name?, startAt?: string, timezone?, enabled?: boolean, inputResourceName?: string }`
- **Output:** `{ scheduleId }`
- **Reuse:** `POST …/schedules` (`CreateScheduleBodySchema`; validates `input_resource_name` exists + `checkScheduleInput` against workflow inputSchema).

#### `update_schedule`
- **Input:** `{ workflowId, scheduleId, recurrenceRule?, name?, startAt?, timezone?, enabled?, inputResourceName? }`  (set `enabled` to pause/resume)
- **Output:** `{ scheduleId }`
- **Reuse:** `PATCH …/schedules/[scheduleId]`.

#### `delete_schedule`
- **Input:** `{ workflowId, scheduleId }`
- **Output:** `{ success: true }`
- **Reuse:** `DELETE …/schedules/[scheduleId]`.

### F. Run / monitor / debug

#### `run_workflow`
Trigger a run of the active version.
- **Input:** `{ workflowId, input?: object, environment?: 'development'|'staging'|'preview'|'production' }`
- **Output:** `{ sessionId, status: 'queued' }`
- **Reuse:** `runWorkflowWithGates()`. Validates `input` against `inputSchema`; `lifecycle_gated` if disabled / no active version.

#### `list_runs`
- **Input:** `{ workflowId?: string, status?: 'pending'|'queued'|'executing'|'paused'|'completed'|'failed'|'canceled', limit?, cursor? }`
- **Output:** `{ items: [{ sessionId, workflowId, status, source, startedAt, endedAt, durationMs }], nextCursor }`
- **Reuse:** `GET /api/sessions` logic.

#### `get_run`
Run details; opt-in deep data via `include`.
- **Input:** `{ sessionId, include?: Array<'timeline'|'io'|'logs'|'recording'>, logsCursor?: string }`
- **Output:** `{ sessionId, workflowId, versionId, status, source, input, output, outputSchemaValid, startedAt, endedAt, durationMs,`
  `  timeline?: [{ name, type, status, startedAt, endedAt, durationMs }],`  // when 'timeline'
  `  nodeIO?: [{ name, input, output }],`                                   // when 'io' (may be large)
  `  logs?: { entries: [{ ts, level, nodeName, message }], nextCursor },`  // when 'logs' (paginated)
  `  recordingUrl?: string }`                                              // when 'recording' (if browser recording enabled)
- **Reuse:** `sessions` + `session_attempts` (`recording_path`) + `session_nodes` (timeline/IO); logs from Trigger.dev.
- **Notes:** default (no `include`) returns summary + status + input/output only. `io` and `logs` are the debug payloads — keep paginated/bounded.

#### `cancel_run`
- **Input:** `{ sessionId }`
- **Output:** `{ success: true, status: 'canceled' }`
- **Reuse:** Trigger.dev cancel + session status update (thin client must wrap; not directly exposed today).

### G. Human-in-the-loop (HITL)

#### `list_hitl_tasks`
- **Input:** `{ sessionId?: string, status?: 'pending'|'completed'|'expired', limit?, cursor? }`
- **Output:** `{ items: [{ taskId, sessionId, workflowId, nodeName, prompt, actions: [{ id, label }], isApproval, fields, status, createdAt, expiresAt }], nextCursor }`
- **Reuse:** `GET /api/projects/[projectId]/hitl/tasks`.

#### `complete_hitl_task`
Submit a human decision to resume a paused run.
- **Input:** `{ taskId, action: string, fields?: object }`
- **Output:** `{ success: true }`
- **Reuse:** `POST /api/projects/[projectId]/hitl/complete` (validates against the task's field schema; completes the wait token).

### H. Secrets (new studio secrets manager — replaces Doppler)

Project-scoped. **Values are never returned.**
- **Notes:** confirm exact shape with the colleague's secrets-manager implementation (in progress). Spec below is the proposed contract.

#### `list_secrets`
- **Input:** `{ limit?, cursor? }`
- **Output:** `{ items: [{ key, description?, updatedAt }], nextCursor }`  — **no values**

#### `set_secrets`
Create/update one or more secrets (upsert).
- **Input:** `{ secrets: [{ key: string, value: string, description?: string }] }`
- **Output:** `{ updated: string[] }`  (keys touched; no values echoed)

#### `delete_secret`
- **Input:** `{ key: string }`
- **Output:** `{ success: true }`

### I. Resources & extractors

#### Resources (`project_resources`) — full management
`block`/`document` nodes and schedule inputs reference `project_resources` by name, so agents need to create them for true end-to-end setup (e.g. a schedule's `input_resource_name`).

##### `list_resources`
- **Input:** `{ kind?: 'data'|'file', search?, limit?, cursor? }`
- **Output:** `{ items: [{ name, kind, description?, updatedAt }], nextCursor }`  — **no values**
- **Reuse:** `project_resources` table.

##### `get_resource`
- **Input:** `{ name: string }`
- **Output (data):** `{ name, kind:'data', value, description?, updatedAt }` · **(file):** `{ name, kind:'file', downloadUrl, sizeBytes, contentType, updatedAt }`
- **Reuse:** `project_resources` read (+ signed URL for files).

##### `set_resource` (upsert)
- **Input:** `{ name: string, value: Json, description?: string }`  — **data resources only** in v1
- **Output:** `{ name }`
- **Reuse:** `project_resources` upsert.
- **Notes:** **file** resources require a binary-upload story (signed-URL upload or base64) — **deferred**; `set_resource` handles JSON data resources only for now.

##### `delete_resource`
- **Input:** `{ name: string }`
- **Output:** `{ success: true }`

#### Extractors

##### `list_extractors`
`document` nodes require an `extractorId`.
- **Input:** `{ search?: string, limit?, cursor? }`
- **Output:** `{ items: [{ extractorId, name, activeVersionId, description? }], nextCursor }`
- **Reuse:** extractors table / studio extractors API.

##### `get_extractor`
- **Input:** `{ extractorId, view?: 'summary'|'full' }`
- **Output:** summary (name, fields overview, activeVersionId) or full extractor definition.
- **Reuse:** studio extractor read.

> **Full extractor *authoring* (create/edit/version) is deferred to its own milestone.** An extractor is a second builder surface with its own definition, fields, and version history — comparable in scope to the workflow builder. When we add it, it should **mirror this same `read`/`edit(patch)` patch-model pattern**. For v1, agents can *discover and reference* extractors (`list`/`get`) but not author them; humans create extractors in studio. Same applies to **file** resources (upload story pending).

---

## 3. Thin-client contract summary (for the colleague)

Expose **API-key-authed, single-project-scoped** endpoints backing the tools above. Maximize reuse of existing studio code:

| Capability | Reuse |
|---|---|
| project from key | key → `projects` lookup; enforce RLS |
| schema | serialize `WorkflowSchema`/`NodeSchema` per runtime version |
| list/get/create/copy/delete workflow | `/api/workflows`, `/api/builder/workflow`, `create_workflow_with_version`, clone route |
| read (graph view) | `buildGraphView` |
| **edit (patch)** | `WorkflowPatchSchema` + `applyWorkflowPatch` + `validateAndUpdateWorkflow` + `create_workflow_version` (1 edit = 1 version) |
| update metadata/lifecycle/api | `PATCH /api/workflows/[id]` + name/description |
| versions (list/get/revert) | `…/versions*` routes |
| schedules | `…/schedules*` routes |
| run / list / get / cancel | `runWorkflowWithGates`, `/api/sessions`, `session_*` tables, Trigger.dev cancel |
| HITL | `/api/projects/[id]/hitl/*` |
| secrets | new secrets manager (confirm shape) |
| extractors / resources | extractors API, `project_resources` |

**Key asks:**
1. A stable **API-key auth** middleware that resolves `project_id` (single-project keys).
2. `edit_workflow` backed by the existing patch+validate code (**1 edit = 1 version**, no coalescing).
3. `get_workflow_schema` serving a **runtime-version-pinned JSON schema** (external agents can't read the runtime repo like the in-studio agent does).
4. `cancel_run` wrapper (not currently a public endpoint).
5. Secrets-manager endpoints (list = names only, set = upsert, delete).

---

## 4. Decisions

**Resolved:**
1. **Versioning** — ✅ **1 edit = 1 version** (no coalescing). Every `edit_workflow` appends a new immutable version.
2. **`get_run`** — ✅ keep the single tool with the `include: [timeline|io|logs|recording]` param (logs paginated).
3. **`validate_workflow`** — ✅ dropped; validation is inline in `edit_workflow` only.
4. **MCP resources** — ✅ **tools only, no resources** for v1 (exa-mcp-server is likewise tools-only). `get_workflow_schema` is a tool; an MCP-resource mirror for `@`-mentions can come later.
5. **Project context** — ✅ replaced `get_project_context` with `list_runtime_versions`; `get_workflow_schema`/`create_workflow` default to `latest`.
6. **Extractor / file-resource authoring** — ✅ deferred to a later milestone; v1 is discover/reference only (`list`/`get`). Data-resource CRUD is in.

**Still open:**
1. **Secrets shape** — finalize `list_secrets`/`set_secrets`/`delete_secret` against the colleague's in-progress studio secrets manager.
