---
name: subagent-driven-development
description: Decompose Claude Code work into parallel subagent-friendly streams when the environment permits delegation. Use when a task has independent sidecar work, disjoint file ownership, or review/verification streams that can run in parallel without blocking the critical path.
version: 0.1.0
author: OpenAI Codex
license: MIT
metadata:
  category: orchestration
  ported_from: NousResearch Hermes Agent
  tags:
    - subagents
    - parallelism
    - decomposition
    - coordination
  tools:
    - plan
    - subagents
    - review
  maturity: beta
---

# Subagent-Driven Development

## Purpose

- Shorten total task time by parallelizing independent work.
- Keep the critical path moving locally while sidecar work runs elsewhere.
- Prevent duplicated effort between contributors.
- Improve reliability by separating implementation, research, and verification concerns.
- Turn broad requests into explicit owned slices.

## Activation Signals

- Use this skill when the task has multiple independent questions.
- Use this skill when write scopes can be separated cleanly.
- Use this skill when verification can happen in parallel with implementation.
- Use this skill when one thread can map code while another edits disjoint files.
- Use this skill only if the environment allows subagent delegation.

## Non-Use Signals

- Do not use this skill when the user did not permit delegation.
- Do not use this skill when the next local action is blocked on the answer.
- Do not use this skill when the task is small enough to finish faster alone.
- Do not use this skill when the subtasks touch the same files and will conflict.
- Do not use this skill when the problem is still poorly framed.

## Core Principle

- Keep blocking work local.
- Delegate bounded sidecar work.
- Assign explicit ownership.
- Integrate results quickly.
- Do not re-do delegated work yourself.

## Decomposition Procedure

1. Identify the deliverable.
2. Identify the next blocking action.
3. Keep that blocking action local.
4. List other work that can advance in parallel.
5. Split the work by independent outputs or disjoint write sets.
6. Write one concrete prompt per subagent.
7. State ownership and constraints clearly.
8. Continue local progress immediately.

## Good Subtasks

- codebase mapping for a specific subsystem
- docs-backed verification
- isolated backend patch in owned files
- isolated frontend patch in owned files
- targeted regression test creation in a separate file family
- review of a completed patch

## Bad Subtasks

- "figure out the whole problem"
- "do whatever seems useful"
- work that overlaps the same file region
- urgent work needed for the next local decision
- tasks that duplicate what the main thread is already doing

## Prompt Design Rules

- State the task in one sentence first.
- Name the owned files or module boundary.
- Say that the subagent is not alone in the codebase.
- Say not to revert other changes.
- Define the expected final output.
- Include any known constraints or acceptance tests.

## Example Prompt

```text
Implement the parser fix in parser/tokenizer.py only. You are not alone in the codebase, so do not revert unrelated edits and adjust to concurrent changes if needed. Return the files changed and a short note on verification.
```

## Ownership Rules

- One write owner per file family whenever possible.
- Shared read-only context is fine.
- Shared write scope is a last resort.
- Verification agents should prefer read-only work unless asked to patch tests.

## Waiting Rules

- Do not wait immediately after delegation.
- Use the time to do non-overlapping local work.
- Wait only when integration is blocked on the result.
- Prefer longer waits over frequent polling.
- Close finished agents when they are no longer needed.

## Integration Procedure

1. Review the returned output.
2. Check whether the subtask stayed within scope.
3. Read the changed files or summary.
4. Integrate into the local branch carefully.
5. Reconcile any assumptions that conflict with local work.
6. Run the relevant validation.

## Conflict Management

- If two streams unexpectedly touch the same file, stop and replan.
- Do not blindly merge contradictory changes.
- Preserve the clearer ownership model after the replan.
- Prefer one integrator making final decisions.

## Verification Patterns

- implementation locally, review remotely
- implementation remotely, integration locally
- code mapping remotely, coding locally
- docs verification remotely, code changes locally

## Fallback When Subagents Are Not Allowed

- Use the same decomposition framework locally.
- Convert each subagent slice into a checklist item.
- Work the slices sequentially in priority order.
- Preserve explicit ownership even if ownership is just "current thread".

## Decision Rules

- Delegate only if the subtask is concrete and bounded.
- Keep ambiguity resolution local.
- Parallelize information gathering aggressively when it is independent.
- Avoid delegating more agents than the integration cost can support.
- If the main path is short, skip delegation.

## Common Failure Modes

- delegation of blocking work
- overlapping file ownership
- weak prompts that encourage broad wandering
- premature waiting
- local duplication of delegated work

## Recovery Moves

- cancel or redirect a drifting subtask quickly
- re-scope overlapping workers into disjoint ownership
- absorb a small sidecar task locally if delegation overhead dominates
- move verification later if implementation is still unstable

## Output Contract

When presenting the decomposition, include:

- local critical-path task
- delegated sidecar tasks
- ownership per task
- integration point
- validation plan

## Example Decomposition Block

```markdown
Local critical path: reproduce failing parser test and patch tokenizer logic
Delegated sidecar task: map config loading path in config/ only
Delegated verification task: draft regression tests under tests/parser/ only
Integration point: after tokenizer patch compiles
Validation plan: run targeted parser tests and review returned diffs
```

## Checklist

1. Identify the blocking task.
2. Keep it local.
3. Find parallel sidecar tasks.
4. Split by disjoint ownership.
5. Write precise prompts.
6. Continue local work.
7. Wait only when blocked.
8. Integrate and validate.
