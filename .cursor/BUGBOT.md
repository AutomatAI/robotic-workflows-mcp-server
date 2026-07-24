# Bugbot review rules

Read `AGENTS.md` and the scoped rules matching the diff before reviewing.

## Don't flag (known-good patterns)

Read this section first — these are intentional and not bugs.

- **`?api_key=pat_…` in the connector URL.** MCP clients (Claude, Cursor, Inspector) configure Streamable HTTP servers via a single URL, so the token travels in the query string by design — this is the standard MCP connector pattern, not a leaked-credential finding. It is a characterized, pre-existing surface; don't re-flag it as new.
- **The in-process `memFallback` Map for `set_project`.** It serves local dev when Redis is absent and preserves a remembered selection on the current instance when Redis fails. Its keys use the same scope as Redis: token+connector when identity exists, token-only compatibility scope otherwise. Don't suggest removing it or replacing it with Redis "always."
- **Redis get/set wrapped in best-effort fallbacks.** A Redis blip must never break project selection: every successful Redis write is mirrored into connector-scoped memory before returning, reads consult that mirror, and failed writes store there before returning the documented `set_project` success. Cross-instance persistence resumes after Redis recovers.
- **Project selection precedence.** `project_id` query → `x-project-id` header → remembered `set_project` → `STUDIO_DEFAULT_PROJECT_ID` is intentional; explicit selectors must override remembered state.
- **The text-only JSON tool result shape** (no `structuredContent`/`outputSchema`/`isError` on success). This is characterized baseline behavior tracked in `AGENTS.md` invariant 8 and `RUBRIC.md` — don't flag it as "missing richer MCP output," only flag an *inconsistent* new addition (see below).
- **The manual MCP Inspector not running in CI.** It's a developer aid, not a substitute for the protocol test harness.
- **A baseline tool-name snapshot test**, provided it isn't paired with a fixed numeric tool-count assertion as the actual invariant.
- **Legacy `/api/agent/*` path names inside `api/mcp.ts` tool bodies.** These are rewritten to `/api/v1/...` by the single `api()` choke point (see AGENTS.md "Current architecture") — a tool calling `api("GET", "/api/agent/...")` is correct, not a stale path.

## Flag as security or correctness defects

- Any committed PAT, API key, Redis token, Vercel bypass secret, or non-placeholder credential.
- Logging or returning caller authorization, query-string credentials, secret values, or protection-bypass headers.
- A Studio-backed tool that bypasses the shared `api()` client or loses explicit project scoping.
- A change to `tokenBucket()`, `rememberedProjectId()`, or `rememberProject()` that fails to use token+connector scope when a logical connector identity (`connection_id`, `x-connection-id`, or client-supplied `mcp-session-id`) exists, uses the token-only compatibility bucket despite an available identity, or keys on project/connector without the token. Token-only remembered state is accepted only when connector identity is absent, and its shared-PAT risk must remain explicit in `set_project` output and docs.
- CORS headers that do not allow a request header accepted by the endpoint.
- A claim that `dryRun` universally suppresses side effects.
- A server version hardcoded separately from `package.json`, or a `package.json` version bump that regresses below the currently deployed `serverInfo.version`.
- Independent or floating changes to the tested `mcp-handler` and MCP SDK pair.
- A protocol test that replaces the SDK Streamable HTTP direct-handler harness with sockets or `InMemoryTransport`.
- A fixture that can reach live Studio, Redis, or Vercel infrastructure.
- A registered tool missing title, description, object input schema, annotations, or operation classification.
- A classified Studio method+path absent from the synchronized compact Studio contract projection, or a multi-operation tool whose fixtures do not collectively exercise every declared path and reject undeclared calls.
- A committed Studio projection that drops `requestLocation`, `querySchema`, `wrapperTier`, `effectiveTier`, `successStatus`, `pagination`, or `stableErrorCodes`, or CI/docs that imply offline `verify` proves freshness against an unspecified upstream artifact.
- New `outputSchema`, `structuredContent`, or `isError` behavior without an explicit compatibility test and documentation update.
- A tool's `catch` block that returns something other than the shared `fail(e)` envelope (e.g. hand-rolls its own error object, or forwards a raw `Response`/headers/stack trace) — every tool must funnel failures through the one characterized error shape.
- A new tool that reads or forwards a credential from a source other than `api_key`, `x-api-key`, or `Authorization: Bearer`.

## Flag as repository regressions

- CI that skips `pnpm install --frozen-lockfile` or `pnpm run verify`, or uses path filters that prevent the workflow from always running.
- A floating `npx`/`pnpm dlx` development command.
- A package `"dev": "vercel dev"` script in this functions-only project; pinned Vercel treats it as a framework dev command and recurses. Keep the pinned CLI under `dev:local`.
- A scoped Cursor rule without its `.claude/rules` symlink.
- Public contract changes (tool name, required input, output shape, auth rule, or Studio operation mapping) not reflected in `README.md`, `RUBRIC.md`, and the contract/protocol tests.
- Project-selection docs or instructions that imply `mcp-session-id` is issued by this server, omit explicit selector precedence, or fail to state that the PAT-global remembered bucket exists only for connector-less callers.
- A new file added under an existing `.cursor/rules/*.md` domain whose `globs`/`paths` don't cover it.
- A software license added without an explicit owner decision.

## Timeless rules

If the diff adds historical provenance or deployment status to `AGENTS.md`, `.cursor/rules/*`, or this file — a ticket id, a "shipped/landed on \<date\>" statement, a PR number cited as precedent, a phase/slice label, or "planned as of \<date\>" — flag it: rules must state invariants timelessly and stand alone without external context (provenance belongs in git history and PR descriptions).
