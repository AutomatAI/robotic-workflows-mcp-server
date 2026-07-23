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
- Coverage should reveal unexercised endpoint behavior; never add tests that only duplicate TypeScript.
