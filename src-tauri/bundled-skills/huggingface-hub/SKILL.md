---
name: huggingface-hub
description: HuggingFace Hub — download models/datasets, upload artifacts, search, and manage tokens via CLI and Python API.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [MLOps, HuggingFace, Models, Datasets, Hub, Download, Upload]
    related_skills: [grpo-rl-training]
---

# HuggingFace Hub

Download models and datasets, upload artifacts, and manage your Hub presence via CLI and Python API.

## Setup

```bash
pip install huggingface_hub datasets transformers
huggingface-cli login   # paste your token from hf.co/settings/tokens
```

Or set env var:
```bash
export HF_TOKEN=hf_...
```

---

## Download Models

```bash
# Download entire model to cache (~/.cache/huggingface/)
huggingface-cli download meta-llama/Llama-3.1-8B-Instruct

# Download to specific directory
huggingface-cli download Qwen/Qwen2.5-7B-Instruct --local-dir ./models/qwen

# Download specific file only
huggingface-cli download microsoft/phi-4 config.json

# Download GGUF quantized model
huggingface-cli download bartowski/Llama-3.1-8B-Instruct-GGUF \
  Llama-3.1-8B-Instruct-Q4_K_M.gguf --local-dir ./models/
```

Python API:
```python
from huggingface_hub import snapshot_download, hf_hub_download

# Full model
snapshot_download("meta-llama/Llama-3.1-8B-Instruct", local_dir="./models/llama")

# Single file
hf_hub_download("meta-llama/Llama-3.1-8B-Instruct", "config.json", local_dir="./")
```

---

## Download Datasets

```bash
# CLI
huggingface-cli download --repo-type dataset HuggingFaceH4/ultrachat_200k

# Python (preferred)
from datasets import load_dataset

dataset = load_dataset("HuggingFaceH4/ultrachat_200k")
dataset["train_sft"].to_json("./data/train.jsonl")
```

---

## Upload Models

```bash
# Upload directory
huggingface-cli upload your-username/my-model ./local-model-dir

# Upload specific file
huggingface-cli upload your-username/my-model ./model.safetensors

# Create repo first if needed
huggingface-cli repo create my-new-model --type model
```

Python API:
```python
from huggingface_hub import HfApi

api = HfApi()
api.upload_folder(
    folder_path="./fine-tuned-model",
    repo_id="your-username/my-fine-tuned-model",
    repo_type="model",
)
```

---

## Search Models

```bash
# CLI search
huggingface-cli search models --filter task=text-generation --filter language=ko

# Python API
from huggingface_hub import list_models

models = list_models(
    task="text-generation",
    language="ko",
    sort="downloads",
    limit=10,
)
for m in models:
    print(m.id, m.downloads)
```

---

## Cache Management

```bash
# Show cache info
huggingface-cli cache info

# List cached repos
huggingface-cli cache scan

# Delete specific cached model
huggingface-cli cache evict --model meta-llama/Llama-3.1-8B-Instruct

# Cache location
echo ~/.cache/huggingface/hub/
```

Custom cache dir:
```bash
export HF_HOME=/path/to/custom/cache
```

---

## Model Cards

```bash
# Read model card
python -c "from huggingface_hub import ModelCard; print(ModelCard.load('Qwen/Qwen2.5-7B-Instruct'))"
```

---

## Spaces

```bash
# Deploy a Gradio/Streamlit app to Spaces
huggingface-cli upload your-username/my-space ./app --repo-type space

# Check Space status
huggingface-cli space info your-username/my-space
```

---

## Token Management

```bash
# Who am I?
huggingface-cli whoami

# List tokens
huggingface-cli token list

# Revoke
huggingface-cli token revoke TOKEN_NAME
```

---

## Gated Models (Llama, Gemma, etc.)

1. Go to hf.co/model-card and accept terms
2. Use a token with read access: `huggingface-cli login`
3. Download normally — gate is checked server-side

```python
# Check if you have access
from huggingface_hub import model_info
info = model_info("meta-llama/Llama-3.1-8B-Instruct")
print(info.gated)  # False if you have access
```
