---
name: github-pr-workflow
description: Run a disciplined GitHub pull request workflow from branch creation through merge. Use when opening a PR, updating a PR after review, preparing review-ready diffs, managing draft versus ready states, or landing changes with clear validation and risk notes.
version: 0.1.0
author: OpenAI Codex
license: MIT
metadata:
  category: github
  ported_from: NousResearch Hermes Agent
  tags:
    - github
    - pull-request
    - workflow
    - collaboration
  tools:
    - git
    - github
    - shell
  maturity: beta
---

# GitHub PR Workflow

## Purpose

- Keep pull requests reviewable and easy to merge safely.
- Separate implementation from presentation and merge hygiene.
- Make reviewer intent clear through titles, descriptions, and test plans.
- Reduce merge friction by handling updates systematically.
- Preserve traceability between issue, code, and validation.

## Activation Signals

- Use this skill when opening a new branch for changes.
- Use this skill when preparing a PR for review.
- Use this skill when updating a PR after feedback.
- Use this skill when turning a draft into a merge-ready PR.
- Use this skill when planning labels, reviewers, and merge strategy.

## Core Workflow

1. Start from the correct base branch.
2. Keep the branch scope tight.
3. Make coherent commits.
4. Validate before opening the PR.
5. Open a draft PR if the implementation is not review-ready.
6. Write a useful PR title and description.
7. Address review comments with focused follow-up commits.
8. Re-validate before merge.
9. Merge with the right strategy.

## Branch Rules

- Branch from the intended base, not a stale local branch.
- Name the branch after the work, not the date.
- Keep unrelated changes out of the branch.
- Avoid force-push unless the team allows it and history cleanup is worth it.

## Commit Rules

- One logical change per commit when practical.
- Use commit messages that explain intent, not just files touched.
- Avoid mixing refactor and bug fix unless inseparable.
- Keep WIP commits local when possible.

## Pre-PR Validation

- run targeted tests
- run lint if relevant
- check formatting if the repo enforces it
- read the diff yourself before asking others to do it
- note any unverified areas explicitly

## PR Title Rules

- Lead with the user-visible or system-visible change.
- Keep it specific.
- Avoid "misc fixes".
- Prefer imperative summaries such as "Fix auth redirect loop during token refresh".

## PR Description Template

```markdown
## Summary
- ...

## Why
- ...

## Testing
- `pytest tests/test_auth.py::test_login_redirect_does_not_loop_when_session_is_hydrated -vv`

## Risks
- ...
```

## Draft Versus Ready

- Open as draft when the implementation is incomplete.
- Open as draft when feedback on direction is needed before polishing.
- Convert to ready only after validation and self-review.
- Do not ask for full review while the branch still contains known broken paths.

## Review Update Procedure

1. Group comments by theme.
2. Resolve the highest-risk comments first.
3. Make focused follow-up commits.
4. Reply with what changed and where.
5. Re-run the relevant validation.
6. Avoid "fixed" with no evidence.

## Merge Strategy

- Use merge commit when preserving branch history matters.
- Use squash when the branch contains several noisy intermediate commits.
- Use rebase when the repository prefers linear history and the branch is clean.
- Follow repo policy when it is explicit.

## Useful Commands

```bash
git checkout -b fix-auth-redirect-loop
git status --short
git diff --stat
gh pr create --draft --title "Fix auth redirect loop during token refresh" --body-file PR_BODY.md
gh pr view --web
```

## Reviewer Experience Rules

- Keep the diff small enough to review in one sitting.
- Explain why the change exists.
- State how you validated it.
- Admit unknowns.
- Link related issues or incidents.

## Anti-Patterns

- giant PRs with mixed concerns
- vague PR titles
- empty descriptions
- no testing notes
- force-pushing away reviewer context without warning
- mixing comment resolution with unrelated cleanup

## Output Contract

When reporting PR progress, include:

- branch name
- PR state: draft or ready
- summary of changes
- validation performed
- remaining risks or blockers

## Example Status Block

```markdown
PR workflow status:
- Branch: fix-auth-redirect-loop
- State: draft
- Summary: auth middleware now waits for hydrated session token before redirecting
- Validation: targeted auth regression test passed
- Remaining blocker: reviewer input needed on fallback behavior during refresh timeout
```

## Decision Rules

- If the diff is large, split before asking for review when possible.
- If the PR changes behavior, tests should usually change too.
- If validation is partial, state the gap explicitly.
- If the branch drifted from base, rebase or merge base before final review.

## Recovery Moves

- If review comments are scattered, create a comment-response checklist.
- If the branch became messy, squash or reorder before final merge if policy allows.
- If new scope appears, consider a follow-up PR instead of growing the current one.
- If CI fails, fix CI before asking for another full review pass.

## Checklist

1. Start from the correct base branch.
2. Keep scope tight.
3. Self-review the diff.
4. Validate locally.
5. Open draft or ready appropriately.
6. Write a strong title and description.
7. Address feedback in focused updates.
8. Re-validate before merge.
