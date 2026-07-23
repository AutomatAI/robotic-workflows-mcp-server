# Contributing

## Setup

Use the Node version in `.node-version` and pnpm version declared by `packageManager`.

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

Copy `.env.example` to `.env.local` only when running the endpoint manually. Never commit credentials.

## Making changes

1. Read `AGENTS.md` and the scoped Cursor rule for the files you will touch.
2. Inspect the current diff and preserve unrelated work.
3. Keep the single `api/mcp.ts` endpoint and make the smallest compatible change.
4. Add or update unit, contract, and protocol tests as appropriate.
5. Run `pnpm run fix`, then `pnpm run verify`.
6. Run `/deep-review` before opening a pull request.

The MCP Inspector is a manual aid:

```bash
pnpm run inspector
```

It does not replace automated protocol tests.

## Pull requests

- Explain tool-contract, Studio-operation, auth, project-binding, configuration, and dependency changes.
- Include exact verification commands and results.
- Update README and RUBRIC when public behavior or guidance changes.
- Do not commit `.env`, coverage output, Vercel state, or credentials.
- Do not deploy from a contribution unless a maintainer explicitly requests it.

## Licensing

This repository currently does not contain a project software license. That means no license grant should be assumed. Choosing a license is an explicit repository-owner decision; do not add or infer one as part of an unrelated change.
