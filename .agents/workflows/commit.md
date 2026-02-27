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

4. **Commit Message**: Request a conventional commit message from the user.
   (Format: type(scope): description)

5. **Commit and Push**:
   // turbo
   `git commit -m "[User's Message]"`
   // turbo
   `git push origin [current branch]`

Note: If failures occur at step 2, fix the issues before retrying the workflow.
