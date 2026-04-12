---
name: github-code-review
description: Review GitHub pull requests with a findings-first engineering mindset. Use when auditing diffs for bugs, regressions, security issues, missing tests, or risky design choices, and when producing actionable review comments instead of generic summaries.
version: 0.1.0
author: OpenAI Codex
license: MIT
metadata:
  category: github
  ported_from: NousResearch Hermes Agent
  tags:
    - github
    - code-review
    - pull-requests
    - risk
  tools:
    - github
    - git
    - diff
  maturity: beta
---

# GitHub Code Review

## Purpose

- Find real defects and risks before merge.
- Prioritize correctness, security, and regressions over style nits.
- Produce review comments that are concrete and defensible.
- Keep summaries brief and findings primary.
- Tie each concern to evidence in the diff.

## Activation Signals

- Use this skill when the user asks for a review.
- Use this skill when a PR must be audited before merge.
- Use this skill when code changes touch critical systems.
- Use this skill when a team needs structured findings with severity.
- Use this skill when review comments should map cleanly onto changed files.

## Review Order

1. Read PR metadata.
2. Read changed-file list.
3. Identify risky files first.
4. Read the diff with behavioral intent in mind.
5. Check tests and verification claims.
6. Produce findings ordered by severity.
7. Add a brief summary only after the findings.

## High-Risk Change Types

- auth or session logic
- data migrations
- concurrency changes
- caching invalidation
- payment or billing logic
- permission checks
- serialization or schema changes
- error handling rewrites

## Evidence Sources

- file diffs
- PR description
- CI status
- changed filenames
- related issue text
- existing review comments
- nearby tests

## Finding Categories

- correctness bug
- regression risk
- security issue
- missing validation
- missing test coverage
- maintainability risk
- performance regression

## Severity Guidelines

- `high` when merge could cause data loss, security exposure, or broken primary flows
- `medium` when likely behavior is wrong under realistic conditions
- `low` when risk is limited but still worth fixing before merge

## Comment Structure

- Start with the risk, not praise.
- Name the exact behavior at risk.
- Point to the file and line.
- Explain why the current diff is unsafe or incomplete.
- Suggest the minimal corrective direction when possible.

## Example Finding

```markdown
High: The new session guard treats a missing cache entry as "guest" even during token refresh, which can incorrectly revoke authenticated users during normal refresh windows. This path appears in `auth/middleware.ts` and does not have matching regression coverage.
```

## Review Questions

- What behavior changed?
- What assumptions does the change introduce?
- Where could the new logic be called unexpectedly?
- What happens on failure paths, not just the happy path?
- What tests prove the changed behavior?
- What edge case is still uncovered?

## Test Review Rules

- Do not trust "tests added" without reading what they assert.
- Check whether tests cover the risky branch or only the happy path.
- Check whether the test would have failed before the change.
- Note when the code change outscopes the tests.

## Anti-Patterns

- summarizing the PR without surfacing defects
- focusing on naming while skipping broken behavior
- making speculative comments with no evidence
- reviewing only one changed file in a large risky PR
- assuming CI passing means behavior is correct

## Connector And CLI Paths

- Use GitHub connector metadata and diff tools when available.
- Use `gh pr view`, `gh pr diff`, or local `git diff` when working from CLI.
- Prefer file-by-file patch review for large PRs.
- Read inline comment threads before duplicating the same concern.

## Output Contract

Return:

- numbered findings first
- each finding with severity and concise evidence
- open questions or assumptions second
- short overall summary last

## Example Review Skeleton

```markdown
1. High: ...
2. Medium: ...

Open questions:
- ...

Summary:
The PR is close, but the auth refresh path and missing regression coverage should be addressed before merge.
```

## Decision Rules

- If there are no findings, say so explicitly.
- If a concern is speculative, present it as an open question rather than a finding.
- If the diff is too large to fully trust, call out residual risk.
- If review scope is partial, say what you did and did not inspect.

## Common Failure Modes

- reviewing intent instead of actual code
- missing transitive risk in adjacent files
- underweighting missing tests
- overproducing nitpicks and hiding serious issues
- skipping residual risk when certainty is limited

## Recovery Moves

- Re-read the highest-risk file after forming a first opinion.
- Compare changed tests against changed production branches.
- Re-check assumptions against the actual code path.
- Collapse low-value nitpicks so important findings stand out.

## Checklist

1. Read PR metadata.
2. Scan risky files first.
3. Review diffs for behavior changes.
4. Inspect tests and CI claims.
5. Write findings ordered by severity.
6. Separate findings from open questions.
7. Keep summary short.
8. State residual risk honestly.
