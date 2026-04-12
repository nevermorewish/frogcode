---
name: pinecone
description: Managed vector database for production RAG — serverless and pod-based deployment, hybrid search, namespaces, and metadata filtering.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [RAG, Vector-Database, Pinecone, Embeddings, Production, Serverless, Managed]
    related_skills: [qdrant, chroma, instructor]
---

# Pinecone — Managed Vector Database

Fully managed vector database for production RAG. Serverless (pay-per-query) or pod-based (dedicated).

## Setup

```bash
pip install pinecone-client sentence-transformers openai
```

```python
from pinecone import Pinecone, ServerlessSpec

pc = Pinecone(api_key="your-api-key")  # or os.environ["PINECONE_API_KEY"]
```

---

## Create Index

```python
# Serverless (pay-per-query — cheapest to start)
pc.create_index(
    name="my-index",
    dimension=1536,          # match your embedding model
    metric="cosine",         # cosine | euclidean | dotproduct
    spec=ServerlessSpec(
        cloud="aws",
        region="us-east-1"
    )
)

# Connect to index
index = pc.Index("my-index")
```

---

## Upsert Vectors

```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")  # dim=384

documents = [
    {"id": "doc1", "text": "Python async programming guide"},
    {"id": "doc2", "text": "Machine learning with PyTorch"},
]

vectors = []
for doc in documents:
    embedding = model.encode(doc["text"]).tolist()
    vectors.append({
        "id": doc["id"],
        "values": embedding,
        "metadata": {"text": doc["text"], "source": "manual"}
    })

# Batch upsert (max 100 per call)
index.upsert(vectors=vectors, namespace="docs")
```

---

## Query

```python
query_text = "how to write async Python?"
query_vector = model.encode(query_text).tolist()

results = index.query(
    vector=query_vector,
    top_k=5,
    namespace="docs",
    include_metadata=True,
)

for match in results["matches"]:
    print(f"Score: {match['score']:.3f} | {match['metadata']['text']}")
```

---

## Metadata Filtering

```python
results = index.query(
    vector=query_vector,
    top_k=5,
    filter={"source": {"$eq": "manual"}},
    include_metadata=True,
)

# Operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or
results = index.query(
    vector=query_vector,
    top_k=5,
    filter={
        "$and": [
            {"category": {"$in": ["tech", "science"]}},
            {"year": {"$gte": 2023}},
        ]
    },
    include_metadata=True,
)
```

---

## Namespaces

```python
# Different namespaces = separate vector spaces (free, no extra cost)
index.upsert(vectors=vectors, namespace="user-123")
index.upsert(vectors=vectors, namespace="user-456")

# Query specific namespace
results = index.query(vector=query_vector, top_k=5, namespace="user-123")

# Delete namespace
index.delete(delete_all=True, namespace="user-123")
```

---

## Fetch / Delete / Update

```python
# Fetch specific vectors
fetched = index.fetch(ids=["doc1", "doc2"], namespace="docs")

# Delete vectors
index.delete(ids=["doc1"], namespace="docs")

# Update metadata (re-upsert with same id)
index.upsert(vectors=[{"id": "doc1", "values": embedding, "metadata": {"updated": True}}])
```

---

## Index Stats

```python
stats = index.describe_index_stats()
print(f"Total vectors: {stats['total_vector_count']}")
print(f"Namespaces: {stats['namespaces']}")
```

---

## When to Use Pinecone vs Alternatives

| | Pinecone | Qdrant | Chroma |
|---|---|---|---|
| Hosting | Managed cloud | Self/cloud | Self/cloud |
| Cost | Pay-per-use | Self-hosted free | Free |
| Scale | Billions | Millions+ | Millions |
| Setup | Minutes | Minutes | Seconds |
| Best for | Production SaaS | Production self-hosted | Local dev/RAG |
