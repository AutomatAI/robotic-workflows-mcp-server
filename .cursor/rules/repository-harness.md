---
globs: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "biome.json", "vitest.config.ts", ".node-version", ".github/**", ".cursor/**", ".claude/**", "scripts/**", "contracts/**", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]
paths: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "biome.json", "vitest.config.ts", ".node-version", ".github/**", ".cursor/**", ".claude/**", "scripts/**", "contracts/**", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]
alwaysApply: false
---

# Repository harness

- Keep pnpm and commit `pnpm-lock.yaml`.
- Pin every `package.json` dependency and devDependency to an exact version (no `^`/`~`/`>=`) — `pnpm-workspace.yaml` sets `saveExact: true` so `pnpm add` does this by default, and `pnpm run check:dependencies` enforces it. A version bump is a reviewable diff, not silent drift on `pnpm install`.
- Never float `mcp-handler@1.1.0` or `@modelcontextprotocol/sdk@1.26.0`; update them only as a tested pair.
- Never use floating `npx`/`pnpm dlx` commands. Development CLIs must be pinned dependencies invoked through pnpm scripts.
- Never add `"dev": "vercel dev"` to this functions-only package: pinned Vercel recursively invokes the framework `dev` script. Local startup uses `"dev:local": "vercel dev"` so the CLI has no framework dev command to recurse into.
- Keep `package.json` as the only package/server version source, and bump it forward (never regress a released `serverInfo.version`).
- CI must run on pushes to `main` and on pull requests, install with `pnpm install --frozen-lockfile`, and execute `pnpm run verify`.
- `pnpm run fix` must format and apply safe lint fixes; `pnpm run verify` must typecheck, lint, check formatting, and run coverage.
- Coverage thresholds in `vitest.config.ts` are a ratchet, not a target: bump them only after real tests raise measured coverage, never above the currently-measured numbers, and never lower them.
- Keep `.node-version`, `engines.node`, `packageManager`, and CI's Node setup compatible.
- Every Tier 2 rule needs a matching `.claude/rules` symlink. `.claude/commands` must point to `.cursor/commands`.
- Never import a sibling Studio working tree at test/runtime. Synchronize the compact Studio operation projection explicitly with `contract:sync`, verify it against a specified source with `contract:check`, and commit the projection. Offline `verify` validates committed structure and internal consistency only; it must never claim upstream freshness without an explicit source artifact.
- Query-location Studio operations may expose `querySchema` or pagination-only query metadata; never copy or teach a query operation's stale `requestSchema`.
- Keep the projection compact but retain `operationId`, method, path, request location, query schema or null, wrapper/effective tier, success status, pagination, stable error codes, and contract id/revision. Synchronization output must be deterministic.
- Never add a software license or license field without an explicit owner decision.
- Do not encode tickets, pull requests, dates, temporary rollout states, or phase labels in agent rules.
