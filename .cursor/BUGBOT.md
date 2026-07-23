# Bugbot review rules

Read `AGENTS.md` and the scoped rules matching the diff before reviewing.

## Don't flag (known-good patterns)

Read this section first — these are intentional and not bugs.

- **`?api_key=pat_…` in the connector URL.** MCP clients (Claude, Cursor, Inspector) configure Streamable HTTP servers via a single URL, so the token travels in the query string by design — this is the standard MCP connector pattern, not a leaked-credential finding. It is a characterized, pre-existing surface; don't re-flag it as new.
- **The in-process `memFallback` Map for `set_project`.** It only activates when `KV_REST_API_URL`/`KV_REST_API_TOKEN` are absent (local dev, tests, a single stdio process). In serverless/multi-instance deployment, Redis is configured and is the actual store. Don't suggest removing the fallback or replacing it with Redis "always" — the point is graceful local dev without Redis.
- **`redis.get` wrapped in try/catch that returns `undefined` on failure.** A Redis blip must never break auth; treating a Redis error as "no remembered project" is intentional self-healing (the caller re-runs `set_project`). Don't flag the swallowed error as a missing failure path.
- **The text-only JSON tool result shape** (no `structuredContent`/`outputSchema`/`isError` on success). This is characterized baseline behavior tracked in `AGENTS.md` invariant 8 and `RUBRIC.md` — don't flag it as "missing richer MCP output," only flag an *inconsistent* new addition (see below).
- **The manual MCP Inspector not running in CI.** It's a developer aid, not a substitute for the protocol test harness.
- **A baseline tool-name snapshot test**, provided it isn't paired with a fixed numeric tool-count assertion as the actual invariant.
- **Legacy `/api/agent/*` path names inside `api/mcp.ts` tool bodies.** These are rewritten to `/api/v1/...` by the single `api()` choke point (see AGENTS.md "Current architecture") — a tool calling `api("GET", "/api/agent/...")` is correct, not a stale path.

## Flag as security or correctness defects

- Any committed PAT, API key, Redis token, Vercel bypass secret, or non-placeholder credential.
- Logging or returning caller authorization, query-string credentials, secret values, or protection-bypass headers.
- A Studio-backed tool that bypasses the shared `api()` client or loses explicit project scoping.
- A change to `tokenBucket()`, `rememberedProjectId()`, or `rememberProject()` that derives the Redis/`memFallback` key from anything other than a per-caller-token hash (e.g. a global/static key, the project id alone, or a caller-supplied value) — that would leak one user's remembered project selection onto another user's session.
- CORS headers that do not allow a request header accepted by the endpoint.
- A claim that `dryRun` universally suppresses side effects.
- A server version hardcoded separately from `package.json`, or a `package.json` version bump that regresses below the currently deployed `serverInfo.version`.
- Independent or floating changes to the tested `mcp-handler` and MCP SDK pair.
- A protocol test that replaces the SDK Streamable HTTP direct-handler harness with sockets or `InMemoryTransport`.
- A fixture that can reach live Studio, Redis, or Vercel infrastructure.
- A registered tool missing title, description, object input schema, annotations, or operation classification.
- A new `studio`/`hybrid`-classified tool added to `toolClassifications` (`tests/contract/tool-contract.test.ts`) without at least one fixture-backed test verifying the tool's actual recorded request (method + path) against its declared `operations` — a key-set-completeness assertion alone is not verification.
- New `outputSchema`, `structuredContent`, or `isError` behavior without an explicit compatibility test and documentation update.
- A tool's `catch` block that returns something other than the shared `fail(e)` envelope (e.g. hand-rolls its own error object, or forwards a raw `Response`/headers/stack trace) — every tool must funnel failures through the one characterized error shape.
- A new tool that reads or forwards a credential from a source other than `api_key`, `x-api-key`, or `Authorization: Bearer`.

## Flag as repository regressions

- CI that skips `pnpm install --frozen-lockfile` or `pnpm run verify`, or uses path filters that prevent the workflow from always running.
- A floating `npx`/`pnpm dlx` development command.
- A scoped Cursor rule without its `.claude/rules` symlink.
- Public contract changes (tool name, required input, output shape, auth rule, or Studio operation mapping) not reflected in `README.md`, `RUBRIC.md`, and the contract/protocol tests.
- A new file added under an existing `.cursor/rules/*.md` domain whose `globs`/`paths` don't cover it.
- A software license added without an explicit owner decision.

## Timeless rules

If the diff adds historical provenance or deployment status to `AGENTS.md`, `.cursor/rules/*`, or this file — a ticket id, a "shipped/landed on \<date\>" statement, a PR number cited as precedent, a phase/slice label, or "planned as of \<date\>" — flag it: rules must state invariants timelessly and stand alone without external context (provenance belongs in git history and PR descriptions).
