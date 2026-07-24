---
globs: ["api/**/*.ts", "tests/protocol/**/*.ts", "tests/contract/**/*.ts", "README.md", "RUBRIC.md"]
paths: ["api/**/*.ts", "tests/protocol/**/*.ts", "tests/contract/**/*.ts", "README.md", "RUBRIC.md"]
alwaysApply: false
---

# MCP contract

- Never add a second HTTP endpoint for a tool domain; keep `api/mcp.ts` as the public MCP boundary.
- Never move `createMcpHandler` into a request handler. It remains module-scoped and the adapter initializes a fresh server per request.
- Never accept or forward a credential from any source other than `api_key`, `x-api-key`, or Bearer authorization without a reviewed auth change.
- Never treat a PAT as project-scoped. Preserve explicit project precedence and connector-isolated remembered selection.
- Never omit an accepted auth/project/connection header from CORS (`authorization`, `x-api-key`, `x-project-id`, `x-connection-id`, `mcp-session-id`).
- Every registered tool must expose a non-empty title and description, an object input schema, and annotations.
- Every registered tool must have a contract-test classification as either local or mapped to one or more effective Studio operations. Every classified operation must exist in the synchronized Studio projection. Every multi-operation tool must fixture-exercise all declared method+path branches across its scenarios and reject undeclared calls.
- A baseline tool-name snapshot may characterize compatibility. Never enforce only a fixed numeric count.
- Preserve the current text-JSON result behavior until richer MCP output semantics are deliberately introduced with compatibility tests.
- Keep server instructions, `get_docs`, README, RUBRIC, and tests truthful about auth, lifecycle, `dryRun`, and known gaps.
- Never make the automated suite depend on the manual MCP Inspector.
