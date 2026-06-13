# Copilot Instructions

## Language Rule

**English is the primary language for this project. All documentation, comments, and code strings MUST be in English.**

This includes:
- Code comments and docstrings
- Commit messages
- README files and markdown documentation
- UI strings and error messages
- Git branch names (use kebab-case)

## Git Commit Rule

**IMPORTANT: Do NOT auto-commit any changes. After code modifications are complete, stage files but do NOT commit. Let the user manually execute `git commit`.**

This prevents:
- Duplicate commit records for the same feature
- Messy commit history from poor timing
- Unnecessary intermediate commits

### Correct Workflow
1. Complete code changes
2. Stage files with `git add`
3. **STOP - do NOT commit**
4. Wait for user to manually execute `git commit -m "<message>"`
5. User optionally executes `git push`

### If You Accidentally Commit
Immediately undo: `git reset HEAD~1`
