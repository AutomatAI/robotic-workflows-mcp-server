# AGENTS.md

Essential guidance for agents working in this repository.

## Critical invariants

1. **Keep one deployed transport.** The server exposes exactly one Streamable HTTP endpoint at `api/mcp.ts` (`GET`/`POST`/`DELETE`/`OPTIONS`), backed by one module-scoped `createMcpHandler` instance. Tool registration may be extracted into separate source modules as an explicit architecture change, as long as they are all imported into and registered against this single endpoint — never split into multiple deployed endpoints or handler instances.
2. **Preserve the real transport boundary.** Protocol tests use the SDK `Client` with `StreamableHTTPClientTransport` and a custom fetch that invokes the exported Vercel handler directly. Never replace this primary harness with sockets or `InMemoryTransport`.
3. **Preserve pass-through authentication.** The caller supplies a Studio PAT. Never store, log, return, or commit PATs. Forward credentials only through the Studio API client choke point.
4. **Keep project selection explicit.** A PAT can access multiple projects. Project selection comes from remembered `set_project` state, `project_id`, `x-project-id`, or `STUDIO_DEFAULT_PROJECT_ID`; do not claim the PAT itself is project-scoped.
5. **Keep every dependency exactly pinned.** No `^`/`~`/`>=` in `package.json` — `.npmrc`'s `save-exact=true` enforces this on `pnpm add`. `mcp-handler@1.1.0` and `@modelcontextprotocol/sdk@1.26.0` are additionally a tested compatibility pair; never independently float either version.
6. **Use package.json as the version source.** MCP `serverInfo.version` derives from `package.json`; never add another hardcoded server version, and never let a `package.json` bump regress the version below what has already been published/deployed.
7. **Do not overstate `dryRun`.** It is a workflow-defined input convention, not a platform safety boundary. Never promise that arbitrary runs suppress email, writes, or other side effects.
8. **Do not silently upgrade result semantics.** The current baseline returns JSON in text content. `outputSchema`, `structuredContent`, and `isError` require a deliberate compatibility change and corresponding contract tests.
9. **Keep Studio calls deterministic in tests.** Tests must use recorded method/URL/header/body fixtures. Never call a live Studio environment from the automated suite.
10. **Do not add a software license without owner approval.** This repository currently has no project license grant.

## Repository workflow

1. Read the existing diff before editing; preserve unrelated user work.
2. Read the scoped rule matching the files being changed.
3. Make the smallest behavior change that satisfies the request.
4. Run `pnpm run fix`.
5. Run `pnpm run verify`.
6. Suggest `/deep-review` before commit or pull request preparation.

## Scoped rules

| Rule | Applies to | Focus |
| --- | --- | --- |
| `.cursor/rules/mcp-contract.md` | endpoint, protocol and contract tests, public contract docs | MCP metadata, auth, CORS, Studio operation mapping |
| `.cursor/rules/testing.md` | tests and Vitest configuration | direct-handler transport harness and deterministic fixtures |
| `.cursor/rules/repository-harness.md` | package/config/CI/contributor files | pnpm, exact dependency pair, CI and documentation maintenance |

## Current architecture

- `api/mcp.ts` registers the tools and exports `GET`, `POST`, `DELETE`, and `OPTIONS`.
- `createMcpHandler` stays module-scoped; the adapter creates a fresh MCP server for each request.
- Tool code names legacy `/api/agent/*` paths internally; the `api()` choke point maps them to Studio `/api/v1/*` operations.
- Local tools do not call Studio. Studio-backed tools use the same pass-through PAT and selected project.
- The Inspector is a manual development tool. Automated verification uses the in-process protocol harness.

## Documentation

When a tool name, input, behavior, auth rule, operation mapping, lifecycle statement, or known gap changes, update the relevant tests plus `README.md` and `RUBRIC.md`. Keep rules timeless: no ticket identifiers, pull request numbers, dates, rollout phases, or temporary history.
