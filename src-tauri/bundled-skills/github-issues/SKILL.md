---
name: github-issues
description: GitHub issue management — create, update, label, milestone, and link issues to PRs via gh CLI or curl fallback.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [GitHub, Issues, Project-Management, Automation, Triage]
    related_skills: [github-code-review, github-pr-workflow, github-auth]
---

# GitHub Issues

Full issue lifecycle management using the `gh` CLI. Every command has a `curl` fallback for machines without `gh`.

## Prerequisites

- GitHub CLI: `gh auth login` (or set `GH_TOKEN` env var)
- curl fallback: set `GITHUB_TOKEN` and know your `OWNER/REPO`

```bash
export OWNER=myorg
export REPO=myrepo
export GITHUB_TOKEN=ghp_...
```

---

## List Issues

```bash
# Open issues
gh issue list

# Filter by label, assignee, state
gh issue list --state open --label bug --assignee @me

# All states
gh issue list --state all --limit 50

# curl fallback
curl -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues?state=open&per_page=20"
```

---

## View an Issue

```bash
gh issue view 123

# Open in browser
gh issue view 123 --web

# curl fallback
curl -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/123"
```

---

## Create an Issue

```bash
gh issue create \
  --title "Fix null pointer in auth module" \
  --body "Steps to reproduce:\n1. ...\n2. ..." \
  --label "bug,priority:high" \
  --assignee @me

# Interactive
gh issue create

# curl fallback
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$OWNER/$REPO/issues" \
  -d '{"title":"Fix null pointer","body":"...","labels":["bug"]}'
```

---

## Edit an Issue

```bash
# Add label
gh issue edit 123 --add-label "priority:high"

# Remove label
gh issue edit 123 --remove-label "needs-triage"

# Change assignee
gh issue edit 123 --add-assignee username

# Set milestone
gh issue edit 123 --milestone "v2.0"

# Change title
gh issue edit 123 --title "New title"
```

---

## Comment on an Issue

```bash
gh issue comment 123 --body "Looking into this now."

# curl fallback
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/123/comments" \
  -d '{"body":"Looking into this now."}'
```

---

## Close / Reopen an Issue

```bash
gh issue close 123
gh issue close 123 --reason "completed"
gh issue close 123 --comment "Fixed in #456"

gh issue reopen 123
```

---

## Search Issues

```bash
gh issue list --search "error in production"
gh issue list --search "label:bug created:>2024-01-01"

# GitHub search syntax
gh issue list --search "is:open is:issue assignee:@me"
```

---

## Link Issues to PRs

Reference issues in PR body or commits:
```
Fixes #123
Closes #456
Resolves #789
```

GitHub auto-closes linked issues when PR merges.

---

## Bulk Operations

```bash
# Close all issues with a label
gh issue list --label "wontfix" --json number --jq '.[].number' | \
  xargs -I{} gh issue close {} --reason "not planned"

# List issues as JSON
gh issue list --json number,title,labels,assignees --limit 100
```

---

## Milestones

```bash
# List milestones
gh api repos/$OWNER/$REPO/milestones

# Create milestone
gh api repos/$OWNER/$REPO/milestones \
  --method POST \
  -f title="v2.0" \
  -f due_on="2024-06-01T00:00:00Z"
```

---

## Labels

```bash
# List labels
gh label list

# Create label
gh label create "priority:high" --color FF0000 --description "Urgent"

# Clone labels from another repo
gh label clone owner/source-repo
```

---

## Issue Templates

Create `.github/ISSUE_TEMPLATE/bug_report.md`:
```markdown
---
name: Bug Report
about: Report a bug
labels: bug
---

## Description
## Steps to Reproduce
## Expected vs Actual
## Environment
```
