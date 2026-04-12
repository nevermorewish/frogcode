---
name: hermes-search
description: Search across past conversation sessions, memory files, and project history to recall what was discussed, decided, or built in previous sessions.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Search, Memory, Sessions, History, Recall]
    related_skills: [hermes-memory, hermes-compress, hermes-insights]
---

# hermes-search

Search across past conversation sessions, memory files, and project files to recall what was discussed, decided, or built. This skill is the cross-session retrieval complement to `hermes-compress`, which writes the memory, and `hermes-memory`, which indexes it.

## Invocation

```
/hermes-search "<query>"
/hermes-search --memory "<query>"
/hermes-search --project "<query>"
/hermes-search --recent <N>
```

---

## Subcommands

### `/hermes-search "<query>"` — Search All Memory

Searches all available memory sources in order:

1. `~/.claude/projects/*/memory/*.md` — all project memory files
2. `~/.claude/history.jsonl` — conversation history log (if accessible)
3. Project files under the current working directory
4. `MEMORY.md` index

Returns a unified result list sorted by relevance.

**How Claude executes this:**

```bash
# Memory files
grep -r --include="*.md" -l "<query>" ~/.claude/projects/*/memory/

# Within matched files, extract surrounding context
grep -n -A 3 -B 3 "<query>" <matched-file>

# Project files (from cwd)
grep -r --include="*.md" --include="*.py" --include="*.ts" \
     --include="*.json" -l "<query>" .

# history.jsonl (if present)
grep "<query>" ~/.claude/history.jsonl | head -20
```

---

### `/hermes-search --memory "<query>"` — Memory Files Only

Restricts search to `~/.claude/projects/*/memory/*.md`. Faster and more focused. Use this when you know the information was captured in a previous session via `hermes-compress` or `hermes-memory`.

**How Claude executes this:**

```bash
grep -r --include="*.md" -n -A 3 -B 3 "<query>" \
     ~/.claude/projects/*/memory/
```

Returns: file path, line number, and 3 lines of surrounding context per match.

---

### `/hermes-search --project "<query>"` — Project Files Only

Restricts search to the current working directory. Useful for recalling where a piece of code or config lives.

**How Claude executes this:**

```bash
grep -r --include="*.md" --include="*.py" --include="*.ts" \
     --include="*.js" --include="*.json" --include="*.yaml" \
     -n -l "<query>" .
```

Claude then reads the top 3 matched files and extracts the relevant sections.

---

### `/hermes-search --recent <N>` — Recent N Sessions Summary

Lists and summarizes the most recent N session memory files.

**How Claude executes this:**

```bash
ls -t ~/.claude/projects/*/memory/session_*.md | head -<N>
```

Claude reads each file and produces a one-line summary per session:
`[date] [project] — <top decision or artifact from that session>`

---

## Output Format

All subcommands return results in the following structure:

```
## Search Results: "<query>"
Source: --memory | --project | all
Query time: <timestamp>

### Match 1
- Source: ~/.claude/projects/ontology/memory/session_20260321_1430.md (line 47)
- Relevance: high
- Snippet:
  > decisions:
  >   - "Use Neo4j as primary graph store for ontology nodes"  ← MATCH
  >   - "REST API over gRPC for external integrations"

### Match 2
- Source: ./AlexAI/api/routes.py (line 12)
- Relevance: medium
- Snippet:
  > # Neo4j connection pool config  ← MATCH
  > driver = GraphDatabase.driver(uri, auth=(user, pw), max_connection_pool_size=20)

---
Total matches: 2 | Searched: 14 files
```

**Relevance scoring** (heuristic):
- **High:** exact phrase match in a `decisions` or `facts_learned` block
- **Medium:** keyword match in a session file body or code comment
- **Low:** keyword match in a filename or metadata field

---

## What Gets Searched

| Source | Path pattern | Format |
|--------|-------------|--------|
| Session summaries | `~/.claude/projects/*/memory/session_*.md` | YAML/Markdown |
| Memory index | `~/.claude/projects/*/memory/MEMORY.md` | Markdown |
| Honcho profiles | `~/.claude/projects/*/memory/user_honcho_profile.md` | YAML/Markdown |
| Project source files | `./**/*.{md,py,ts,js,json,yaml}` | Any |
| History log | `~/.claude/history.jsonl` | JSONL (if accessible) |

---

## Handling Missing Sources

- If `~/.claude/history.jsonl` does not exist or is not readable, Claude skips it and notes: "history.jsonl not accessible — searching memory files only."
- If no memory files exist, Claude reports: "No memory files found. Run `/hermes-compress` after a session to start building memory."
- If project files return too many matches (>50), Claude limits output to the top 10 by file modification date (most recent first).

---

## Relationship to Hermes FTS5 Session Search

This skill is the Claude Code equivalent of Hermes Agent's full-text search over its SQLite session store (using SQLite FTS5). In Hermes, `/search <query>` performs a ranked FTS5 query over all session message content. In hermes-CCC, the equivalent is `grep`-based search over the Markdown memory files written by `hermes-compress`. The result schema (source, relevance, snippet) mirrors the Hermes search output contract.

For projects that generate large volumes of session memory, consider building a local SQLite FTS5 index over the memory files using the `hermes-memory` skill's index-build subcommand.

---

## Notes

- Search is case-insensitive by default. Add `--case-sensitive` flag to override.
- Queries containing spaces should be quoted: `/hermes-search "Neo4j connection pool"`.
- `/hermes-search` does not modify any files. It is always read-only.
- Results are printed to the conversation; they are not automatically written to memory. If a search result is important, follow up with `/hermes-memory add` to pin it.
