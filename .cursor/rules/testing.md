---
globs: ["tests/**/*.ts", "vitest.config.ts"]
paths: ["tests/**/*.ts", "vitest.config.ts"]
alwaysApply: false
---

# Testing

- Never use `InMemoryTransport` as the primary MCP integration harness.
- Protocol tests must connect an SDK `Client` through `StreamableHTTPClientTransport`.
- The transport's custom fetch must invoke the exported Vercel handler directly; never open a socket or start a dev server.
- Studio fixtures must record method, full URL, headers, and parsed body before returning deterministic responses.
- Never let automated tests call a live Studio, Redis, or Vercel service.
- Assert stable protocol facts, operation mappings, result shapes, and error codes. Avoid exact prose assertions unless the wording is itself the contract.
- Keep local-tool tests separate from Studio-backed tool-result tests.
- Characterize known gaps without asserting that the defect is desired behavior.
- Pure workflow patch tests may import the minimal `applyWorkflowPatch` test seam. Do not extract tool domains solely to make them mockable.
- Any test touching the remembered-`set_project` fallback must call the `__resetMemFallbackForTests` seam in setup/teardown — the module-scoped in-process map otherwise leaks state across tests in one process.
- Redis-path project-selection tests must inject a deterministic `RememberedProjectRedis` with `__setRedisForTests` and restore it with `__resetRedisForTests`; never set real Redis credentials or contact live infrastructure.
- Project-selection tests must characterize connector-scoped results, token-scoped warnings, shared-PAT behavior, explicit-selector precedence, and unique-PAT isolation without implying this endpoint supplies `mcp-session-id`.
- Contract projection tests must validate the committed metadata offline and prove synchronization output is deterministic without reading a sibling Studio checkout.
- Coverage should reveal unexercised endpoint behavior; never add tests that only duplicate TypeScript.
