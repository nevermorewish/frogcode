---
name: systematic-debugging
description: Run a disciplined multi-phase debugging loop for Claude Code tasks. Use when failures are ambiguous, regressions are hard to localize, logs are noisy, or a bug fix must be proven rather than guessed.
version: 0.1.0
author: OpenAI Codex
license: MIT
metadata:
  category: engineering
  ported_from: NousResearch Hermes Agent
  tags:
    - debugging
    - root-cause
    - regression
    - verification
  tools:
    - shell
    - tests
    - logs
  maturity: beta
---

# Systematic Debugging

## Purpose

- Prevent guess-driven bug fixing.
- Turn a vague failure into a proved root cause.
- Separate symptom collection from patching.
- Minimize regressions while repairing defects.
- Leave behind a reproducible explanation of the failure.

## Activation Signals

- Use this skill when the root cause is unknown.
- Use this skill when a previous fix attempt failed.
- Use this skill when the bug spans multiple files or layers.
- Use this skill when logs, stack traces, or user reports disagree.
- Use this skill when the fix must be defensible in review.

## Debugging Phases

1. Stabilize the report.
2. Reproduce the failure.
3. Narrow the surface area.
4. Instrument the system.
5. Generate hypotheses.
6. Prove or kill hypotheses.
7. Patch the true cause.
8. Verify the fix.
9. Add regression protection.
10. Save the lesson if durable.

## Phase 1: Stabilize The Report

- Write the exact symptom in one sentence.
- Record expected behavior.
- Record actual behavior.
- Capture environment assumptions.
- Capture whether the issue is deterministic or flaky.
- Capture whether it is new, old, or recently regressed.
- Avoid editing code during this phase.

## Phase 2: Reproduce The Failure

- Find the smallest reproducible path.
- Prefer automated reproduction over manual UI clicking.
- Save the failing command when possible.
- If no test exists, create a reproduction harness.
- Record exact inputs, flags, and fixtures.
- If the bug is flaky, measure frequency instead of pretending it is stable.

## Phase 3: Narrow The Surface Area

- Identify likely subsystem boundaries.
- Diff recent changes when history is relevant.
- Check whether the failure begins before or after I/O boundaries.
- Compare passing and failing code paths.
- Use binary search over scope when the change window is large.
- Reduce the problem before adding more instrumentation.

## Phase 4: Instrument The System

- Add temporary logging only where uncertainty exists.
- Prefer cheap inspection over permanent noisy logging.
- Log invariant checkpoints, not everything.
- Print or inspect the variables that decide branching behavior.
- If async behavior is involved, log timestamps and ordering.
- Remove temporary instrumentation after the fix unless it becomes useful observability.

## Phase 5: Generate Hypotheses

- Generate multiple plausible causes, not one favorite theory.
- Rank hypotheses by explanatory power and test cost.
- Prefer hypotheses that explain all observed symptoms.
- Write down what evidence would falsify each one.
- Do not patch based on intuition alone.

## Phase 6: Prove Or Kill Hypotheses

- Design the smallest experiment that differentiates the top hypotheses.
- Run one high-signal experiment at a time.
- Keep notes on what each result means.
- Kill hypotheses aggressively when evidence contradicts them.
- Escalate instrumentation only when the current evidence is insufficient.

## Phase 7: Patch The True Cause

- Change only the code implicated by evidence.
- Prefer the smallest change that restores the invariant.
- Avoid bundling unrelated cleanup in the debug patch.
- If the bug exposed a missing boundary, add the boundary explicitly.
- Preserve readability even for emergency fixes.

## Phase 8: Verify The Fix

- Re-run the original reproduction.
- Re-run nearby tests.
- Check negative cases, not just the positive happy path.
- Validate that logs or state transitions now match expectation.
- If the bug was flaky, run enough repetitions to earn confidence.

## Phase 9: Add Regression Protection

- Add or strengthen a test that would have caught the bug.
- Place the test at the lowest layer that reliably expresses the defect.
- If a test is impossible, document the missing seam.
- Prefer deterministic tests over timing-sensitive ones.

## Phase 10: Save The Lesson

- Save a durable memory entry if the issue reflects a reusable pattern.
- Save a trajectory if the investigation is valuable for QA or training data.
- Update docs only if the bug revealed a workflow or contract gap.

## Evidence Sources

- failing tests
- stack traces
- logs
- diffs
- recent commits
- config files
- environment variables
- production reports
- screenshots or traces

## Useful Commands

```bash
pytest -k "failing_case" -vv
rg "relevant_symbol|error_text" .
git diff --stat
git log --oneline -- path/to/file
```

## Decision Rules

- If you cannot reproduce the issue, stop calling it fixed.
- If two symptoms disagree, debug the disagreement first.
- If a bug appears after a refactor, compare invariants, not just syntax.
- If instrumentation grows large, your narrowing step failed.
- If the patch is broad, your hypothesis is still weak.

## Anti-Patterns

- editing first, explaining later
- assuming the first stack trace frame is the root cause
- mixing refactor work into a debug patch
- adding logs everywhere
- declaring victory after one pass on a flaky issue

## Output Contract

Return a compact debug summary with:

- symptom
- reproduction
- root cause
- patch
- verification
- regression protection
- residual risk

## Example Output

```markdown
Symptom: login succeeds but redirect loops back to /signin
Reproduction: pytest tests/test_auth.py::test_redirect_loop -vv
Root cause: middleware treated a partially hydrated session as unauthenticated
Patch: guard now waits for the session token before redirecting
Verification: targeted auth test passed; manual flow rechecked
Regression protection: added test for partially hydrated session state
Residual risk: none observed outside auth middleware
```

## Failure Modes

- no reliable reproduction
- incomplete instrumentation
- hypothesis chosen before evidence
- patch fixes symptom but not cause
- missing regression test

## Recovery Moves

- Build a reproduction harness if one does not exist.
- Re-scope the failing boundary if evidence stays noisy.
- Revert speculative changes and return to a known failing baseline.
- Reduce the diff until each change has a reason.

## Checklist

1. Stabilize the report.
2. Reproduce the failure.
3. Narrow the surface area.
4. Instrument selectively.
5. Rank hypotheses.
6. Prove or kill them.
7. Patch the true cause.
8. Verify with evidence.
9. Add regression protection.
10. Save durable lessons.
