---
name: test-driven-development
description: Apply a disciplined red-green-refactor workflow in Claude Code. Use when adding behavior safely, reproducing a bug before fixing it, designing APIs from the outside in, or strengthening change confidence with targeted tests.
version: 0.1.0
author: OpenAI Codex
license: MIT
metadata:
  category: engineering
  ported_from: NousResearch Hermes Agent
  tags:
    - tdd
    - testing
    - design
    - regression
  tools:
    - shell
    - test-runner
    - diff
  maturity: beta
---

# Test-Driven Development

## Purpose

- Drive implementation from observable behavior.
- Reproduce bugs before fixing them.
- Keep code changes tightly coupled to expected outcomes.
- Use tests as design tools, not just safety nets.
- Reduce regressions by proving each behavior change.

## Activation Signals

- Use this skill when adding a new feature with clear acceptance behavior.
- Use this skill when fixing a bug that should never recur.
- Use this skill when API shape is easier to design from usage than internals.
- Use this skill when reviewers will ask for evidence.
- Use this skill when the codebase already has a strong test culture.

## Core Cycle

1. Write a failing test.
2. Run the smallest test scope and watch it fail for the right reason.
3. Implement the smallest change that makes it pass.
4. Re-run the test.
5. Refactor while keeping tests green.
6. Expand coverage only when a new behavior boundary appears.

## Red Phase

- Express one behavior at a time.
- Name the test after the behavior, not the implementation.
- Ensure the failure is caused by missing behavior, not a broken fixture.
- Keep setup minimal.
- Prefer explicit assertions over snapshot sprawl unless snapshots are already standard.
- For bug fixes, make the failing test mirror the actual defect.

## Green Phase

- Implement the smallest viable change.
- Do not optimize before the test passes.
- Avoid speculative abstractions.
- If several code paths fail, make one behavior pass first.
- Keep the first passing diff small enough to reason about.

## Refactor Phase

- Remove duplication exposed by the passing test.
- Improve names and structure.
- Preserve behavior while simplifying code.
- Re-run relevant tests after each meaningful refactor.
- Stop refactoring once readability improves and the tests still describe the behavior clearly.

## Bug-Fix TDD

- Reproduce the bug in a failing test before touching the fix.
- If reproduction is expensive, build a narrow harness.
- If the bug is timing-sensitive, isolate the timing dependency rather than sleeping more.
- If the bug cannot be reproduced, treat the fix as higher risk and document why.

## Test Selection Rules

- Use unit tests for pure behavior and deterministic branching.
- Use integration tests for component boundaries and data flow.
- Use end-to-end tests only when lower layers cannot express the guarantee.
- Put the regression test at the lowest layer that still captures the defect.

## Assertion Rules

- Assert the most important observable outcome first.
- Prefer stable assertions over implementation detail checks.
- Avoid asserting on incidental formatting unless formatting is the feature.
- For collections, assert the contract that matters: count, key values, order, or identity.

## Good Test Names

- `test_search_returns_ranked_results_for_partial_match`
- `test_login_redirect_does_not_loop_when_session_is_hydrated`
- `test_serializer_rejects_missing_required_field`

## Bad Test Names

- `test_fix`
- `test_works`
- `test_api`
- `test_stuff`

## Useful Commands

```bash
pytest tests/test_module.py::test_specific_behavior -vv
pytest tests/ -k "auth and redirect" -vv
ruff check path/to/file.py
```

## Design Benefits To Exploit

- Tests clarify API ergonomics.
- Tests reveal hidden dependencies.
- Tests pressure functions toward clean inputs and outputs.
- Tests expose when code is too coupled to mock cleanly.

## Decision Rules

- If a feature request has no acceptance behavior, clarify before writing code.
- If the first test is too hard to write, the design seam may be missing.
- If the code needed to pass the test is huge, the test scope is probably too broad.
- If refactoring requires changing many tests, the tests may be overfit to internals.

## Anti-Patterns

- writing tests after the implementation and calling it TDD
- changing the test to match a broken implementation
- asserting on private internals instead of behavior
- creating giant fixture setups for simple behavior
- using TDD language while skipping the red phase

## Output Contract

When reporting TDD progress, include:

- failing test added
- implementation change
- verification command
- refactor notes
- remaining coverage gaps

## Example Status Block

```markdown
TDD status:
- Red: added failing regression test for partially hydrated session redirect
- Green: updated middleware guard to wait for token presence
- Refactor: simplified session-check helper naming
- Verify: pytest tests/test_auth.py::test_login_redirect_does_not_loop_when_session_is_hydrated -vv
```

## Coverage Guidance

- Start with one high-signal test.
- Add neighboring tests only when the bug or feature has multiple edges.
- Do not explode the matrix on the first pass.
- Prefer targeted new tests over broad rewrites of existing suites.

## Failure Modes

- wrong failure reason in red phase
- massive green-phase implementation
- no refactor after a crude passing patch
- tests too brittle to survive harmless refactors
- overuse of mocks where real data flow would be clearer

## Recovery Moves

- Rewrite the test if it fails for the wrong reason.
- Split one large behavior into multiple smaller tests.
- Move down a layer if end-to-end setup is hiding the real contract.
- Replace mocks with real collaborators when possible.

## Checklist

1. Name the behavior.
2. Write the failing test.
3. Confirm the right failure.
4. Implement the smallest fix.
5. Re-run the narrow test.
6. Refactor with tests green.
7. Run adjacent coverage.
8. Report evidence, not confidence alone.
