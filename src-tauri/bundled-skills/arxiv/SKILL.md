---
name: arxiv
description: Search and retrieve academic papers from arXiv using their free REST API. No API key needed.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Research, Arxiv, Papers, Academic, API]
    related_skills: [research-paper-writing]
---

# arXiv

## Purpose

- Use this skill to search, inspect, and download academic papers from arXiv.
- Prefer it for literature review, paper triage, and reproducible paper retrieval.
- arXiv access is free and does not require an API key.
- The primary API is Atom XML over HTTP.

## Base Endpoint

- Base URL: `https://export.arxiv.org/api/query`
- Response format: Atom XML feed
- Transport: HTTP GET
- Authentication: none

## Core Record Shape

- `id`: canonical entry URL for the paper
- `title`: paper title
- `summary`: abstract text
- `authors`: ordered author list
- `published`: original publication timestamp
- `categories`: arXiv subject tags
- `pdf_url`: direct PDF URL when present

## Useful Categories

- `cs.AI`
- `cs.LG`
- `cs.CL`
- `stat.ML`
- `cs.CV`

## Search Syntax

- Search terms are passed in `search_query=...`
- Field prefixes narrow the query:
- `ti:` title search
- `au:` author search
- `abs:` abstract search
- `all:` broad metadata search
- Combine terms with `AND`, `OR`, and `ANDNOT`
- URL-encode spaces as `+` or `%20`

## Common Query Patterns

- `all:reasoning+AND+cat:cs.AI`
- `ti:transformer+AND+cat:cs.CL`
- `au:Goodfellow+AND+cat:cs.LG`
- `abs:diffusion+AND+cat:cs.CV`
- `all:reinforcement+learning+AND+cat:stat.ML`

## CLI Subcommands

- `/arxiv search`
- `/arxiv get`
- `/arxiv recent`
- `/arxiv download`

## Subcommand Intent

- `/arxiv search`: run a query and print matching entries
- `/arxiv get`: fetch one known arXiv identifier and display parsed metadata
- `/arxiv recent`: list recent submissions in a category or topic
- `/arxiv download`: save the PDF locally from a known identifier or PDF URL

## Search Example With curl

```bash
curl -s "https://export.arxiv.org/api/query?search_query=all:large+language+models+AND+cat:cs.CL&start=0&max_results=5&sortBy=relevance&sortOrder=descending"
```

## Recent Example With curl

```bash
curl -s "https://export.arxiv.org/api/query?search_query=cat:cs.LG&start=0&max_results=10&sortBy=submittedDate&sortOrder=descending"
```

## PDF Download Example With curl

```bash
curl -L "https://arxiv.org/pdf/2401.01234.pdf" -o 2401.01234.pdf
```

## Fetch A Single Entry By Identifier

```bash
curl -s "https://export.arxiv.org/api/query?id_list=2401.01234"
```

## Rate Limit Guidance

- Keep requests at or below `3 req/sec`
- Sleep between loops when paginating large result sets
- Cache parsed results locally if you will revisit them
- Avoid hammering the endpoint with concurrent workers

## Python Parsing Pattern

```python
import xml.etree.ElementTree as ET
from urllib.request import urlopen

API_URL = "https://export.arxiv.org/api/query?search_query=all:reasoning+AND+cat:cs.AI&start=0&max_results=3"
NS = {"atom": "http://www.w3.org/2005/Atom"}

with urlopen(API_URL) as response:
    xml_bytes = response.read()

root = ET.fromstring(xml_bytes)

for entry in root.findall("atom:entry", NS):
    paper_id = entry.findtext("atom:id", default="", namespaces=NS)
    title = entry.findtext("atom:title", default="", namespaces=NS).strip()
    summary = entry.findtext("atom:summary", default="", namespaces=NS).strip()
    published = entry.findtext("atom:published", default="", namespaces=NS)
    authors = [
        author.findtext("atom:name", default="", namespaces=NS)
        for author in entry.findall("atom:author", NS)
    ]
    categories = [node.attrib.get("term", "") for node in entry.findall("atom:category", NS)]
    pdf_url = ""
    for link in entry.findall("atom:link", NS):
        if link.attrib.get("title") == "pdf":
            pdf_url = link.attrib.get("href", "")
            break
    print("id:", paper_id)
    print("title:", title)
    print("published:", published)
    print("authors:", ", ".join(authors))
    print("categories:", ", ".join(categories))
    print("pdf_url:", pdf_url)
    print("summary:", summary[:240], "...")
    print("-" * 60)
```

## Minimal Search Helper

```python
import xml.etree.ElementTree as ET
from urllib.parse import quote_plus
from urllib.request import urlopen

def search_arxiv(query: str, max_results: int = 5) -> list[dict]:
    encoded = quote_plus(query)
    url = (
        "https://export.arxiv.org/api/query"
        f"?search_query={encoded}&start=0&max_results={max_results}"
    )
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    with urlopen(url) as response:
        root = ET.fromstring(response.read())
    rows = []
    for entry in root.findall("atom:entry", ns):
        authors = [
            node.findtext("atom:name", default="", namespaces=ns)
            for node in entry.findall("atom:author", ns)
        ]
        categories = [node.attrib.get("term", "") for node in entry.findall("atom:category", ns)]
        rows.append(
            {
                "id": entry.findtext("atom:id", default="", namespaces=ns),
                "title": entry.findtext("atom:title", default="", namespaces=ns).strip(),
                "summary": entry.findtext("atom:summary", default="", namespaces=ns).strip(),
                "authors": authors,
                "published": entry.findtext("atom:published", default="", namespaces=ns),
                "categories": categories,
            }
        )
    return rows

for row in search_arxiv("all:multimodal AND cat:cs.CV", max_results=3):
    print(row["title"])
```

## Example AI And ML Queries

- `all:chain-of-thought AND cat:cs.AI`
- `all:instruction tuning AND cat:cs.CL`
- `all:reward modeling AND cat:cs.LG`
- `all:vision transformer AND cat:cs.CV`
- `all:mixture of experts AND cat:stat.ML`
- `ti:retrieval augmented generation`
- `abs:alignment AND cat:cs.AI`

## Practical Retrieval Workflow

1. Search broadly with `all:` and a category.
2. Narrow with `ti:` if the result set is noisy.
3. Pull the top 5 to 20 entries.
4. Parse `title`, `summary`, and `categories`.
5. Keep the paper `id` for citation and later retrieval.
6. Download only shortlisted PDFs.

## Sorting And Pagination

- `start` controls the starting offset
- `max_results` controls page size
- `sortBy=relevance` is useful for topic search
- `sortBy=submittedDate` is useful for recent monitoring
- `sortOrder=descending` is typical for recent feeds

## ID And PDF Notes

- arXiv IDs may appear as modern identifiers like `2401.01234`
- older identifiers can include subject prefixes
- PDF links usually resolve as `https://arxiv.org/pdf/<id>.pdf`
- the canonical entry page remains useful for metadata stability

## Bulk Access Notes

- Use the API for ordinary search and retrieval tasks.
- For large-scale corpus access, arXiv also publishes bulk data and S3-style access paths in some workflows.
- Bulk S3 access is appropriate for offline indexing, not for interactive one-off queries.
- If you need many thousands of records, prefer bulk snapshots over high-frequency API pagination.

## Failure Handling

- If the feed is empty, print the final URL and query string first.
- If XML parsing fails, save the raw response before retrying.
- If `pdf_url` is missing, synthesize it from the parsed identifier.
- If you get throttled, back off and reduce concurrency.

## Good Defaults

- Start with `max_results=5`
- Use `sortBy=relevance` for topic search
- Use `sortBy=submittedDate` for `/arxiv recent`
- Keep summaries trimmed in terminal output
- Persist parsed metadata as JSON if you will cite or compare papers later

## Output Contract

- Always print `id`
- Always print `title`
- Always print `summary`
- Always print `authors`
- Always print `published`
- Always print `categories`
- Always print `pdf_url` if available

## When Not To Use This Skill

- Do not use this as your only citation source for final camera-ready metadata.
- Do not assume arXiv category tags equal venue topics.
- Do not use the interactive API for massive mirror-scale ingestion jobs.

