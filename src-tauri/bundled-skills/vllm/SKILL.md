---
name: vllm
description: Deploy and serve LLMs with vLLM — OpenAI-compatible inference server with PagedAttention, continuous batching, and quantization support.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [MLOps, vLLM, Inference, Serving, OpenAI-Compatible, LLM]
    related_skills: []
---

# vLLM

## Purpose

- Use this skill to deploy local or remote LLM inference with `vllm`.
- Prefer it when you need OpenAI-compatible serving, high throughput, and modern GPU utilization.
- vLLM is strongest for decoder-only chat and completion models.
- It is a good default for production inference when latency and token throughput matter.

## Install

- Install from PyPI:

```bash
pip install vllm
```

- Verify the install:

```bash
python -c "import vllm; print(vllm.__version__)"
```

- Match your CUDA, NVIDIA driver, and PyTorch stack before deploying on GPUs.
- If deployment is containerized, prefer pinning a known-good image or package version.

## What vLLM Gives You

- OpenAI-compatible HTTP API for chat and completion workflows
- PagedAttention for efficient KV cache memory usage
- Continuous batching for higher aggregate throughput
- Tensor parallelism for multi-GPU serving
- Quantization support for lower memory footprints
- Streaming token responses
- Good support for major open-weight model families

## Common Models

- `meta-llama/Llama-3.1-8B-Instruct`
- `meta-llama/Llama-3.1-70B-Instruct`
- `Qwen/Qwen2.5-7B-Instruct`
- `Qwen/Qwen2.5-14B-Instruct`
- `mistralai/Mistral-7B-Instruct-v0.3`
- `microsoft/Phi-3-medium-4k-instruct`
- `google/gemma-2-9b-it`

## Basic Serve

- Minimal OpenAI-compatible server:

```bash
python -m vllm.entrypoints.openai.api_server --model meta-llama/Llama-3.1-8B-Instruct
```

- By default this serves on port `8000`.
- The API base path is `http://localhost:8000/v1`.
- Health check endpoint:

```bash
curl http://localhost:8000/health
```

## Key Flags

- `--port`: bind a non-default server port
- `--tensor-parallel-size`: split one model across multiple GPUs
- `--gpu-memory-utilization`: cap how much GPU RAM vLLM should attempt to use
- `--max-model-len`: set maximum sequence length for inference
- `--quantization`: load quantized weights when supported

## Serve Examples

- Serve on port `8080`:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-8B-Instruct \
  --port 8080
```

- Raise the context window and tune memory usage:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.92
```

- Use four GPUs with tensor parallelism:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-70B-Instruct \
  --tensor-parallel-size 4
```

## Quantization

- vLLM commonly works with these quantization paths:
- `awq`
- `gptq`
- `bitsandbytes`
- `fp8`

- Example with AWQ:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct-AWQ \
  --quantization awq
```

- Example with GPTQ:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model TheBloke/Mistral-7B-Instruct-v0.2-GPTQ \
  --quantization gptq
```

- Example with FP8:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-8B-Instruct \
  --quantization fp8
```

- AWQ and GPTQ reduce VRAM pressure at some accuracy or compatibility cost.
- `bitsandbytes` is useful when using 4-bit or 8-bit HF-compatible flows.
- FP8 is hardware-sensitive and best validated on your actual deployment target.

## Call Through the OpenAI Client

- vLLM exposes an OpenAI-style API, so the standard OpenAI Python client is a common fit.
- Point the client at the local base URL:

```python
from openai import OpenAI

client = OpenAI(
    api_key="dummy",
    base_url="http://localhost:8000/v1",
)

response = client.chat.completions.create(
    model="meta-llama/Llama-3.1-8B-Instruct",
    messages=[
        {"role": "system", "content": "You are a concise assistant."},
        {"role": "user", "content": "Summarize why continuous batching matters."},
    ],
    temperature=0.2,
    max_tokens=256,
)

print(response.choices[0].message.content)
```

- `base_url='http://localhost:8000/v1'` is the key integration setting.
- Many SDK-based applications can switch from OpenAI-hosted inference to vLLM with only the base URL and model name changed.

## Curl Chat Example

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/Llama-3.1-8B-Instruct",
    "messages": [
      {"role": "system", "content": "You are concise."},
      {"role": "user", "content": "Explain PagedAttention in two sentences."}
    ],
    "temperature": 0.2,
    "max_tokens": 128
  }'
```

## Async Engine Usage in Python

- Use the async engine when embedding vLLM inside a Python application instead of only exposing the HTTP server.
- This pattern is useful for custom services, pipelines, or batched internal inference.

```python
import asyncio

from vllm import AsyncEngineArgs, AsyncLLMEngine, SamplingParams


async def main() -> None:
    engine_args = AsyncEngineArgs(
        model="meta-llama/Llama-3.1-8B-Instruct",
        gpu_memory_utilization=0.9,
        max_model_len=8192,
    )
    engine = AsyncLLMEngine.from_engine_args(engine_args)
    sampling_params = SamplingParams(temperature=0.2, max_tokens=128)

    request_id = "req-1"
    prompt = "List three use cases for OpenAI-compatible local inference."

    async for output in engine.generate(prompt, sampling_params, request_id):
        if output.finished:
            print(output.outputs[0].text)


asyncio.run(main())
```

- Use unique request IDs for concurrent work.
- Reuse one engine per process rather than creating a new engine for every request.
- Keep sampling params explicit for reproducibility in evaluation workflows.

## Multi-GPU Notes

- Scale large models with `--tensor-parallel-size 4` or another GPU count that matches the host.
- Ensure all GPUs are visible and comparable in capability.
- Cross-GPU communication performance matters, so NVLink or high-bandwidth PCIe topology helps.
- Validate memory headroom with the exact context size and batch profile you plan to serve.

## Benchmarking

- Benchmark throughput before promoting a serving config to production.
- Example benchmark entry point:

```bash
python benchmarks/benchmark_throughput.py
```

- Track at least:
- prompt tokens per second
- generated tokens per second
- p50 and p95 latency
- GPU memory usage
- concurrency behavior under steady load

## Docker Deployment

- Container deployment is common for consistent drivers, dependencies, and rollout processes.
- Example run command:

```bash
docker run --gpus all --rm -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:latest \
  --model meta-llama/Llama-3.1-8B-Instruct
```

- Mount the Hugging Face cache to avoid repeated model downloads.
- Pin the image tag in production instead of relying on `latest`.
- Pass the same serving flags in Docker that you would use on bare metal.

## Health and Readiness

- Basic health check:

```bash
curl http://localhost:8000/health
```

- Add a model list probe for smoke testing:

```bash
curl http://localhost:8000/v1/models
```

- In production, combine health checks with a real inference probe before shifting traffic.

## Operational Guidance

- Start with an 8B instruct model before scaling to larger checkpoints.
- Keep `--gpu-memory-utilization` conservative during initial rollout.
- Set `--max-model-len` only as high as the workload requires.
- Prefer quantization only after validating quality, tool calling, and long-context behavior.
- Profile with real prompts, not only synthetic benchmarks.

## Common Failure Modes

- Out-of-memory on startup:
- lower `--max-model-len`
- lower concurrency expectations
- use quantized weights
- reduce model size

- Poor throughput:
- increase batch pressure
- verify GPU utilization
- benchmark with realistic prompt and completion lengths

- Client compatibility issues:
- confirm the app is targeting `http://localhost:8000/v1`
- confirm the requested model name exactly matches the served model

- Quantized model load failures:
- confirm the checkpoint format matches the selected `--quantization` mode
- test a non-quantized baseline first

## When To Use This Skill

- You need an OpenAI-compatible endpoint for self-hosted LLMs.
- You want high-throughput local or cluster inference.
- You need tensor parallel serving for models larger than one GPU can hold.
- You are comparing quantization tradeoffs in a production-style serving stack.

## Quick Reference

- Install: `pip install vllm`
- Serve: `python -m vllm.entrypoints.openai.api_server --model meta-llama/Llama-3.1-8B-Instruct`
- Health: `curl http://localhost:8000/health`
- API base URL: `http://localhost:8000/v1`
- Multi-GPU: `--tensor-parallel-size 4`
- Benchmark: `python benchmarks/benchmark_throughput.py`
