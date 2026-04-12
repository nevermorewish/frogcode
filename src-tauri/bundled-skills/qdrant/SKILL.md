---
name: qdrant
description: High-performance vector search engine for production RAG — Rust-powered, horizontal scaling, hybrid dense+sparse search, metadata filtering.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [RAG, Vector-Search, Qdrant, Embeddings, Production, Distributed, Hybrid-Search]
    related_skills: [chroma, pinecone, faiss]
---

# Qdrant — Production Vector Search Engine

High-performance, Rust-powered vector database for production RAG systems. Best for self-hosted deployments needing speed and horizontal scale.

## When to Use Qdrant vs Alternatives

- **Qdrant**: Production self-hosted, need speed + filtering + scale
- **Chroma**: Local dev, simple RAG prototypes
- **Pinecone**: Managed cloud, don't want to self-host
- **FAISS**: Pure in-memory, research, maximum speed

---

## Setup

```bash
pip install qdrant-client sentence-transformers

# Run Qdrant server
docker run -d -p 6333:6333 -p 6334:6334 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

---

## Connect

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams

# Local Docker
client = QdrantClient(host="localhost", port=6333)

# Cloud
client = QdrantClient(
    url="https://your-cluster.aws.cloud.qdrant.io",
    api_key="your-api-key"
)

# In-memory (testing)
client = QdrantClient(":memory:")
```

---

## Create Collection

```python
client.create_collection(
    collection_name="my_docs",
    vectors_config=VectorParams(
        size=384,           # match embedding model dimension
        distance=Distance.COSINE,  # COSINE | EUCLID | DOT
    ),
)
```

---

## Upsert Points

```python
from qdrant_client.models import PointStruct
from sentence_transformers import SentenceTransformer
import uuid

model = SentenceTransformer("all-MiniLM-L6-v2")

documents = [
    {"text": "Python async programming", "source": "docs", "year": 2024},
    {"text": "Machine learning with PyTorch", "source": "tutorial", "year": 2023},
]

embeddings = model.encode([d["text"] for d in documents])

points = [
    PointStruct(
        id=str(uuid.uuid4()),
        vector=emb.tolist(),
        payload=doc,
    )
    for doc, emb in zip(documents, embeddings)
]

client.upsert(collection_name="my_docs", points=points)
```

---

## Search

```python
from qdrant_client.models import Filter, FieldCondition, MatchValue

query = "how to write async code?"
q_vec = model.encode([query])[0].tolist()

# Basic search
results = client.search(
    collection_name="my_docs",
    query_vector=q_vec,
    limit=5,
)

# With metadata filter
results = client.search(
    collection_name="my_docs",
    query_vector=q_vec,
    query_filter=Filter(
        must=[FieldCondition(key="source", match=MatchValue(value="docs"))]
    ),
    limit=5,
    with_payload=True,
)

for r in results:
    print(f"[{r.score:.3f}] {r.payload['text']}")
```

---

## Hybrid Search (Dense + Sparse)

```python
from qdrant_client.models import SparseVector, NamedSparseVector, NamedVector

# Setup collection with both dense and sparse
client.create_collection(
    collection_name="hybrid",
    vectors_config={
        "dense": VectorParams(size=384, distance=Distance.COSINE),
    },
    sparse_vectors_config={
        "sparse": SparseVectorParams(),
    },
)

# Search with RRF fusion
from qdrant_client.models import Prefetch, FusionQuery, Fusion

results = client.query_points(
    collection_name="hybrid",
    prefetch=[
        Prefetch(query=dense_vec, using="dense", limit=20),
        Prefetch(query=SparseVector(indices=[1,5,3], values=[0.1, 0.8, 0.5]),
                 using="sparse", limit=20),
    ],
    query=FusionQuery(fusion=Fusion.RRF),
    limit=5,
)
```

---

## Filtering Operations

```python
from qdrant_client.models import (
    Filter, FieldCondition, MatchValue, MatchAny,
    Range, HasIdCondition
)

# Match value
Filter(must=[FieldCondition(key="source", match=MatchValue(value="docs"))])

# Match any of
Filter(must=[FieldCondition(key="category", match=MatchAny(any=["tech", "science"]))])

# Range filter
Filter(must=[FieldCondition(key="year", range=Range(gte=2023, lte=2025))])

# Combine
Filter(
    must=[FieldCondition(key="source", match=MatchValue(value="docs"))],
    should=[FieldCondition(key="year", range=Range(gte=2024))],
    must_not=[FieldCondition(key="archived", match=MatchValue(value=True))],
)
```

---

## Delete / Update

```python
# Delete by IDs
client.delete(collection_name="my_docs", points_selector=["id1", "id2"])

# Delete by filter
from qdrant_client.models import FilterSelector
client.delete(
    collection_name="my_docs",
    points_selector=FilterSelector(
        filter=Filter(must=[FieldCondition(key="source", match=MatchValue(value="old"))])
    )
)

# Collection info
info = client.get_collection("my_docs")
print(f"Vectors: {info.points_count}")
```

---

## Batch Upsert (Large Datasets)

```python
BATCH_SIZE = 100
for i in range(0, len(points), BATCH_SIZE):
    batch = points[i:i+BATCH_SIZE]
    client.upsert(collection_name="my_docs", points=batch)
    print(f"Uploaded {min(i+BATCH_SIZE, len(points))}/{len(points)}")
```
