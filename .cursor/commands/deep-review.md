# Deep review

Review the current repository diff adversarially.

1. Read `AGENTS.md`, `.cursor/BUGBOT.md`, and every scoped rule matching a changed file.
2. Inspect `git status --short`, `git diff HEAD`, and staged changes if present.
3. Check behavior, security, MCP compatibility, Studio operation mappings, test quality, documentation truthfulness, and repository harness consistency.
4. Re-read the diff for missed error paths, project/auth leaks, CORS drift, brittle assertions, and dependency-version drift.
5. Return actionable findings ordered by severity with file and line references. If none remain, say so explicitly.

Do not edit files, commit, push, deploy, or run live Studio operations.
