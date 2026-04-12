---
name: blogwatcher
description: Monitor and summarize blog posts, RSS feeds, and web content for research and staying current with topics.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Research, RSS, Blogs, Monitoring, Summarization]
    related_skills: []
---

# Blogwatcher

## Purpose

- Use this skill to monitor RSS feeds and blog-style content for ongoing research.
- It is useful for staying current on AI, ML, engineering, and product ecosystems.
- Prefer RSS when you want structured updates without scraping full websites every time.

## Install

```bash
pip install feedparser
```

## Parse a Feed

```python
import feedparser

feed = feedparser.parse("https://example.com/rss")
print(feed.feed.title)
print(feed.entries[0].title)
```

- `feedparser` handles RSS and Atom feeds.
- The parsed object exposes feed metadata and a list of entries.

## Access Entry Fields

```python
entry = feed.entries[0]
print(entry.title)
print(entry.summary)
print(entry.link)
print(entry.published)
```

- The most commonly useful fields are `.title`, `.summary`, `.link`, and `.published`.
- Not every feed includes every field, so code defensively.

## Batch Fetch Multiple Feeds

```python
import feedparser

feeds = [
    "https://example.com/rss",
    "https://another.example/feed.xml",
]

all_entries = []
for url in feeds:
    parsed = feedparser.parse(url)
    for entry in parsed.entries:
        all_entries.append(
            {
                "source": parsed.feed.get("title", url),
                "title": entry.get("title", ""),
                "summary": entry.get("summary", ""),
                "link": entry.get("link", ""),
                "published": entry.get("published", ""),
            }
        )
```

- Batch fetches are the standard pattern for topic monitoring.
- Normalize fields early so downstream summarization stays simple.

## Filter by Date or Keyword

- Filter by date when you only care about the most recent week or month.
- Filter by keyword when watching narrow topics like `agents`, `evals`, or `multimodal`.
- Keep the filter stage simple and deterministic.

Example:

```python
keywords = ["llm", "agents", "retrieval"]
filtered = [
    e for e in all_entries
    if any(k.lower() in (e["title"] + " " + e["summary"]).lower() for k in keywords)
]
```

## Summarize With Claude

- Extract the title and summary from each entry.
- Feed the collected set into Claude and ask for synthesis by theme, signal, and novelty.
- This works better than summarizing one feed item at a time when you are tracking a field.

Example prompt shape:

```text
Summarize these AI research updates. Group them into model releases, tooling, benchmarks, and policy. Highlight what appears genuinely new.
```

- Keep the raw title, summary, link, and publication date in the source material.
- Ask for a synthesis, not a rewrite.

## Save Results to a File

```python
import json

with open("feed_digest.json", "w", encoding="utf-8") as f:
    json.dump(filtered, f, ensure_ascii=False, indent=2)
```

- Save structured digests for later comparison.
- JSON is the easiest format for later reprocessing.
- Markdown is convenient if the output is intended for direct reading.

## Common AI and ML Blogs To Monitor

- arXiv Sanity
- Hugging Face Blog
- OpenAI
- Anthropic
- engineering blogs from inference providers, vector DB vendors, and cloud platforms

- Some sources are better via RSS.
- Others may require periodic scraping or newsletter ingestion.

## Combine With `/arxiv`

- Use this skill for blog and announcement monitoring.
- Combine it with `/arxiv` for paper discovery and academic monitoring.
- The combination gives better coverage across research papers, product launches, and engineering writeups.

## Good Monitoring Workflow

1. Define a small set of feeds by topic.
2. Fetch them on a schedule.
3. Normalize fields into one list.
4. Filter by keyword and freshness.
5. Ask Claude to synthesize the daily or weekly signal.
6. Save the resulting digest for later reference.

## Practical Notes

- RSS coverage varies widely by site.
- Feed summaries are often enough for triage but not enough for deep analysis.
- Follow links for the few items that survive filtering.
- Save source links alongside the synthesis so claims remain traceable.

## Summary

- Install RSS parsing support with `pip install feedparser`.
- Parse feeds with `feedparser.parse("https://example.com/rss")`.
- Access fields like `feed.entries[0].title`, `.summary`, `.link`, and `.published`.
- Batch fetch multiple feeds, then filter by date or keyword.
- Summarize title and summary pairs with Claude for cross-source synthesis.
- Save digests to a file and combine this workflow with `/arxiv` for broader research monitoring.
