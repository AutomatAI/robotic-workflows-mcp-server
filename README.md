# Automat Workflows MCP Server

A remote [MCP](https://modelcontextprotocol.io/) server that lets AI agents build, run, and manage Automat RPA workflows — the same operations humans perform in the studio.

The server is a thin forwarder: each tool calls an API-key-authenticated, single-project endpoint in the studio app (the "thin client"), which reuses studio's existing validation, versioning, and execution code. Tool contracts are defined in [docs/MCP_TOOLS_SPEC.md](docs/MCP_TOOLS_SPEC.md).

> **Status:** all 33 tools are implemented as schema-complete stubs. Each has its real input schema and returns spec-shaped data marked `_stub: true`. Handlers forward to the thin client as it comes online.

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

## Tools

Full schemas and the thin-client contract are in [docs/MCP_TOOLS_SPEC.md](docs/MCP_TOOLS_SPEC.md).

| Group | Tools |
| --- | --- |
| Connectivity | `ping`, `echo` |
| Schema | `list_runtime_versions`, `get_workflow_schema` |
| Workflows | `list_workflows`, `create_workflow`, `copy_workflow`, `read_workflow`, `update_workflow`, `delete_workflow` |
| Editing | `edit_workflow` |
| Versions | `list_versions`, `get_version`, `revert_to_version` |
| Schedules | `list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule` |
| Runs | `run_workflow`, `list_runs`, `get_run`, `cancel_run` |
| HITL | `list_hitl_tasks`, `complete_hitl_task` |
| Secrets | `list_secrets`, `set_secrets`, `delete_secret` |
| Resources | `list_resources`, `get_resource`, `set_resource`, `delete_resource` |
| Extractors | `list_extractors`, `get_extractor` |

## Development

```bash
npm install
npm run dev          # vercel dev → http://localhost:3000/api/mcp
npm run inspector    # MCP Inspector
vercel --prod        # deploy (requires vercel login)
```

## Stack

[`mcp-handler`](https://github.com/vercel/mcp-handler) (wrapping [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)) as a single Vercel Function — no framework. The whole server is [`api/mcp.ts`](api/mcp.ts). It serves `/api/mcp`; a `/mcp` rewrite is not used because it collides with Vercel's built-in `/api` routing guard.

## Roadmap

- Wire tools to the studio thin client (replace the stubs).
- Per-project API keys (v1 uses one shared key).
- Extractor authoring and file-resource uploads.
