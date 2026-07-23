# Bugbot review rules

Read `AGENTS.md` and the scoped rules matching the diff before reviewing.

## Flag as security or correctness defects

- Any committed PAT, API key, Redis token, Vercel bypass secret, or non-placeholder credential.
- Logging or returning caller authorization, query-string credentials, secret values, or protection-bypass headers.
- A Studio-backed tool that bypasses the shared `api()` client or loses explicit project scoping.
- CORS headers that do not allow a request header accepted by the endpoint.
- A claim that `dryRun` universally suppresses side effects.
- A server version hardcoded separately from `package.json`.
- Independent or floating changes to the tested `mcp-handler` and MCP SDK pair.
- A protocol test that replaces the SDK Streamable HTTP direct-handler harness with sockets or `InMemoryTransport`.
- A fixture that can reach live Studio, Redis, or Vercel infrastructure.
- A registered tool missing title, description, object input schema, annotations, or operation classification.
- New `outputSchema`, `structuredContent`, or `isError` behavior without an explicit compatibility test and documentation update.

## Flag as repository regressions

- CI that skips `npm ci` or `npm run verify`, or uses path filters that prevent the workflow from always running.
- A floating `npx` development command.
- A scoped Cursor rule without its `.claude/rules` symlink.
- Public contract changes not reflected in README, RUBRIC, and contract tests.
- A software license added without an explicit owner decision.

## Do not flag

- The current text-only JSON tool results solely for lacking richer MCP output fields; that is characterized baseline behavior.
- The manual Inspector for not running in CI.
- A baseline tool-name snapshot, provided no fixed numeric tool-count assertion is used as the invariant.
