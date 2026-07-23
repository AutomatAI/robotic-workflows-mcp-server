# PR description

Generate a concise pull request description from the current branch and working tree.

1. Inspect `git log main...HEAD --oneline`, `git diff main...HEAD`, `git diff HEAD`, and `git status --short`.
2. Describe only verified changes.
3. Include:
   - Context
   - What changed
   - Why
   - How it works
   - Test plan with exact commands and results
   - Compatibility, configuration, dependency, and known-risk notes
4. State whether another repository or deployment must change first; use a dash when none.
5. Return one fenced Markdown block ready to paste into GitHub.

Do not commit, push, deploy, or mutate the pull request.
