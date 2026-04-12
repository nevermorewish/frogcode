---
name: hermes-insights
description: Generate insights about your Claude Code usage — what topics you work on most, common patterns, productivity trends.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Analytics, Insights, Usage, Productivity]
    related_skills: [hermes-search, honcho]
---

# hermes-insights

Analyze your Claude Code usage patterns across sessions and produce a structured insight report: what topics you work on most, which skills you use, what types of projects dominate your workflow, and where your productivity is strongest.

## Invocation

```
/hermes-insights
/hermes-insights --days <N>
```

---

## Subcommands

### `/hermes-insights` — Full Analysis

Analyzes all available memory files and session history with no time constraint.

### `/hermes-insights --days <N>` — Time-Bounded Analysis

Restricts analysis to session files created in the last N days.

**How Claude filters by date:**

```bash
find ~/.claude/projects/*/memory/session_*.md \
     -mtime -<N> -type f
```

---

## Data Sources and What Claude Analyzes

### 1. Memory Files — Topic and Theme Extraction

```bash
ls ~/.claude/projects/*/memory/session_*.md
```

For each session file, Claude reads the `decisions`, `facts_learned`, `artifacts_created`, and `open_issues` sections and extracts noun phrases as topic signals. Topics are then counted and ranked by frequency across all sessions.

**Output:** Top 10 topics, each with session count and a representative example decision or fact.

### 2. Skills Used — Skill Utilization

```bash
ls ~/.claude/skills/
ls ~/.claude/projects/*/skills/ 2>/dev/null
```

Claude counts which skill directories exist and cross-references session memory files for any `/skill-name` invocation patterns mentioned in the `decisions` or `facts_learned` fields.

**Output:** Skill utilization table (skill name, invocation count estimate, last used date).

### 3. Project Types and Domains

Claude reads each session file's `project:` field (from the hermes-compress YAML) and groups sessions by project slug. It then infers the domain from artifact paths and topic keywords (e.g., `.py` artifacts + "Neo4j" keywords → "graph database / Python backend").

**Output:** Project breakdown table (project, session count, primary domain, last active date).

### 4. Conversation Patterns

Claude counts per-session: number of decisions made, artifacts created, problems solved, and open issues left unresolved. These become productivity metrics.

**Output:** Per-week averages for decisions, artifacts, and resolution rate (problems solved / open issues ratio).

### 5. Data Hygiene and Confidence Rules

- Skip any session file that is missing the expected `hermes-compress` YAML block and record how many files were excluded.
- Normalize topic strings by lowercasing, trimming punctuation, and folding obvious singular/plural variants before counting.
- Prefer explicit evidence from `decisions` and `artifacts_created` over weak inference from prose when assigning project domains.
- Mark a skill as `inferred` if the file only mentions the skill name indirectly and no `/skill-name` invocation is present.
- Downgrade trend claims to `low confidence` when fewer than 5 sessions match the selected date range.
- Report `no sessions matched the filter` instead of fabricating empty charts when `--days <N>` returns zero files.
- Treat duplicate session paths with identical timestamps as one observation so repeated syncs do not inflate counts.
- Fall back to `unknown project` when the `project:` field is absent and artifact paths do not provide a clear slug.
- Separate unresolved carry-over work from newly opened issues so the resolution rate is not overstated.

---

## Full Output Structure

```
## Claude Code Usage Insights
Generated: 2026-04-07 | Sessions analyzed: 23 | Date range: 2026-02-14 – 2026-04-07

### Top Topics
| Rank | Topic              | Sessions | Example |
|------|--------------------|----------|---------|
| 1    | Neo4j / graph DB   | 14       | "Use Neo4j as primary ontology store" |
| 2    | FastAPI / Python   | 11       | "REST endpoints for /query and /ingest" |
| 3    | Vercel deployment  | 7        | "Deploy to Vercel with vercel link --repo" |
| 4    | OpenCrab ontology  | 6        | "Fallback to neo4j when opencrab returns 0" |
| 5    | Discord integration| 4        | "Reply via plugin_discord_discord reply tool" |

### Skill Utilization
| Skill             | Est. Invocations | Last Used  |
|-------------------|-----------------|------------|
| hermes-compress   | 18              | 2026-04-07 |
| hermes-memory     | 12              | 2026-04-05 |
| hermes-search     | 9               | 2026-04-06 |
| hermes-persona    | 5               | 2026-04-03 |
| honcho            | 3               | 2026-03-28 |

### Project Breakdown
| Project       | Sessions | Domain                  | Last Active |
|---------------|----------|-------------------------|-------------|
| ontology      | 14       | Graph DB / Python API   | 2026-04-07 |
| AlexAI        | 6        | LLM product / strategy  | 2026-04-02 |
| hermes-CCC    | 3        | Claude Code skills      | 2026-04-07 |

### Productivity Trends (weekly averages)
- Decisions per session: 4.2
- Artifacts created per session: 2.8
- Problems solved per session: 1.9
- Resolution rate: 68% (open issues closed within 2 sessions)

### Recommendations
- **Automate Neo4j setup:** It appears in 61% of sessions. Consider a project template.
- **Increase hermes-compress frequency:** 5 sessions have no memory file (no compress run).
- **hermes-persona unused in recent sessions:** Last used 4 days ago — may boost focus in coder mode.

### Key Takeaway
You are most productive in graph database and Python API work, averaging 2.8 artifacts per session, with a 68% issue resolution rate.
```

---

## How Claude Gathers the Data

1. List all session memory files: `ls -t ~/.claude/projects/*/memory/session_*.md`
2. For each file: read the YAML block, extract fields, count keywords.
3. Aggregate counts using simple frequency tallies in working memory.
4. Format and output the insight report.

Claude does not write any files during `/hermes-insights`. The command is read-only.

---

## Relationship to Hermes `/insights` Command

This skill mirrors the `/insights` command in Hermes Agent (NousResearch), which produces usage analytics from the SQLite session store. In hermes-CCC, the equivalent data source is the Markdown session memory files written by `hermes-compress`. The output categories (topics, skill utilization, productivity trends, recommendations) match the Hermes insights contract.

---

## Notes

- Accuracy improves with more `hermes-compress` runs. Sessions without a memory file are invisible to this analysis.
- `/hermes-insights` works best after at least 5 sessions of memory accumulation.
- Pair with `honcho update` to keep the user profile current after reviewing insights.
