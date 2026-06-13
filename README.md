# Automat Robotic Workflows MCP Server

An [MCP](https://modelcontextprotocol.io/) server that lets AI agents build, deploy and
manage Automat RPA workflows the same way humans do in the studio.

**v1 status (this milestone):** scaffolding only — a live, deployed server with two dummy
"hello world" tools (`ping`, `echo`) behind a single static API key. Real workflow tools
(CRUD + run/monitor) come in a later milestone.

## Live endpoint

```
https://robotic-workflows-mcp-server.vercel.app/api/mcp
```

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
https://robotic-workflows-mcp-server.vercel.app/api/mcp?api_key=<KEY>
```
No OAuth prompt — valid requests return 200, so the connector attaches directly.
(The connector UI is OAuth-only and has no header field, which is exactly why the key rides
in the URL — see [anthropics/claude-ai-mcp#112](https://github.com/anthropics/claude-ai-mcp/issues/112).)

### Claude Code CLI
```bash
# Key in URL:
claude mcp add --transport http automat \
  "https://robotic-workflows-mcp-server.vercel.app/api/mcp?api_key=<KEY>"

# …or clean URL with a header:
claude mcp add --transport http automat \
  https://robotic-workflows-mcp-server.vercel.app/api/mcp \
  --header "Authorization: Bearer <KEY>"
```
Then `/mcp` to confirm it's connected, and ask Claude to call `ping`.

### MCP Inspector
```bash
npx @modelcontextprotocol/inspector
```
Transport **Streamable HTTP**, URL `https://robotic-workflows-mcp-server.vercel.app/api/mcp?api_key=<KEY>`.

## Tools

| Tool | Args | Returns |
|------|------|---------|
| `ping` | — | `pong @ <ISO timestamp>` |
| `echo` | `message: string` | `You said: <message>` |

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
