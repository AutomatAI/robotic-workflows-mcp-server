# Verify

Run the repository's full local quality gate:

1. Read `git status --short` and `git diff` so existing user work is preserved.
2. Run `npm run fix`.
3. Run `npm run verify`.
4. Report changed files, command results, and any unresolved failure. Do not commit, push, deploy, or run the manual Inspector.
