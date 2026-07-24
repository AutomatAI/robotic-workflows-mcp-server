# AGENTS.md

Essential guidance for agents working in this repository.

## Critical invariants

1. **Keep one deployed transport.** The server exposes exactly one Streamable HTTP endpoint at `api/mcp.ts` (`GET`/`POST`/`DELETE`/`OPTIONS`), backed by one module-scoped `createMcpHandler` instance. Tool registration may be extracted into separate source modules as an explicit architecture change, as long as they are all imported into and registered against this single endpoint — never split into multiple deployed endpoints or handler instances.
2. **Preserve the real transport boundary.** Protocol tests use the SDK `Client` with `StreamableHTTPClientTransport` and a custom fetch that invokes the exported Vercel handler directly. Never replace this primary harness with sockets or `InMemoryTransport`.
3. **Preserve pass-through authentication.** The caller supplies a Studio PAT. Never store, log, return, or commit PATs. Forward credentials only through the Studio API client choke point.
4. **Keep project selection precedence and scope explicit.** A PAT can access multiple projects. Precedence is `project_id` query → `x-project-id` header → remembered `set_project` → `STUDIO_DEFAULT_PROJECT_ID`. When a logical connector identity is supplied (`connection_id`, `x-connection-id`, or client-supplied `mcp-session-id`), remembered state is keyed by both token and connector. Only connector-less callers use the compatibility PAT-global bucket, where every caller sharing that PAT shares one remembered selection. Never let connector-scoped state omit either key component, and never use the token bucket when a connector identity exists.
5. **Keep every dependency exactly pinned.** No `^`/`~`/`>=` in `package.json` — `pnpm-workspace.yaml` sets `saveExact: true`, and `pnpm run verify` rejects non-exact dependency specifiers. `mcp-handler@1.1.0` and `@modelcontextprotocol/sdk@1.26.0` are additionally a tested compatibility pair; never independently float either version.
6. **Use package.json as the version source.** MCP `serverInfo.version` derives from `package.json`; never add another hardcoded server version, and never let a `package.json` bump regress the version below what has already been published/deployed.
7. **Do not overstate `dryRun`.** It is a workflow-defined input convention, not a platform safety boundary. Never promise that arbitrary runs suppress email, writes, or other side effects.
8. **Do not silently upgrade result semantics.** The current baseline returns JSON in text content. `outputSchema`, `structuredContent`, and `isError` require a deliberate compatibility change and corresponding contract tests.
9. **Keep Studio calls deterministic in tests.** Tests must use recorded method/URL/header/body fixtures. Never call a live Studio environment from the automated suite.
10. **Do not add a software license without owner approval.** This repository currently has no project license grant.
11. **Synchronize, never import, the Studio operation contract.** `contracts/studio-programmatic-access-operations.json` is the committed compact projection used by offline tests. Refresh/check it only through `contract:sync` / `contract:check` with an explicit Studio generated-contract path; never import a sibling Studio working tree. Offline `verify` validates the committed projection's structure and internal consistency, not upstream freshness; automated upstream freshness remains an external integration dependency.

## Repository workflow

1. Read the existing diff before editing; preserve unrelated user work.
2. Read the scoped rule matching the files being changed.
3. Make the smallest behavior change that satisfies the request.
4. Run `pnpm run fix`.
5. Run `pnpm run verify`.
6. Suggest `/deep-review` before commit or pull request preparation.

When Studio operation ids, methods, or paths change, run the explicit contract sync/check workflow in `README.md` and commit the compact projection with the mapping/test updates.

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
- MCP never imports Runtime schemas or validity fixtures. Workflow definitions and patches are validated through Studio's public operations; Runtime issue-code adoption waits for an explicit Studio endpoint contract.
- Contract tests read only the committed compact Studio operation projection, so verification remains offline and independent of sibling working trees.
- The Inspector is a manual development tool. Automated verification uses the in-process protocol harness.

## Documentation

When a tool name, input, behavior, auth rule, operation mapping, lifecycle statement, or known gap changes, update the relevant tests plus `README.md` and `RUBRIC.md`. Keep rules timeless: no ticket identifiers, pull request numbers, dates, rollout phases, or temporary history.
