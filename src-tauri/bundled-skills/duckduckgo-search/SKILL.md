---
name: duckduckgo-search
description: Free web search via DuckDuckGo - no API key needed. Text, news, images. Use as fallback when other search tools unavailable.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Search, DuckDuckGo, Web-Search, Free, No-API-Key]
    related_skills: []
---

# DuckDuckGo Search

## Purpose

- Use this skill for lightweight web search without an API key.
- It is useful as a fallback when paid search APIs or first-party tools are unavailable.
- The library supports text, news, and image search.
- This is a pragmatic option for prototyping, research helpers, and lightweight retrieval.

## Install

```bash
pip install duckduckgo-search
```

## Why Use It

- No API key required.
- Easy Python integration.
- Useful CLI for quick terminal searches.
- Supports regions and time filters for fresher results.
- Good fallback for general web discovery.

## Python API

- The main entry point is the `DDGS` class.
- Create a client and call the relevant search method.
- Iterate the generator or cast results to a list.

## Text Search Example

```python
from duckduckgo_search import DDGS

with DDGS() as ddgs:
    results = ddgs.text("vector databases for rag", max_results=10)
    for item in results:
        print(item["title"])
        print(item["href"])
        print(item["body"])
        print()
```

- `text()` is the default choice for general web results.
- Use concise queries first, then refine.
- Extract only the fields you actually need for downstream processing.

## News Search Example

```python
from duckduckgo_search import DDGS

with DDGS() as ddgs:
    results = ddgs.news(
        keywords="open source llm releases",
        max_results=10,
        region="us-en",
        timelimit="w",
    )
    for item in results:
        print(item["title"])
        print(item["date"])
        print(item["url"])
```

- News search is better than general text search when recency matters.
- Useful parameters include `keywords`, `max_results`, `region`, and `timelimit`.
- Prefer short keyword-focused queries over verbose natural language.

## Image Search Example

```python
from duckduckgo_search import DDGS

with DDGS() as ddgs:
    results = ddgs.images("server rack diagram", max_results=10)
    for item in results:
        print(item["title"])
        print(item["image"])
```

- `ddgs.images(keywords, max_results)` is the simplest path for image discovery.
- Verify licensing and usage rights before reuse.
- Image results are best for inspiration, references, and visual discovery rather than authoritative facts.

## CLI Usage

```bash
ddgs text -k "query" -m 10
```

- `text` runs a standard web search.
- `-k` sets the keywords.
- `-m 10` limits the maximum number of results.
- This is useful for shell scripts or quick ad hoc research.

## CLI Patterns

```bash
ddgs text -k "python async queue patterns" -m 10
ddgs news -k "gpu inference news" -m 5
ddgs images -k "er diagram examples" -m 8
```

- Use CLI mode when you want zero boilerplate.
- Use Python mode when you need structured post-processing.

## Regions

- `wt-wt` for global results
- `us-en` for United States English
- `kr-ko` for Korea Korean
- regional values can materially change ranking and language mix

Region examples:

```python
results = ddgs.text("open banking regulation", region="wt-wt", max_results=10)
results = ddgs.text("AI policy", region="us-en", max_results=10)
results = ddgs.news("반도체 투자", region="kr-ko", max_results=10)
```

## Time Limits

- `d` for day
- `w` for week
- `m` for month
- `y` for year

Use time limits when:

- tracking current events
- watching new releases
- checking recent blog or news coverage
- reducing stale results

## Rate Limiting

- Do not hammer the service with rapid repeated requests.
- Add a short sleep between loops or batches.
- Cache results locally when queries repeat.
- If you are scraping many queries, batch slowly and keep scope tight.

Simple pattern:

```python
import time
from duckduckgo_search import DDGS

queries = ["llm evals", "vector db benchmarks", "open source agents"]

with DDGS() as ddgs:
    for q in queries:
        results = list(ddgs.text(q, max_results=5))
        print(q, len(results))
        time.sleep(2)
```

## Query Strategy

- Start broad, then narrow.
- Prefer keywords over long questions.
- Use quotes only when exact phrase matching matters.
- Switch to news mode when freshness matters more than general authority.
- Use the region parameter intentionally rather than leaving locality to chance.

## Fallback Positioning

- No API key required means this is a practical fallback.
- It is well suited to a `WebSearch` fallback path in tools or scripts.
- When other providers fail, DDG search can still return useful retrieval candidates.
- It should not be treated as a guaranteed enterprise-grade SLA service.

## Practical Research Workflow

1. Run a text search for broad discovery.
2. Switch to news search for recent developments.
3. Use images when you need visual references or diagrams.
4. Save URLs and summarize locally.
5. Re-run with a region or time filter when result quality is weak.

## Output Handling

- Normalize fields early because result keys can vary slightly across search modes.
- Save title, URL, snippet, source, and date when present.
- Store timestamps when using this for repeated monitoring.
- Filter duplicates before passing results downstream.

## Limitations

- Search result shape may evolve with library updates.
- Relevance is not identical to large paid search providers.
- Image search is discovery-oriented, not rights-cleared asset sourcing.
- Heavy automation can trigger blocking or degraded responses.

## Summary

- Install with `pip install duckduckgo-search`.
- Use the `DDGS` class for text, news, and image search in Python.
- Use `ddgs text -k "query" -m 10` for terminal-based search.
- For news, pass `keywords`, `max_results`, `region`, and `timelimit`.
- For images, use `ddgs.images(keywords, max_results)`.
- Common regions include `wt-wt`, `us-en`, and `kr-ko`.
- Common time limits are `d`, `w`, `m`, and `y`.
- Add sleeps between batches and use it as a no-API-key WebSearch fallback.
