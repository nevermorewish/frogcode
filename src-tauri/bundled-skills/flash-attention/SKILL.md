---
name: flash-attention
description: Optimize transformer attention with Flash Attention — 2-4x speedup, 10-20x memory reduction for long sequences on CUDA GPUs.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Optimization, Flash-Attention, Memory-Efficiency, PyTorch, Transformers, CUDA, Long-Context]
    related_skills: [grpo-rl-training, vllm]
---

# Flash Attention — Fast Memory-Efficient Attention

Flash Attention provides 2-4x training speedup and 10-20x memory reduction by replacing the standard O(N²) attention with an IO-aware tiling algorithm.

## When to Use

- Sequences longer than 512 tokens → always use Flash Attention
- GPU OOM during training → Flash Attention is usually the fix
- Maximizing training throughput → 2-4x faster than standard attention
- H100/A100 with FP8/BF16 → critical for efficiency

---

## Option 1: PyTorch Native SDPA (Easiest — PyTorch 2.2+)

```python
import torch
import torch.nn.functional as F

# PyTorch automatically uses Flash Attention if available
q = torch.randn(2, 8, 512, 64, device="cuda", dtype=torch.float16)
k = torch.randn(2, 8, 512, 64, device="cuda", dtype=torch.float16)
v = torch.randn(2, 8, 512, 64, device="cuda", dtype=torch.float16)

# This automatically dispatches to Flash Attention on compatible hardware
output = F.scaled_dot_product_attention(q, k, v, dropout_p=0.0, is_causal=True)

# Check which kernel is being used
with torch.backends.cuda.sdp_kernel(
    enable_flash=True, enable_math=False, enable_mem_efficient=False
):
    output = F.scaled_dot_product_attention(q, k, v, is_causal=True)
```

---

## Option 2: flash-attn Library (Maximum Performance)

```bash
# Requires: CUDA toolkit, torch, ninja
pip install flash-attn --no-build-isolation

# If build fails:
pip install packaging ninja
pip install flash-attn --no-build-isolation --no-cache-dir
```

```python
from flash_attn import flash_attn_func, flash_attn_varlen_func

# Basic usage: q,k,v shape: (batch, seqlen, nheads, headdim)
q = torch.randn(2, 512, 8, 64, device="cuda", dtype=torch.float16)
k = torch.randn(2, 512, 8, 64, device="cuda", dtype=torch.float16)
v = torch.randn(2, 512, 8, 64, device="cuda", dtype=torch.float16)

output = flash_attn_func(q, k, v, dropout_p=0.0, causal=True)
```

---

## Option 3: Enable in HuggingFace Transformers

```python
from transformers import AutoModelForCausalLM

# Automatic Flash Attention 2 (recommended)
model = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-3.1-8B-Instruct",
    attn_implementation="flash_attention_2",
    torch_dtype=torch.bfloat16,
    device_map="auto",
)

# Or: eager (standard), sdpa (PyTorch SDPA)
model = AutoModelForCausalLM.from_pretrained(
    "...",
    attn_implementation="sdpa",  # no install needed
)
```

---

## Hardware Requirements

| GPU | FP16 | BF16 | FP8 |
|-----|------|------|-----|
| A100 | ✅ | ✅ | ❌ |
| H100 | ✅ | ✅ | ✅ |
| A10/A30 | ✅ | ✅ | ❌ |
| RTX 3090/4090 | ✅ | ✅ | ❌ |
| V100 | ✅ | ❌ | ❌ |
| T4 | ✅ | ❌ | ❌ |

Requirements:
- CUDA 11.6+
- PyTorch 2.0+
- Ampere GPU or newer (RTX 30 series, A100, H100) for best performance

---

## Sliding Window Attention (Long Context)

```python
from flash_attn.flash_attn_interface import flash_attn_varlen_func

# For sequences longer than GPU memory allows
# Use sliding window to limit attention span
output = flash_attn_func(
    q, k, v,
    causal=True,
    window_size=(512, 0)  # attend to last 512 tokens only
)
```

---

## Memory Savings

Standard attention: O(N²) memory
Flash Attention: O(N) memory (recomputes on backward pass)

```
Sequence length 4096:  ~6x memory savings
Sequence length 8192:  ~15x memory savings
Sequence length 32768: ~50x+ memory savings
```

---

## Benchmarking

```python
import time, torch

def bench(fn, warmup=3, reps=10):
    for _ in range(warmup):
        fn()
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(reps):
        fn()
    torch.cuda.synchronize()
    return (time.time() - t0) / reps * 1000  # ms

q = torch.randn(4, 2048, 16, 64, device="cuda", dtype=torch.float16)
k, v = q.clone(), q.clone()

standard_ms = bench(lambda: F.scaled_dot_product_attention(q, k, v))
flash_ms = bench(lambda: flash_attn_func(q, k, v, causal=True))
print(f"Standard: {standard_ms:.1f}ms | Flash: {flash_ms:.1f}ms | Speedup: {standard_ms/flash_ms:.1f}x")
```

---

## Common Issues

**Build fails**: Ensure CUDA toolkit matches PyTorch CUDA version (`python -c "import torch; print(torch.version.cuda)"`)

**Wrong dtype**: Flash Attention requires FP16 or BF16, not FP32

**OOM despite Flash Attention**: Use gradient checkpointing additionally: `model.gradient_checkpointing_enable()`

**Not faster on short sequences**: Flash Attention shines at >512 tokens; below that overhead can dominate
