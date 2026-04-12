---
name: hermes-traj
description: Capture Claude Code interaction trajectories in training-friendly formats. Use when saving successful runs, failed runs, review samples, evaluation traces, or compact datasets for later QA and fine-tuning analysis.
version: 0.1.0
author: OpenAI Codex
license: MIT
metadata:
  category: telemetry
  ported_from: NousResearch Hermes Agent
  tags:
    - trajectories
    - dataset
    - qa
    - fine-tuning
  tools:
    - filesystem
    - json
    - shell
  maturity: beta
---

# Hermes Traj

## Purpose

- Save useful conversations as structured training or QA artifacts.
- Separate successful traces from failed traces.
- Preserve the task, outcome, and signal-rich decisions without saving noise.
- Build a dataset that can be reviewed, filtered, and improved over time.
- Make post-task learning operational instead of aspirational.

## Default File Strategy

- Use a success JSONL file for completed helpful runs.
- Use a failure JSONL file for incomplete or incorrect runs.
- Keep one JSON object per line.
- Prefer append-only writes with later offline cleanup.
- Store files in a predictable project path.

## Recommended Fields

- `id`
- `timestamp`
- `task_type`
- `completed`
- `model`
- `tags`
- `source_context`
- `conversations`
- `artifacts`
- `verification`
- `failure_reason` for failed runs

## Conversation Shape

- Represent turns as ordered objects.
- Use explicit speaker labels such as `human` and `assistant`.
- Preserve the actual ask and the actual resolution.
- Remove filler and repeated status updates.
- Keep tool-heavy tasks summarized rather than dumping every command output.

## Supported Capture Modes

### Save

- Use for a successful interaction.
- Mark `completed` as `true`.
- Include what was changed or delivered.
- Include how success was verified.

### Save-Failed

- Use for incorrect, incomplete, or abandoned work.
- Mark `completed` as `false`.
- Include a short `failure_reason`.
- Include enough context to diagnose the failure later.

### Review

- Inspect recent entries for quality drift.
- Look for repeated failure reasons.
- Look for under-tagged entries.
- Look for overlong assistant messages.

### Stats

- Count entries by task type.
- Count success versus failure.
- Report model distribution if present.
- Report top tags and date range.

## Summarization Rules

- Keep the core problem statement.
- Keep the main actions and why they mattered.
- Keep the final result or failure.
- Keep verification evidence.
- Drop incidental chatter and repeated acknowledgements.
- Prefer one concise assistant summary over many micro-updates.

## Tagging Rules

- Use `2` to `5` tags.
- Choose tags that help slice the dataset later.
- Prefer subsystem, task type, and failure pattern tags.
- Avoid ultra-generic tags like `task` or `work`.
- Reuse existing tag vocabulary when possible.

## Task Type Suggestions

- `coding`
- `debugging`
- `review`
- `research`
- `writing`
- `ops`
- `other`

## Verification Field Guidance

- Note whether tests passed.
- Note whether lint passed.
- Note whether the result is unverified because execution was unavailable.
- Keep verification factual and short.
- Do not fabricate successful validation.

## Example Success Object

```json
{
  "id": "traj-20260407-001",
  "timestamp": "2026-04-07T04:00:00Z",
  "task_type": "debugging",
  "completed": true,
  "model": "deep",
  "tags": ["auth", "redirect-loop", "python"],
  "source_context": "repo task",
  "conversations": [
    {"from": "human", "value": "Fix the login redirect loop."},
    {"from": "assistant", "value": "Reproduced the loop, traced the auth guard, updated the condition, and added a regression test."}
  ],
  "artifacts": ["tests/test_auth.py"],
  "verification": "targeted test passed"
}
```

## Example Failed Object

```json
{
  "id": "traj-20260407-002",
  "timestamp": "2026-04-07T05:00:00Z",
  "task_type": "coding",
  "completed": false,
  "model": "standard",
  "tags": ["mcp", "config"],
  "source_context": "repo task",
  "conversations": [
    {"from": "human", "value": "Register the MCP server."},
    {"from": "assistant", "value": "Updated the config draft but could not verify transport startup."}
  ],
  "artifacts": ["config/mcp.json"],
  "verification": "not run",
  "failure_reason": "environment lacked server executable for startup validation"
}
```

## Save Procedure

1. Determine whether the run was successful.
2. Choose success or failure file.
3. Summarize the turns into concise conversation objects.
4. Assign task type.
5. Assign tags.
6. Note artifacts touched.
7. Note verification honestly.
8. Append one JSON object as one line.

## Review Procedure

1. Read the recent tail of success and failure files.
2. Sample for quality rather than reading the full corpus.
3. Check for missing fields.
4. Check for repeated failure patterns.
5. Suggest dataset hygiene improvements.

## Stats Procedure

1. Count total lines in each file.
2. Parse entries that are valid JSON.
3. Bucket by task type.
4. Bucket by tag.
5. Report success rate.
6. Highlight malformed lines if any exist.

## Quality Standards

- Every entry must be parseable JSON.
- Every entry must be understandable without the original chat transcript.
- Every entry must preserve the real problem.
- Every entry must preserve the real outcome.
- Every failed entry must say why it failed.

## Failure Modes

- storing verbatim chat noise
- omitting verification
- using inconsistent tags
- saving too little detail to learn from
- mixing multiple tasks into one entry
- inventing success when the run was not verified

## Recovery Moves

- If an entry is too long, rewrite it as a compact factual summary.
- If tags drift, normalize them during review.
- If JSONL has malformed lines, quarantine and rewrite them.
- If failure reasons are vague, revise them while context is still fresh.

## Good Triggers

- "save this run"
- "capture this failure"
- "log this for training data"
- "review our recent trajectories"
- "show dataset stats"

## Checklist

1. Decide success or failure.
2. Summarize the conversation.
3. Tag it properly.
4. Record artifacts and verification.
5. Append valid JSON.
6. Keep one object per line.
7. Review quality periodically.
8. Use failures to improve skills and workflows.
