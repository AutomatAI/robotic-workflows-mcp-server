# Robotic Workflows MCP Server

**Claude Build Day submission.** A remote [MCP](https://modelcontextprotocol.io/) server that lets a Claude agent **build, deploy, run, and debug real RPA workflows** on [Automat](https://runautomat.com/) — browser/API automations that then run on their own schedule, deterministically, **with zero LLM tokens per run.**

> The agent writes the automation *once* (using tokens); the workflow then runs forever on a cron with **no tokens per run**. Token-cheap to create, token-free to operate.

## The brief

- **Problem.** Back-office/RPA automations take days to build and stay locked inside builder UIs. An AI agent can *do* a task once, but re-doing it every run burns tokens and isn't repeatable or schedulable.
- **Who it's for.** Anyone with a recurring browser/API task — ops, back-office, founders — and the agents acting on their behalf.
- **Done looks like.** From a chat/agent: *"build a workflow that does X on a schedule."* The agent authors it through this MCP server, deploys it live, runs it, and returns a recording — and it keeps running on its schedule with no tokens.

## What we built at Build Day

This repo is the **agent-facing layer**: one Vercel Function (`api/mcp.ts`) exposing **32 MCP tools** that forward to Automat studio's project-scoped agent API. Built during the event:

- **Full tool surface** — discover (`get_docs`, `get_workflow_schema`, `list_*`), **build** (`create_workflow`, `edit_workflow` composite-patch model, `read_workflow`), manage (versions, lifecycle, schedules), **run & debug** (`run_workflow`, `get_run` with timeline/io/recording, `cancel_run`), plus secrets, resources, extractors, and HITL.
- **`get_docs`** — serves the runtime authoring model (code-node globals, `$('NodeName')`, `fetch`, worked examples) so an agent writes working `code` nodes with no source access.
- **Pass-through auth** — the caller's project key is forwarded per request; **no secrets stored** in this public repo.
- *(The backend it forwards to — studio's `/api/agent/*` — was built in parallel in our private studio repo.)*

## Demo — "Sauce Demo Shopper"

A Claude agent built this **through the MCP server**: a deterministic Playwright `code` node that logs into saucedemo.com, adds an item, and checks out — **recorded**, ~9s/run, **0 tokens per run**, deployed `active` and schedulable.

- Authored via `create_workflow` + `edit_workflow`, executed via `run_workflow`, recording fetched via `get_run(include:["recording"])`.
- When the live run hit a native Chrome "breached-password" dialog that swallowed clicks, the agent reproduced it with Chrome DevTools and rewrote the clicks as `page.evaluate(() => el.click())` — **self-corrected**, then re-ran green.

## Try it / verify

Live, and "done" is verifiable by the model with no human in the loop:

- **Responding URL** — `https://workflows.runautomat.com/api/mcp` answers `tools/list` and `tools/call` over Streamable HTTP.
- **Connect any MCP client** with a project key (see [Connect a client](#connect-a-client)) and run the loop: `get_docs` → `create_workflow` → `run_workflow` → `get_run`.
- **Acceptance checklist (rubric).** (1) endpoint lists **35 tools**; (2) `create_workflow` + `edit_workflow(patch)` each save a new version; (3) `run_workflow` → `get_run` returns `status:"completed"` with structured `output`; (4) a browser workflow returns a `recordingUrl`.

## How Claude built it (Opus 4.8)

Opus 4.8 drove the whole build: it explored the studio + runtime repos to design the tool schemas, grounded the descriptions in MCP best practices, and **self-verified** — running a full stress test across every tool and real workflow runs *through its own tools*, then fixing a live browser failure with Chrome DevTools. It's repeatable: push to `main` auto-deploys, and `get_docs` + the tool surface let any agent rerun the build loop on a brand-new task.

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

**Auth note:** a PAT is scoped to the studio environment it was minted in. Use a token minted at `https://studio.runautomat.com/settings` for production — a preview/staging token will 401 against prod (different database).

## Connect a client

Replace `pat_…` with your personal access token. A PAT spans every project you can access, so a target project must be selected — the primary way is the **`set_project` tool** (the agent calls it once with the project UUID; the server injects it into every subsequent API call, best-effort warm-instance memory that self-heals via a "Missing project id" error → re-call `set_project`). Alternatively pin it on the connection: `&project_id=<uuid>` on the URL, an `x-project-id` header, or `STUDIO_DEFAULT_PROJECT_ID` on the server (`set_project` overrides all three). Secrets tools additionally need the Doppler identifiers (`dopplerProject`/`dopplerConfig` tool inputs, or `STUDIO_DOPPLER_PROJECT`/`STUDIO_DOPPLER_CONFIG`).

**Token tiers:** read tokens list/inspect (no definition JSON — `read_workflow` `full`/`node` need an authorship-tier PAT; `graph` degrades gracefully); write tokens also run workflows / stop sessions / complete HITL tasks; workflow, schedule, secret, and resource mutations need authorship (author role + write token). Tier ledger: studio `docs/PROGRAMMATIC_ACCESS.md`.

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
npx @modelcontextprotocol/inspector
# Streamable HTTP → https://workflows.runautomat.com/api/mcp?api_key=pat_…&project_id=<uuid>
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

Live reference for the 35 tools. Each forwards to the studio **public v1 API** (`STUDIO_API_BASE_URL` + `/api/v1/projects/{projectId}/*`), passing the caller's PAT; the project comes from the connection (`project_id`). The build/edit flow mirrors studio's own builder agent: `read_workflow` → `edit_workflow(patch)` with server-side validation.

## Conventions

- **Transport.** Streamable HTTP (stateless), at `https://workflows.runautomat.com/api/mcp`.
- **Scope.** One key = one project. No tool takes a `projectId`.
- **Workflow definition.** The `@automat/runtime` `WorkflowSchema`: `{ name, description?, instructions?, notes?, settings, nodes[], edges[], sessionFields?, inputSchema?, outputSchema?, helpers?, files?, runtimeVersion? }`. Nodes are a discriminated union on `type` (`start`, `end`, `block`, `decision`, `document`, `hitl`). Edges are `{ from, to, handle? }`. Call `get_workflow_schema` for the exact shape.
- **Errors.** On failure a tool returns result text `{ "error": { "code", "message", "issues"? } }`. Codes: `not_found`, `validation_failed`, `version_conflict`, `conflict`, `lifecycle_gated`, `forbidden`, `bad_request`, `rate_limited`, `unauthorized`, `internal_error`. `issues[]` accompanies `validation_failed`.
- **Pagination.** List tools take `limit` (default 25, max 100) and `cursor`, and return `{ items, nextCursor }` (the cursor wraps the API's page number).

Each tool lists its **input**, **output**, and the backing API call (shown in legacy `/api/agent/*` form; the client rewrites it onto `/api/v1/projects/{projectId}/*` at request time).

## Context & schema

### `list_projects`
Discovery — the projects this token can access (allowlist-scoped tokens see only their allowlist). Use it to pick a `set_project` target.
- Input: `{ limit?, cursor? }`
- Output: `{ items: [{ projectId, name }], nextCursor }`
- → `GET /api/v1/projects` (the one project-agnostic list)

### `set_project`
Selects the target Studio project for every subsequent call — **call first** when the connection has no `?project_id=`. Validates the id against the `list_projects` discovery listing (a project-scoped probe can't tell a typo from an empty project on an all-projects token). Best-effort warm-instance memory: a "Missing project id" error later just means "call `set_project` again".
- Input: `{ projectId }` (UUID — discover via `list_projects`)
- Output: `{ projectId, validated: true }`
- → validates via `GET /api/v1/projects`

### `get_docs`
Authoring guide — **call first**. How to write `code`/`decision` nodes: globals (`$('NodeName')`, `fetch`, `secrets`, `page`/`context`, `logger`), async/`return` semantics, node types, browser/recording, schedules, and worked examples.
- Input: `{ topic?: 'overview'|'codeNodes'|'nodeTypes'|'browser'|'secrets'|'schedules'|'examples' }`
- Output: the docs (all sections, or one `topic`)

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
- Output: `{ _meta: { workflowId, versionId, versionNumber, status, apiEnabled, apiUrlSlug }, ... }` — `graph` (nodes/edges + metadata — no code bodies, but per-node `codeChars`, decision `branches`/`elseLabel`, and a `helpers` index `[{name, description, codeChars}]`), `node` (one node incl. code), `full` (entire definition incl. helper code). Pass `_meta.versionId` to `edit_workflow`/`edit_node_code`.
- Tiers: `full`/`node` return definition JSON → authorship-tier PAT required (403 `forbidden` otherwise); `graph` works with any token, degrading to the server's lean names/types+edges view without authorship.
- → `GET /api/agent/workflows/{id}?view=…`; the rich `graph` projection derives from `view=full`, falling back to the server's `view=graph` on a tier 403.

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
- Best for structural edits; `nodes.update` replaces each patched field wholesale — for partial code changes use `edit_node_code`.

### `edit_node_code`
- Input: `{ workflowId, nodeName, oldString, newString, field?: 'code' | 'instructions' | 'expression', replaceAll?, expectedActiveVersionId? }`
- Output: `{ ok: true, versionId, versionNumber, deduped, replacements, fieldChars }` or `{ error: { code, message } }`
- Surgical find/replace inside one node — the agent sends only the changed snippet instead of resending a multi-KB `code` string. `oldString` must match exactly and occur once (or pass `replaceAll`); an ambiguous match returns the occurrence count, a miss returns the field sizes. `field: 'expression'` spans the legacy `expression` plus every decision `branches[i].expression`. Same read-modify-PUT + optimistic-concurrency path as `edit_workflow`. → `GET` + `PUT /api/agent/workflows/{id}`

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
- Input: `{ workflowId, input?, previewBranch? }`
- Output: `{ sessionId, status: 'queued' }` · `input` validated against `inputSchema`; `lifecycle_gated` if disabled / no active version. → `POST /api/agent/workflows/{id}/run`
- **Defaults to the stable production Trigger runtime** — studio resolves its deployment's default deploy tier (production on a prod studio). This is the path for all normal runs.
- **`previewBranch` is an explicit opt-in** — set it ONLY to run against a specific deployed preview-branch runtime (sends `environment=preview` + that branch). The branch must have a running preview worker or the run stalls in `queued`; that's why it's off by default and never inferred.

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
