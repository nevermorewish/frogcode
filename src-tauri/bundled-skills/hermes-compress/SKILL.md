---
name: hermes-compress
description: Compress conversation context — summarize the current session, extract key decisions and facts, then compact history to free up context window.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Context, Compression, Memory, Session]
    related_skills: [hermes-memory, hermes-search]
---

# hermes-compress

Compress the current conversation context by extracting what matters, writing a structured summary to memory, and producing a compact session-state block that can replace the full history in future context windows.

## Invocation

```
/hermes-compress
```

No arguments required. Claude will process the full conversation history visible in the current context window.

---

## What This Skill Does

When invoked, Claude executes the following steps in order:

### Step 1 — Review All Messages

Claude reads every message in the current conversation from the beginning: user turns, assistant turns, tool calls, and tool results. Nothing is skipped. The goal is to produce a lossless inventory of everything meaningful that occurred.

### Step 2 — Extract Structured Content

Claude identifies and categorizes content into six buckets:

| Bucket | What goes here |
|--------|----------------|
| `decisions` | Choices the user or Claude made ("we decided to use Postgres", "REST over gRPC") |
| `artifacts_created` | Files written, code blocks produced, configs generated (include file paths) |
| `problems_solved` | Bugs fixed, errors resolved, blockers cleared |
| `facts_learned` | New information ingested from user, tools, or research |
| `open_issues` | Unresolved questions, TODOs, known bugs not yet fixed |
| `next_steps` | Explicit or implied follow-up actions |

### Step 3 — Write to Memory

Claude writes the structured summary to the project memory file at:

```
~/.claude/projects/<project-slug>/memory/session_<YYYYMMDD_HHMM>.md
```

If the file already exists (e.g., from a previous compress run in the same day), Claude appends rather than overwrites, with a `---` separator and a new timestamp header.

Claude also updates `MEMORY.md` to add an index entry pointing to the new session file.

### Step 3a - Handle Memory Write Failures

- Create the memory directory before writing if it does not already exist.
- Write the session file first and update `MEMORY.md` second so a partial failure does not lose the summary.
- If appending fails because an existing session file is malformed, leave the old file untouched and write a new timestamped file instead.
- If the memory index update fails, report that the session file was written and that index repair is still needed.
- If the environment is read-only or permission-restricted, skip file writes, tell the user exactly what could not be persisted, and still emit the session-state block.
- If the conversation is too large to process in one pass, summarize in chunks and merge the six buckets before writing.
- Never drop explicit user requirements, file paths, commands, or unresolved blockers during fallback processing.

### Step 4 — Identify What Can Be Dropped

Claude classifies each segment of the conversation as:

- **Retain** — essential for ongoing work (active code, current decisions, open issues)
- **Compress** — can be replaced by the summary (resolved discussions, background context)
- **Drop** — safe to discard (pleasantries, duplicate messages, superseded ideas)

This classification is not surfaced to the user by default but informs the session-state block.

### Step 5 — Produce the Session-State Block

Claude outputs a compact YAML block that contains everything needed to resume the session from scratch:

```yaml
# hermes-compress session state
# Generated: 2026-04-07T14:32:00Z
# Original message count: 47
# Compressed to: ~800 tokens

session:
  project: ontology-workspace
  date: 2026-04-07
  duration_approx: 90min

decisions:
  - "Use Neo4j as primary graph store for ontology nodes"
  - "REST API over gRPC for external integrations"
  - "Deploy to Vercel, not Railway"

artifacts_created:
  - path: "AlexAI/api/routes.py"
    description: "FastAPI router with /query and /ingest endpoints"
  - path: "CLAUDE.md"
    description: "Updated with hermes-compress active persona note"

problems_solved:
  - "Fixed OpenCrab surrogate encoding error by normalizing Korean queries to English"
  - "Resolved Neo4j connection timeout by bumping pool size to 20"

facts_learned:
  - "opencrab_flex.py fallback_cypher field contains a ready-made Cypher query"
  - "Honcho profile stored at ~/.claude/projects/*/memory/user_honcho_profile.md"

open_issues:
  - "hermes-search --recent N subcommand not yet tested against real history file"
  - "MEMORY.md index needs backfill for sessions before 2026-03-01"

next_steps:
  - "Run /hermes-search 'Neo4j connection' to verify memory is searchable"
  - "Commit routes.py and push to main branch"
  - "Set up Vercel project link with vercel link --repo"
```

This block is output at the end of the `/hermes-compress` response so the user can copy it into a new conversation window to resume without carrying the full history.

---

## Output Format

The full `/hermes-compress` response is structured as:

1. **Compression report** — one paragraph: how many messages reviewed, how many tokens estimated saved, what was written to memory.
2. **Session-state block** — the YAML block above.
3. **Resume instruction** — one line: "Paste the session-state block at the top of your next conversation to resume."

---

## Integration with hermes-memory

If the `hermes-memory` skill is active, `/hermes-compress` will:
- Automatically sync the session file to the hermes-memory index.
- Tag the session with topics extracted from the `decisions` and `facts_learned` fields.
- Make the session searchable via `/hermes-search`.

---

## Automatic Invocation

Claude should suggest `/hermes-compress` proactively when:
- The conversation exceeds approximately 80% of the available context window.
- The user has been working for more than 60 minutes on a complex task.
- A major milestone has been reached (e.g., all planned files written, a bug resolved).

Claude will display: "Context window is getting full. Run `/hermes-compress` to summarize and free space."

---

## Relationship to Hermes `/compress` Command

This skill is the Claude Code equivalent of the `/compress` command in Hermes Agent (NousResearch). Hermes `/compress` triggers a session summarization pass within its SQLite-backed session store. In hermes-CCC, the equivalent is writing structured Markdown to the project memory directory, since Claude Code does not have a persistent database backend by default. The output schema (decisions, artifacts, open_issues, next_steps) mirrors the Hermes compress output contract.

---

## Notes

- Claude does not discard any part of the actual conversation history. Compression is about writing a compact *representation* to memory, not editing or deleting messages.
- The session-state YAML is designed to be pasted at the start of a new conversation as a system-level context seed.
- For very long sessions (500+ messages), Claude will process in passes: first pass extracts decisions and artifacts, second pass extracts facts and open issues.
