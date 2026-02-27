---
description: Automated commitment and push workflow with quality checks
---

This workflow automates the process of committing and pushing changes while ensuring code quality and preventing direct pushes to important branches (like `main`).

1. **Safety Check**: Ensure we are not on the `main` branch.
   // turbo
   `git rev-parse --abbrev-ref HEAD` (Fail if output is 'main')

2. **Validation**: Run quality checks.
   // turbo
   `npm run lint`
   // turbo
   `npm test`

3. **Stage Changes**: Stage all modified files.
   // turbo
   `git add .`

4. **Commit Message**: Automatically generate a conventional commit message based on the recent changes (you can figure this out from your context or using `git diff --cached`).
   (Format: type(scope): description)

5. **Commit and Push**:
   // turbo
   `git commit -m "[Generated Message]"`
   // turbo
   `git push origin [current branch]`

Note: If failures occur at step 2, fix the issues before retrying the workflow.
