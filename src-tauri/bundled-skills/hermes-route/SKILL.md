---
name: hermes-route
description: Route Claude Code work by complexity, risk, and tool needs. Use when deciding how much reasoning depth a task needs, whether to read project memory first, whether the task should be decomposed, and whether the work is lightweight, standard, or investigation-heavy.
version: 0.1.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  category: orchestration
  ported_from: NousResearch Hermes Agent
  tags:
    - routing
    - planning
    - triage
    - claude-code
  tools:
    - shell
    - update_plan
    - project-docs
  maturity: beta
---

# Hermes Route

## Purpose

- Route a task before execution instead of discovering complexity halfway through.
- Decide whether the task is lightweight, standard, or deep-investigation work.
- Decide whether memory, docs, code search, or external research should be loaded first.
- Decide whether the work should stay serial or be decomposed into independent streams.
- Decide whether the task needs a short answer, a coded implementation, or a formal review.

## Activation Signals

- Use this skill when the request is ambiguous and execution strategy matters.
- Use this skill when a task mixes coding, research, design, and review concerns.
- Use this skill when the user asks for the "best approach" before doing work.
- Use this skill when a repository is large and the wrong first step would waste time.
- Use this skill when a request includes pasted code, logs, stack traces, or multiple objectives.
- Use this skill when deciding whether model depth should be lightweight, balanced, or deep.
- Use this skill before spawning subagents if subagent use is permitted in the environment.

## Inputs To Assess

- User goal
- Expected deliverable
- Repository size or scope
- Availability of tests
- Presence of failing output
- Presence of URLs or external references
- Need for exact citations or source grounding
- Need for code edits versus explanation only
- Need for a review mindset versus implementation mindset

## Complexity Buckets

### Lightweight

- Single factual question
- Small formatting or wording change
- One-file trivial edit
- Quick command lookup
- Simple transformation with no hidden state

### Standard

- One feature or bug across a small number of files
- Straightforward repo navigation
- Routine API or CLI integration
- Clear user goal with moderate context gathering
- Normal answer length and low ambiguity

### Deep

- Bug with unclear root cause
- Refactor with behavioral risk
- Architecture question with tradeoffs
- Code review over a large diff
- Request that needs external verification
- Request that mixes implementation, validation, and migration

## Routing Procedure

1. Identify the user's actual deliverable.
2. Decide whether the request is asking for implementation, review, research, or planning.
3. Scan for hard signals:
   - code blocks
   - logs
   - diffs
   - URLs
   - multiple numbered asks
   - references to bugs, regressions, or production issues
4. Estimate the cost of taking the wrong first step.
5. Check whether project instructions such as `AGENTS.md` or `CLAUDE.md` are likely to constrain the work.
6. Decide whether memory should be loaded before action.
7. Decide whether a plan is necessary.
8. Decide whether the task can remain local or needs external verification.
9. Decide whether the work is serial or parallelizable.
10. Produce an execution recommendation before touching files.

## Decision Rules

- Favor `lightweight` when the request is self-contained and reversible.
- Favor `standard` when the work is bounded but still requires code or documentation reading.
- Favor `deep` when root cause, architecture, or evidence gathering dominates.
- Favor reading memory first when the task touches existing conventions, prior decisions, or long-lived projects.
- Favor reading project docs first when repository instructions likely govern the work.
- Favor a review mindset when the user asks for "review", "audit", "risk", "regression", or "findings".
- Favor implementation immediately when the task is concrete and the user did not ask to brainstorm.

## Model-Depth Mapping

- If model choice is exposed, map `lightweight` to a fast cheap model.
- If model choice is exposed, map `standard` to the default balanced model.
- If model choice is exposed, map `deep` to the strongest reasoning model.
- If model choice is not exposed, emulate the distinction with planning depth and evidence gathering.
- Never use a lightweight mode for debugging ambiguous failures or reviewing risky diffs.

## Pre-Execution Recommendations

- `Read memory first` when project memory or previous decisions likely matter.
- `Read instructions first` when a repo includes `AGENTS.md`, `CLAUDE.md`, or package docs.
- `Plan first` when more than one workstream or nontrivial sequencing exists.
- `Implement directly` when the request is bounded and the likely path is obvious.
- `Verify externally` when the user asks for current information, citations, links, or latest status.

## Parallelism Rules

- Split work only when the subtasks have disjoint outputs.
- Keep the critical path local if the next action depends on the answer.
- Delegate sidecar research, mechanical edits, or verification only when permitted.
- Do not delegate unclear problem framing.
- Do not create parallel work that will race on the same files.

## Warning Signs

- The request seems simple but contains hidden integration risk.
- The user asks for "quick" changes in security, auth, or payments code.
- The user mixes "explain", "implement", and "review" in one sentence.
- The task mentions "today", "latest", "current", or "most recent".
- The task references a file, page, or document you have not read.

## Output Contract

Always produce a compact routing block with:

- `Task class`
- `Execution mode`
- `Read first`
- `Parallelism`
- `Reasoning depth`
- `Why`
- `First concrete step`

## Example Output

```markdown
Task class: deep
Execution mode: implement with plan
Read first: AGENTS.md, failing test output, relevant auth module
Parallelism: no
Reasoning depth: high
Why: The request is a bug fix with unclear cause and likely cross-file behavior.
First concrete step: reproduce the failure and trace the auth decision path.
```

## Fast Heuristics

- Code plus error output usually means `deep`.
- One-file copy edit usually means `lightweight`.
- Feature addition with known target files usually means `standard`.
- Review requests default to `deep` even if no edits are required.
- Migration requests default to `deep` because compatibility risks dominate.

## Failure Modes

- Overrouting a trivial task into unnecessary planning
- Underrouting a risky task and making premature edits
- Ignoring repo instructions that change the allowed workflow
- Delegating work before the problem is framed
- Treating an external-facts question as if stale local memory were enough

## Recovery Moves

- If new ambiguity appears, re-run routing instead of forcing execution.
- If the first read reveals larger scope, upgrade from `standard` to `deep`.
- If the task shrinks after inspection, downgrade and execute directly.
- If the user clarifies scope, rewrite the routing block and continue.

## Checklist

1. Identify deliverable.
2. Identify mindset: implement, review, research, or plan.
3. Check for code, logs, URLs, and multi-part asks.
4. Decide complexity bucket.
5. Decide whether memory should be loaded.
6. Decide whether instructions must be read first.
7. Decide whether a plan is warranted.
8. Decide whether the work can stay serial.
9. Produce the routing block.
10. Start the first concrete step immediately after routing.
