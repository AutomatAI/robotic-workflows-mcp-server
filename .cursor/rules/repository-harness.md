---
globs: ["package.json", "package-lock.json", "tsconfig.json", "biome.json", "vitest.config.ts", ".node-version", ".github/**", ".cursor/**", ".claude/**", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]
paths: ["package.json", "package-lock.json", "tsconfig.json", "biome.json", "vitest.config.ts", ".node-version", ".github/**", ".cursor/**", ".claude/**", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]
alwaysApply: false
---

# Repository harness

- Keep npm and commit `package-lock.json`.
- Never float `mcp-handler@1.1.0` or `@modelcontextprotocol/sdk@1.26.0`; update them only as a tested pair.
- Never use floating `npx` commands. Development CLIs must be pinned dependencies invoked through npm scripts.
- Keep `package.json` as the only package/server version source.
- CI must run on pushes and pull requests, install with `npm ci`, and execute `npm run verify`.
- `npm run fix` must format and apply safe lint fixes; `npm run verify` must typecheck, lint, check formatting, and run coverage.
- Keep `.node-version`, `engines.node`, `packageManager`, and CI's Node setup compatible.
- Every Tier 2 rule needs a matching `.claude/rules` symlink. `.claude/commands` must point to `.cursor/commands`.
- Never add a software license or license field without an explicit owner decision.
- Do not encode tickets, pull requests, dates, temporary rollout states, or phase labels in agent rules.
