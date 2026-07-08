# Acceptance Rubric — Robotic Workflows MCP Server

"Done" is verifiable by an agent with **only a project API key** — no human in the loop. Connect to the live server and check each criterion by calling the tools.

- **Live endpoint:** `https://workflows.runautomat.com/api/mcp` (Streamable HTTP)
- **Auth:** project-scoped key via `?api_key=ak_…` (or `Authorization: Bearer`)

## Pass criteria

| # | Criterion | How to verify |
| --- | --- | --- |
| 1 | **Reachable & complete** | `tools/list` returns **33 tools** (incl. `get_docs`, `get_workflow_schema`, `create_workflow`, `edit_workflow`, `run_workflow`, `get_run`). |
| 2 | **Self-documenting** | `get_docs` returns the code-node authoring model — globals incl. `$('NodeName')`, `fetch`, and worked examples. |
| 3 | **Build** | `create_workflow` → `{ workflowId, versionId }`; `read_workflow(view:'graph')` returns the graph + `_meta`. |
| 4 | **Edit (patch model)** | `edit_workflow` with a composite patch → `{ ok:true, versionId }` (new version). An invalid patch → `{ error:{ code:'validation_failed', issues } }`. |
| 5 | **Deploy / lifecycle** | `update_workflow` sets `status:'active'` (requires a published version); `disabled` auto-pauses schedules. |
| 6 | **Run & monitor** | `run_workflow` → `get_run` returns `status:'completed'` with structured `output`; `get_run(include:['timeline','io'])` shows per-node execution. |
| 7 | **Recording** | A browser workflow run returns a `recordingUrl` via `get_run(include:['recording'])`. |
| 8 | **Secrets** | `set_secrets` stores a value; a code node reads `secrets.KEY` at runtime (native injection). |
| 9 | **No secrets in repo** | The public repo contains no API keys — auth is pass-through (the caller's key is forwarded per request). |

## One-pass end-to-end check

```
get_docs
→ create_workflow (start → block(code) → end scaffold)
→ edit_workflow (patch: add a code node that returns data)
→ update_workflow (apiEnabled: true)
→ run_workflow
→ get_run  (assert status == "completed", output present)
→ delete_workflow  (cleanup)
```

Repeatable: push to `main` auto-deploys to the live URL above; any MCP client with a project key can rerun this loop on a new task.
