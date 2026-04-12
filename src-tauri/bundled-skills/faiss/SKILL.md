---
name: faiss
description: Facebook AI Similarity Search — ultra-fast vector similarity search for large-scale local embedding retrieval without a database server.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [RAG, FAISS, Vector-Search, Embeddings, Local, Fast, Facebook]
    related_skills: [chroma, qdrant, pinecone]
---

# FAISS — Fast Vector Similarity Search

FAISS (Facebook AI Similarity Search) is a library for efficient similarity search over large collections of vectors. No server required — runs entirely in-process.

## When to Use FAISS

- Millions of vectors, need maximum speed
- Can't run a server (embedded use case)
- Research / prototyping at scale
- Custom index types (HNSW, IVF, PQ)

## Setup

```bash
pip install faiss-cpu        # CPU only
pip install faiss-gpu        # GPU (requires CUDA)
pip install sentence-transformers numpy
```

---

## Basic Flat Index (Exact Search)

```python
import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")  # dim=384
DIM = 384

# Build index
documents = [
    "Python async programming",
    "Machine learning with PyTorch",
    "Docker container management",
    "GraphQL API design",
]

embeddings = model.encode(documents).astype(np.float32)

# Flat L2 index (exact, brute force)
index = faiss.IndexFlatL2(DIM)
index.add(embeddings)
print(f"Index size: {index.ntotal}")

# Search
query = "how to do async in Python?"
q_vec = model.encode([query]).astype(np.float32)

distances, indices = index.search(q_vec, k=3)
for i, idx in enumerate(indices[0]):
    print(f"[{distances[0][i]:.3f}] {documents[idx]}")
```

---

## Cosine Similarity (Normalize first)

```python
# For cosine similarity: normalize vectors, use IndexFlatIP (inner product)
def normalize(vecs):
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    return vecs / np.maximum(norms, 1e-8)

embeddings_norm = normalize(embeddings.astype(np.float32))
index_cos = faiss.IndexFlatIP(DIM)
index_cos.add(embeddings_norm)

q_norm = normalize(model.encode([query]).astype(np.float32))
scores, indices = index_cos.search(q_norm, k=3)
```

---

## IVF Index (Fast Approximate Search)

```python
# For large datasets (>100k vectors)
N_CLUSTERS = 100  # sqrt(N) is a good heuristic

quantizer = faiss.IndexFlatL2(DIM)
index_ivf = faiss.IndexIVFFlat(quantizer, DIM, N_CLUSTERS)

# Must train before adding
index_ivf.train(embeddings)
index_ivf.add(embeddings)
index_ivf.nprobe = 10  # search 10 clusters (higher = more accurate, slower)

distances, indices = index_ivf.search(q_vec, k=5)
```

---

## HNSW Index (Best Speed/Accuracy Tradeoff)

```python
index_hnsw = faiss.IndexHNSWFlat(DIM, 32)  # 32 = M parameter
index_hnsw.add(embeddings)

distances, indices = index_hnsw.search(q_vec, k=5)
```

---

## Save and Load Index

```python
# Save
faiss.write_index(index, "my_index.faiss")

# Load
index = faiss.read_index("my_index.faiss")
```

---

## With Metadata (store separately)

```python
import pickle

# FAISS only stores vectors — store metadata separately
metadata = [{"id": i, "text": doc} for i, doc in enumerate(documents)]

# Save both
faiss.write_index(index, "vectors.faiss")
with open("metadata.pkl", "wb") as f:
    pickle.dump(metadata, f)

# Load and query
index = faiss.read_index("vectors.faiss")
with open("metadata.pkl", "rb") as f:
    metadata = pickle.load(f)

distances, indices = index.search(q_vec, k=3)
for idx in indices[0]:
    print(metadata[idx]["text"])
```

---

## GPU Acceleration

```python
res = faiss.StandardGpuResources()
index_gpu = faiss.index_cpu_to_gpu(res, 0, index)  # GPU 0
distances, indices = index_gpu.search(q_vec, k=5)
```

---

## Index Selection Guide

| Index | Size | Speed | Accuracy | Use Case |
|-------|------|-------|----------|----------|
| IndexFlatL2 | Any | Slow | 100% | <100k vectors, exact needed |
| IndexFlatIP | Any | Slow | 100% | Cosine similarity |
| IndexIVFFlat | Large | Fast | ~95% | 100k–10M vectors |
| IndexHNSWFlat | Medium | Very fast | ~99% | Best general choice |
| IndexIVFPQ | Huge | Fastest | ~90% | Billions, memory-constrained |
