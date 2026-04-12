---
name: llama-cpp
description: Run quantized LLMs locally with llama.cpp — CPU+GPU inference, GGUF format, OpenAI-compatible server, and Python bindings.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [MLOps, llama-cpp, Local-Inference, GGUF, Quantization, CPU]
    related_skills: []
---

# llama.cpp

## Purpose

- Use this skill to run quantized GGUF models on laptops, workstations, and edge systems.
- Prefer it when you need portable local inference without a heavyweight serving stack.
- `llama.cpp` is especially useful for CPU-first deployments, low-cost GPU offload, and offline workflows.
- Python users typically access it through `llama-cpp-python`.

## Install

- Fastest path for Python users:

```bash
pip install llama-cpp-python
```

- Build from source when you need custom acceleration backends or tighter platform control.
- Source builds are common for CUDA, Metal, ROCm, Vulkan, and CPU-tuned environments.
- Confirm the package imports successfully:

```bash
python -c "from llama_cpp import Llama; print('ok')"
```

## Model Format

- `llama.cpp` primarily uses the `GGUF` model format.
- GGUF packages tokenizer metadata, architecture settings, and quantized weights in one artifact.
- Choose a GGUF variant that matches your hardware budget and quality target.

## Download GGUF Models

- Hugging Face is the standard source for GGUF checkpoints.
- Common repos include:
- `bartowski/*`
- `TheBloke/*`

- Typical examples:
- `bartowski/Llama-3.1-8B-Instruct-GGUF`
- `TheBloke/Mistral-7B-Instruct-v0.2-GGUF`
- `bartowski/Qwen2.5-7B-Instruct-GGUF`

- Store the downloaded file locally, for example:
- `models/llama-3.1-8b-instruct-q4_k_m.gguf`

## Quantization Levels

- `Q4_K_M`: best balance for many local deployments
- `Q5_K_M`: more quality, more RAM or VRAM
- `Q8_0`: highest quality among common quantized options
- `Q2_K`: very small, but quality drops sharply

- Start with `Q4_K_M` unless you already know the task is quality-sensitive.
- Move to `Q5_K_M` or `Q8_0` for coding, reasoning, or long-form generation where quality matters more.
- Use `Q2_K` only for extreme memory constraints or experiments.

## Basic Python Usage

```python
from llama_cpp import Llama

llm = Llama(
    model_path="models/llama-3.1-8b-instruct-q4_k_m.gguf",
    n_ctx=8192,
    n_threads=8,
    n_gpu_layers=0,
)

output = llm(
    "Explain why GGUF is useful for local inference.",
    max_tokens=256,
    temperature=0.7,
)

print(output["choices"][0]["text"])
```

## Important Init Parameters

- `model_path`: path to the `.gguf` file on disk
- `n_gpu_layers`: number of transformer layers to offload to GPU
- `n_ctx`: context size, constrained by the model and available memory
- `n_threads`: CPU worker threads for prompt processing and generation

- These four parameters are the first tuning knobs to adjust for almost every deployment.

## Initialization Guidance

- Keep `model_path` on a local SSD when possible.
- Set `n_threads` close to the number of performant CPU cores, not necessarily total logical threads.
- Increase `n_ctx` only after checking memory pressure.
- Increase `n_gpu_layers` gradually if the model fails to load or performance is unstable.

## Generation Call

- Basic call shape:

```python
result = llm(
    "Write a short checklist for running a local LLM service.",
    max_tokens=256,
    temperature=0.7,
)
```

- Access the text with:

```python
print(result["choices"][0]["text"])
```

- Keep `max_tokens` bounded for interactive usage.
- Use lower temperatures for summarization, extraction, and tool-style tasks.

## Chat Format

- For instruction-tuned models, prefer the chat API:

```python
from llama_cpp import Llama

llm = Llama(
    model_path="models/qwen2.5-7b-instruct-q4_k_m.gguf",
    n_ctx=8192,
    n_gpu_layers=20,
    n_threads=8,
)

response = llm.create_chat_completion(
    messages=[
        {"role": "system", "content": "You are concise and technical."},
        {"role": "user", "content": "List three tradeoffs of 4-bit quantization."},
    ],
    max_tokens=256,
    temperature=0.4,
)

print(response["choices"][0]["message"]["content"])
```

- Use the chat API when the model card says the checkpoint is chat-tuned or instruct-tuned.
- Keep prompt templates aligned with the model family if outputs seem malformed.

## Streaming Output

- Stream tokens for responsive CLI or web applications:

```python
stream = llm.create_chat_completion(
    messages=[
        {"role": "system", "content": "You are concise."},
        {"role": "user", "content": "Describe GPU offload in llama.cpp."},
    ],
    max_tokens=128,
    temperature=0.3,
    stream=True,
)

for chunk in stream:
    delta = chunk["choices"][0].get("delta", {})
    text = delta.get("content")
    if text:
        print(text, end="", flush=True)
```

- Streaming is useful for chat UIs, terminals, and server-sent event bridges.

## GPU Offload

- `n_gpu_layers=-1` means full GPU offload when supported by the backend and hardware.
- You can also offload only the first `N` layers:

```python
llm = Llama(
    model_path="models/mistral-7b-instruct-q5_k_m.gguf",
    n_ctx=8192,
    n_threads=8,
    n_gpu_layers=-1,
)
```

- If full offload fails, try a partial value like `20`, `30`, or `40`.
- Partial offload is common on consumer GPUs with limited VRAM.

## CPU-Only Example

```python
from llama_cpp import Llama

llm = Llama(
    model_path="models/phi-3-mini-q4_k_m.gguf",
    n_ctx=4096,
    n_threads=12,
    n_gpu_layers=0,
)
```

- CPU-only mode is viable for smaller models and latency-tolerant tasks.
- It is a good fit for offline assistants, batch summarization, and test environments.

## Context Size

- `n_ctx` controls the context window in tokens.
- Larger values increase RAM or VRAM usage.
- The effective maximum depends on the model architecture, quantization, and rope scaling setup.
- Do not assume every GGUF file supports the same long context as the original FP16 checkpoint.

## Context Sizing Rule of Thumb

- Start with `4096` or `8192`.
- Increase only after verifying memory headroom and prompt quality.
- Very large `n_ctx` values can degrade throughput significantly.

## OpenAI-Compatible Server

- `llama-cpp-python` includes a server mode:

```bash
python -m llama_cpp.server --model model.gguf
```

- More realistic example:

```bash
python -m llama_cpp.server \
  --model models/llama-3.1-8b-instruct-q4_k_m.gguf \
  --host 0.0.0.0 \
  --port 8000 \
  --n_ctx 8192
```

- This is useful for local OpenAI-style integrations, prototypes, and thin service wrappers.
- It is not as throughput-optimized as vLLM, but it is easy to run and distribute.

## OpenAI Client Compatibility

- Many local clients can target the server with an OpenAI-compatible base URL:

```python
from openai import OpenAI

client = OpenAI(
    api_key="dummy",
    base_url="http://localhost:8000/v1",
)

resp = client.chat.completions.create(
    model="local-model",
    messages=[
        {"role": "system", "content": "You are concise."},
        {"role": "user", "content": "Summarize Q4_K_M vs Q8_0."},
    ],
    max_tokens=128,
)

print(resp.choices[0].message.content)
```

## Build From Source

- Build from source when:
- you need CUDA acceleration not available in your wheel
- you want Metal on macOS
- you need a specific compiler or backend flag
- you are packaging for a controlled deployment target

- Source builds take more effort but often deliver better hardware utilization.

## Model Families Commonly Used With GGUF

- Llama
- Qwen
- Mistral
- Phi
- Gemma

- Check the prompt format and tokenizer notes for each family before deploying.

## Operational Tips

- Keep a naming convention that encodes model, size, and quantization.
- Store models outside the repo if they are large.
- Benchmark both prompt evaluation speed and generation speed.
- Use the smallest model that meets quality targets.
- Prefer chat-tuned checkpoints for agentic or assistant workloads.

## Common Errors

- Model will not load:
- verify `model_path`
- verify the file is a GGUF checkpoint
- verify the quantization is supported by your build

- Very slow generation:
- increase `n_threads`
- enable GPU offload
- reduce `n_ctx`
- use a smaller model

- Out-of-memory:
- reduce `n_ctx`
- choose `Q4_K_M` instead of `Q8_0`
- reduce `n_gpu_layers` or use CPU-only mode

- Bad chat formatting:
- use `create_chat_completion`
- verify the checkpoint is instruct-tuned
- check whether the model expects a specific chat template

## When To Use This Skill

- You need fully local inference with minimal infrastructure.
- You want a portable inference path for laptops or edge devices.
- You are testing GGUF quantizations before wider deployment.
- You need CPU inference or partial GPU offload instead of a GPU-only server.

## Quick Reference

- Install: `pip install llama-cpp-python`
- Source build: use when you need custom acceleration
- Load model: `from llama_cpp import Llama`
- Key params: `model_path`, `n_gpu_layers`, `n_ctx`, `n_threads`
- Generate: `llm("prompt", max_tokens=256, temperature=0.7)`
- Chat: `llm.create_chat_completion(messages=[...])`
- Server: `python -m llama_cpp.server --model model.gguf`
- Best balance quant: `Q4_K_M`
- Full GPU offload: `n_gpu_layers=-1`
