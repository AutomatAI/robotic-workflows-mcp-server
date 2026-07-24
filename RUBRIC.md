# Acceptance Rubric — Robotic Workflows MCP Server

"Done" is verifiable with a Studio **personal access token** and an accessible project. Connect to the live server and check each criterion by calling the tools. Production activation still requires explicit human approval.

- **Live endpoint:** `https://workflows.runautomat.com/api/mcp` (Streamable HTTP)
- **Auth:** user-owned PAT via `?api_key=pat_…`, `x-api-key`, or `Authorization: Bearer`; project precedence is `project_id` → `x-project-id` → remembered `set_project` → server default. Remembered state is token+connector scoped when identity exists and PAT-global only for connector-less compatibility callers.

## Pass criteria

| # | Criterion | How to verify |
| --- | --- | --- |
| 1 | **Reachable & characterized** | `tools/list` includes the characterized tool baseline (incl. `get_docs`, `get_workflow_schema`, `create_workflow`, `edit_workflow`, `run_workflow`, `get_run`) and every tool has metadata plus an operation classification. This is not exhaustive Studio capability parity. |
| 2 | **Self-documenting** | `get_docs` returns the code-node authoring model — globals incl. `$('NodeName')`, `fetch`, and worked examples. |
| 3 | **Build** | `create_workflow` → `{ workflowId, versionId }`; `read_workflow(view:'graph')` returns the graph + `_meta`. |
| 4 | **Edit (patch model)** | `edit_workflow` with a composite patch → `{ ok:true, versionId }` (new version). An invalid patch → `{ error:{ code:'validation_failed', issues } }`. |
| 5 | **Lifecycle** | New work stays `development`; `preview` is used for human validation; `active` requires explicit go-live approval; `disabled` auto-pauses schedules. |
| 6 | **Run & monitor** | `run_workflow` → `get_run` returns `status:'completed'` with structured `output`; `get_run(include:['timeline','io'])` shows per-node execution. |
| 7 | **Recording** | A browser workflow run returns a `recordingUrl` via `get_run(include:['recording'])`. |
| 8 | **Secrets** | `set_secrets` stores a value; a code node reads `secrets.KEY` at runtime (native injection). |
| 9 | **No secrets in repo** | The repo contains no credentials — auth is pass-through (the caller's PAT is forwarded per request). |
| 10 | **Repository verification** | `pnpm install --frozen-lockfile` followed by `pnpm run verify` succeeds without network calls to Studio. |
| 11 | **Correct binding & pagination** | `set_project` returns `selectionScope`; connector scope isolates two connectors sharing a PAT, while token scope warns that bare callers share selection. Explicit selectors win, and separate PATs isolate bare connectors. Server-supported filters are forwarded before pagination; bounded resource search returns `truncated` plus a continuation cursor. |
| 12 | **Current mutation contracts** | Parallel workflow edges are removed by endpoints + handle; HITL uses `pending/responded/expired/canceled` and string/string-array fields; resources expose the full normalized data-resource shape, preserve backward-compatible manual writes, support API/workflow source behavior, and keep bounded name lookup; composite failures distinguish acknowledged state from unknown outcomes. |
| 13 | **Declared operation mapping** | Every classified method+path exists in the synchronized compact Studio projection with request/query schemas, wrapper/effective tier, success status, pagination, and stable error metadata. Fixture scenarios collectively exercise every declared branch of each multi-operation tool and no undeclared operation; broader per-tool behavior coverage remains incremental. Offline verification checks committed consistency, while source freshness requires explicit handoff checking and remains the A8 automation dependency. |

## One-pass end-to-end check

```
get_docs
→ create_workflow (start → block(code) → end scaffold)
→ edit_workflow (patch: add a code node that returns data)
→ update_workflow (apiEnabled: true; keep status development)
→ run_workflow (use dryRun only if the workflow explicitly implements it)
→ get_run  (assert status == "completed", output present)
→ delete_workflow  (cleanup)
```

Repeatable: push to `main` auto-deploys to the live URL above; any MCP client with a suitable PAT and selected project can rerun this loop on a new task.
