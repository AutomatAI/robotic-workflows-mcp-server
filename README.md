# Automat Robotic Workflows MCP Server

An [MCP](https://modelcontextprotocol.io/) server that lets AI agents build, deploy and
manage Automat RPA workflows the same way humans do in the studio.

**Status:** the full workflow tool surface (build / manage / run / debug) is implemented as
**schema-complete stubs** — every tool has its real input schema and returns realistic,
spec-shaped data marked `_stub: true`. The stubs are wired to the studio **thin client**
(API-key-authed, single-project-scoped endpoints) as it comes online. The authoritative
contract for that thin client is **[docs/MCP_TOOLS_SPEC.md](docs/MCP_TOOLS_SPEC.md)** — point
an agent at this repo and the spec + `api/mcp.ts` schemas fully describe the requirements.

## Live endpoint

```
https://workflows.runautomat.com/api/mcp
```

(The Vercel default URL `https://robotic-workflows-mcp-server.vercel.app/api/mcp` also works.)

- Transport: **Streamable HTTP** (stateless — no Redis).
- Auth: a single shared API key, accepted via (in priority order):
  1. `?api_key=<KEY>` query param — **the only option that works in the Claude app connector UI** (which has no header field).
  2. `x-api-key: <KEY>` header.
  3. `Authorization: Bearer <KEY>` header — clean path for Claude Code CLI.

> **⚠️ The v1 key is hardcoded in [`api/mcp.ts`](api/mcp.ts) and committed to this repo.**
> It is a throwaway demo key guarding dummy tools only. **Rotate it** before wiring up real
> workflow tools by setting `MCP_API_KEY` in the Vercel project env (Production + Preview) —
> the env var overrides the hardcoded default.

## Connecting clients

Replace `<KEY>` with the API key (current value is the default in `api/mcp.ts`).

### Claude web / desktop app (custom connector)
Settings → Connectors → **Add custom connector** → URL:
```
https://workflows.runautomat.com/api/mcp?api_key=<KEY>
```
No OAuth prompt — valid requests return 200, so the connector attaches directly.
(The connector UI is OAuth-only and has no header field, which is exactly why the key rides
in the URL — see [anthropics/claude-ai-mcp#112](https://github.com/anthropics/claude-ai-mcp/issues/112).)

### Claude Code CLI
```bash
# Key in URL:
claude mcp add --transport http automat \
  "https://workflows.runautomat.com/api/mcp?api_key=<KEY>"

# …or clean URL with a header:
claude mcp add --transport http automat \
  https://workflows.runautomat.com/api/mcp \
  --header "Authorization: Bearer <KEY>"
```
Then `/mcp` to confirm it's connected, and ask Claude to call `ping`.

### MCP Inspector
```bash
npx @modelcontextprotocol/inspector
```
Transport **Streamable HTTP**, URL `https://workflows.runautomat.com/api/mcp?api_key=<KEY>`.

## Tools

Full schemas + the thin-client contract live in **[docs/MCP_TOOLS_SPEC.md](docs/MCP_TOOLS_SPEC.md)**. Summary:

| Group | Tools |
|-------|-------|
| Connectivity | `ping`, `echo` |
| Context & schema | `list_runtime_versions`, `get_workflow_schema` |
| Workflow CRUD | `list_workflows`, `create_workflow`, `copy_workflow`, `read_workflow`, `update_workflow`, `delete_workflow` |
| Editing | `edit_workflow` (composite patch, auto-saves a version) |
| Versions | `list_versions`, `get_version`, `revert_to_version` |
| Schedules | `list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule` |
| Run / monitor / debug | `run_workflow`, `list_runs`, `get_run` (`include: timeline/io/logs/recording`), `cancel_run` |
| HITL | `list_hitl_tasks`, `complete_hitl_task` |
| Secrets | `list_secrets`, `set_secrets`, `delete_secret` |
| Resources & extractors | `list_resources`, `get_resource`, `set_resource`, `delete_resource`, `list_extractors`, `get_extractor` |

## Architecture

- **Stack:** [`mcp-handler`](https://github.com/vercel/mcp-handler) (Vercel adapter that wraps
  [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)) deployed
  as a **plain Vercel Function** — no Next.js. The entire server is one file: [`api/mcp.ts`](api/mcp.ts).
- **Endpoint path:** the function lives at `api/mcp.ts` → served at `/api/mcp`. (A `/mcp` rewrite
  was tried but conflicts with Vercel's auto-generated `/api → 404` guard, so `/api/mcp` is canonical.)

## Local development

```bash
npm install
npm run dev          # vercel dev → http://localhost:3000/api/mcp
npm run inspector    # MCP Inspector
```

## Deploy

```bash
vercel --prod        # CLI must be authenticated (vercel login)
```

## Roadmap

- Replace dummy tools with real workflow CRUD + run/monitor (wired to the studio DB).
- Per-user / per-tenant API keys (v1 is a single shared static key).
- Proper OAuth 2.1 for native connector-UI auth.
- Rate limiting + observability.
