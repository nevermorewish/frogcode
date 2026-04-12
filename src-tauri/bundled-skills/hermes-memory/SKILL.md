---
name: hermes-memory
description: Manage durable project memory for Claude Code. Use when prefetching relevant history before work, syncing stable decisions after work, nudging for unsaved lessons, compressing noisy notes, or auditing memory quality.
version: 0.1.0
author: OpenAI Codex
license: MIT
metadata:
  category: memory
  ported_from: NousResearch Hermes Agent
  tags:
    - memory
    - persistence
    - context
    - project-history
  tools:
    - filesystem
    - shell
    - markdown
  maturity: beta
---

# Hermes Memory

## Purpose

- Keep long-lived project facts out of ephemeral chat history.
- Load only the memory that matters for the current task.
- Save reusable lessons instead of repeating the same investigation later.
- Prevent memory sprawl by separating durable facts from temporary chatter.
- Make project knowledge auditable, editable, and diffable.

## What Counts As Durable Memory

- architecture decisions
- naming conventions
- repository-specific workflows
- known failure signatures and fixes
- user preferences that change how work should be done
- stable environment constraints
- reusable commands or validation routines
- external integration quirks that repeatedly matter

## What Does Not Belong In Memory

- one-off task status
- temporary branch names
- speculative ideas that were never adopted
- verbose transcripts
- sensitive secrets or tokens
- logs that can be regenerated
- transient failures without a confirmed lesson

## Suggested Layout

- `memory/MEMORY.md` as the index
- one file per topic or subsystem
- stable headings inside each memory file
- short descriptions in the index so prefetch remains cheap

## Canonical Headings

- `## Decisions`
- `## Preferences`
- `## Tooling Notes`
- `## Error Patterns`
- `## Validation`
- `## Open Questions`

## Operations

### Prefetch

- Use before nontrivial work.
- Read the memory index first.
- Select only files relevant to the current task.
- Summarize the relevant items into a short working context.
- Do not dump full memory files into the answer unless asked.

### Sync

- Use after completing work with durable lessons.
- Review what changed in understanding, not just what files changed.
- Merge new facts into the most specific existing file.
- Create a new file only when no current topic fits cleanly.
- Update `MEMORY.md` if a new file is created.

### Nudge

- Use after complex work when valuable lessons exist but should not be saved automatically.
- Produce candidates and proposed destinations.
- Ask for confirmation when the workflow or environment requires explicit approval.
- Prefer small curated memory candidates over bulk transcript dumps.

### Compress

- Use when memory files become repetitive or bloated.
- Merge duplicate bullets.
- Promote stable headings.
- Remove stale or contradicted material.
- Replace long narratives with short factual bullets.

### Status

- Use to audit coverage and hygiene.
- Check for missing files referenced by the index.
- Check for oversized files that need compression.
- Check for duplicate topics across files.

## Prefetch Procedure

1. Read the index.
2. Match the current task to likely topics.
3. Open only the top few relevant files.
4. Extract facts that constrain the task.
5. Separate hard constraints from softer preferences.
6. Return a compact `memory-context` block.
7. List what files were checked and which were actually relevant.

## Sync Procedure

1. Review the completed work.
2. Ask what lesson would help six weeks from now.
3. Reject task-local noise.
4. Map each accepted lesson to an existing topic file.
5. Add or edit concise bullets under stable headings.
6. Update the index if the topic is new.
7. Report what was saved and where.

## Compression Rules

- Keep one canonical phrasing for each stable fact.
- Merge near-duplicate fixes into one general error pattern when possible.
- Keep commands that were verified.
- Remove commands that no longer match the current environment.
- Prefer "why plus what" over long narratives.

## Memory Entry Style

- Write factual bullets, not paragraphs of storytelling.
- Include dates when change over time matters.
- Mention affected subsystem, file family, or command family.
- Keep each bullet independently useful.
- If a rule has exceptions, state them directly.

## Example Entry

```markdown
## Error Patterns

- 2026-04-07: PowerShell profile loading can fail under sandboxed runs. Use `login=false` for non-interactive repository inspection commands when possible.
```

## Reporting Format For Prefetch

````markdown
```memory-context
- Fact: project uses repo-local AGENTS instructions for coding behavior
- Preference: keep edits minimal and verify with targeted checks
- Error pattern: sandboxed PowerShell sessions may need profile loading disabled
```

Files checked:
- memory/MEMORY.md
- memory/tooling.md
- memory/repo-workflow.md

Relevant files:
- memory/tooling.md
````

## Reporting Format For Sync

```markdown
Saved memory updates:
- memory/tooling.md: added note about PowerShell profile failures in sandboxed runs
- memory/repo-workflow.md: added validation preference for targeted checks before broad test suites
```

## Decision Rules

- Save a fact only if it is likely to matter again.
- Save a preference only if the user has shown it consistently.
- Save a fix only if root cause or remedy is reasonably understood.
- Save a command only if it was actually used or confidently verified.
- Prefer edit-in-place over creating memory fragments.

## Failure Modes

- Saving too much and creating memory fatigue
- Saving volatile details that go stale quickly
- Creating duplicate files for the same topic
- Failing to update the index when new files appear
- Prefetching too much and turning memory into noise

## Recovery Moves

- If memory feels noisy, run `compress` before adding more.
- If two files overlap, merge them into the more canonical topic.
- If a past note is wrong, correct it directly and mention the superseding fact.
- If uncertainty remains, store it under `Open Questions` rather than presenting it as settled.

## Good Triggers

- "load context before you start"
- "remember this for next time"
- "save the lesson from this bug"
- "what project memory do we already have about this"
- "compress the memory index"
- "audit our memory files"

## Checklist

1. Decide whether the action is prefetch, sync, nudge, compress, or status.
2. Read the index first.
3. Keep scope narrow.
4. Save only durable material.
5. Use stable headings.
6. Update the index when needed.
7. Report the changes clearly.
8. Leave the memory corpus smaller and more useful than before.
