---
name: chroma
description: Open-source embedding database for RAG — store embeddings, vector search, metadata filtering. Simple API, scales from notebook to production.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [RAG, Chroma, Vector-Database, Embeddings, Semantic-Search, Open-Source]
    related_skills: []
---

# Chroma

## Purpose

- Use this skill to store embeddings and perform semantic retrieval for RAG systems.
- Prefer Chroma when you want a simple local developer experience with an easy Python API.
- Chroma works well for notebooks, prototypes, local apps, and moderate production deployments.
- It supports metadata filtering, server mode, and pluggable embedding functions.

## Install

```bash
pip install chromadb sentence-transformers
```

- Add any extra embedding provider packages you need, such as the OpenAI SDK.

## Basic Setup

```python
import chromadb

client = chromadb.PersistentClient(path="./chroma_db")
```

- `PersistentClient` stores data on disk.
- It is a good default for local development and single-node setups.

## Create a Collection

```python
collection = client.create_collection(name="docs")
```

- Use descriptive collection names like `docs`, `papers`, `tickets`, or `kb_chunks`.
- A collection is the logical container for your embeddings and payload metadata.

## Add Documents

- Minimal add call:

```python
collection.add(
    documents=["Chroma is useful for local RAG.", "Vector search retrieves semantically similar text."],
    metadatas=[{"source": "note1"}, {"source": "note2"}],
    ids=["doc-1", "doc-2"],
)
```

- Required arrays must align by index.
- Keep `ids` stable if you plan to update or delete records later.

## Query

```python
results = collection.query(
    query_texts=["How do I store embeddings for RAG?"],
    n_results=5,
)

print(results["documents"])
print(results["metadatas"])
```

- `query_texts=['...']` is the most common path when Chroma is managing embeddings for you.
- Start with `n_results=5` or `10` for most retrieval experiments.

## Basic Collection Lifecycle

- Create collection
- Add documents
- Query for nearest neighbors
- Update documents when content changes
- Delete stale records

## Get or Create

- For idempotent startup flows, prefer `get_or_create_collection`:

```python
collection = client.get_or_create_collection(name="docs")
```

- This is helpful in services that initialize storage on boot.

## Embedding Functions

- Chroma supports multiple embedding strategies.
- Common choices include:
- `DefaultEmbeddingFunction`
- `SentenceTransformerEmbeddingFunction`
- `OpenAIEmbeddingFunction`

## Default Embedding Function

```python
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

embedding_fn = DefaultEmbeddingFunction()
collection = client.get_or_create_collection(
    name="default-embeddings",
    embedding_function=embedding_fn,
)
```

- The default function is convenient for quick experiments.
- For production, you usually want to control the embedding model explicitly.

## SentenceTransformers Embedding Function

```python
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction

embedding_fn = SentenceTransformerEmbeddingFunction(
    model_name="sentence-transformers/all-MiniLM-L6-v2",
)

collection = client.get_or_create_collection(
    name="st-docs",
    embedding_function=embedding_fn,
)
```

- This is a good choice for local semantic search with no external API dependency.

## OpenAI Embedding Function

```python
from chromadb.utils.embedding_functions import OpenAIEmbeddingFunction

embedding_fn = OpenAIEmbeddingFunction(
    api_key="YOUR_API_KEY",
    model_name="text-embedding-3-small",
)

collection = client.get_or_create_collection(
    name="openai-docs",
    embedding_function=embedding_fn,
)
```

- Use this when you want consistent hosted embeddings across environments.
- Track model versions because embedding changes can invalidate similarity behavior.

## Add Structured Documents

```python
collection.add(
    documents=[
        "Retrieval augmented generation combines retrieval with generation.",
        "Chroma collections can store metadata for filtering.",
    ],
    metadatas=[
        {"source": "paper1", "section": "intro", "year": 2024},
        {"source": "paper1", "section": "methods", "year": 2024},
    ],
    ids=["paper1-intro", "paper1-methods"],
)
```

- Include source, section, title, author, or timestamp metadata if you need filtered retrieval.

## Metadata Filtering

- Filter by metadata with `where`:

```python
results = collection.query(
    query_texts=["What does the paper say about filtering?"],
    n_results=5,
    where={"source": "paper1"},
)
```

- Example requested pattern:
- `where={'source': 'paper1'}`

- Metadata filters are critical for multi-tenant or source-restricted RAG.

## Full Text Search

- Chroma also supports document-side text filtering with `where_document`.
- The commonly used operator form is:

```python
results = collection.query(
    query_texts=["database"],
    n_results=5,
    where_document={"$contains": "keyword"},
)
```

- Some examples on the internet simplify this idea informally as `where_document={'...': 'keyword'}`.
- In practice, use the explicit operator form your installed Chroma version documents.

## Update Documents

- Update existing records by ID:

```python
collection.update(
    ids=["doc-1"],
    documents=["Chroma stores embeddings persistently for local RAG systems."],
    metadatas=[{"source": "note1", "updated": True}],
)
```

- Use stable IDs so updates remain deterministic.

## Delete Documents

```python
collection.delete(ids=["doc-2"])
```

- You can also delete by filter in many workflows:

```python
collection.delete(where={"source": "note1"})
```

- Deletes are useful for document re-indexing and source cleanup jobs.

## Inspect Data

- Fetch records directly:

```python
items = collection.get(ids=["doc-1"])
print(items)
```

- Use this for debugging chunk contents, metadata shape, and embedding lifecycle issues.

## HTTP Client for Server Mode

- Chroma can run as a server and be accessed over HTTP.
- Python client example:

```python
import chromadb

client = chromadb.HttpClient(host="localhost", port=8000)
collection = client.get_or_create_collection(name="docs")
```

- This is useful when multiple apps need to share one Chroma instance.

## Docker Server

- Start a server with Docker:

```bash
docker run -p 8000:8000 chromadb/chroma
```

- Pair that with `chromadb.HttpClient(host='localhost', port=8000)` from Python.
- For persistent data in Docker, mount a volume rather than relying on container-local storage.

## Retrieval Design Tips

- Chunk documents before indexing.
- Keep chunk size and overlap consistent during experiments.
- Store source metadata so retrieved chunks can be traced back to originals.
- Log your embedding model name and collection schema.

## Chroma Strengths

- Very easy local setup
- Clean Python API
- Good fit for notebook and single-service workflows
- Flexible embedding function support

## Chroma Limitations

- It is simpler than some production-first vector engines.
- Large-scale distributed deployments may need a more specialized backend.
- You should benchmark real workloads before using it as a high-scale production default.

## Common Failure Modes

- Empty search results:
- confirm documents were added
- confirm the embedding function is configured as expected
- lower filtering constraints

- Embedding mismatch:
- avoid changing embedding models inside the same collection without re-indexing
- document the embedding function used for each collection

- Duplicate records:
- choose deterministic IDs from source path plus chunk index
- upsert or update intentionally instead of re-adding blind

- Server connectivity issues:
- verify the Docker container is running
- confirm `localhost:8000` is reachable
- switch from `PersistentClient` to `HttpClient` only when appropriate

## Recommended Workflow

- Start local with `PersistentClient`.
- Use sentence-transformers for quick offline prototypes.
- Add metadata filters early if you know you need scoped retrieval.
- Move to server mode when multiple apps or services need shared access.

## When To Use This Skill

- You are building a local RAG system.
- You need an easy vector store API inside Python.
- You want metadata-aware retrieval without a heavy infrastructure stack.
- You need a bridge from notebook experimentation to a small production deployment.

## Quick Reference

- Install: `pip install chromadb sentence-transformers`
- Local client: `chromadb.PersistentClient(path="./chroma_db")`
- Add docs: `collection.add(documents=[...], metadatas=[...], ids=[...])`
- Query: `collection.query(query_texts=["..."], n_results=5)`
- Metadata filter: `where={"source": "paper1"}`
- Document text filter: `where_document={"$contains": "keyword"}`
- Server client: `chromadb.HttpClient(host="localhost", port=8000)`
- Docker: `docker run -p 8000:8000 chromadb/chroma`
