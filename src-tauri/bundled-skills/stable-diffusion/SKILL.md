---
name: stable-diffusion
description: Run Stable Diffusion locally with diffusers — text-to-image, img2img, inpainting, ControlNet, and SDXL.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [MLOps, Stable-Diffusion, Image-Generation, Diffusers, Text-to-Image]
    related_skills: []
---

# Stable Diffusion

## Purpose

- Use this skill to generate or edit images locally with Hugging Face `diffusers`.
- Prefer it for text-to-image, img2img, inpainting, and model composition workflows.
- This skill covers both classic Stable Diffusion models and SDXL.
- It is useful for scripted generation, reproducible experiments, and GPU-backed image pipelines.

## Install

```bash
pip install diffusers transformers accelerate torch
```

- You typically also need a compatible CUDA-enabled PyTorch build for GPU inference.
- Confirm the install in Python before pulling large checkpoints.

## Core Libraries

- `diffusers` for pipeline abstractions
- `transformers` for text encoders and related model components
- `accelerate` for efficient device loading and memory movement
- `torch` for runtime execution

## Text-to-Image With SD 1.5

- Classic Stable Diffusion 1.5 uses `StableDiffusionPipeline`.

```python
import torch
from diffusers import StableDiffusionPipeline

pipe = StableDiffusionPipeline.from_pretrained(
    "runwayml/stable-diffusion-v1-5",
    torch_dtype=torch.float16,
)
pipe = pipe.to("cuda")

image = pipe(
    prompt="a cinematic photo of a mountain observatory at sunrise",
    negative_prompt="blurry, low quality, distorted",
    num_inference_steps=30,
    guidance_scale=7.5,
).images[0]

image.save("output.png")
```

## SDXL

- SDXL typically uses `StableDiffusionXLPipeline`.

```python
import torch
from diffusers import StableDiffusionXLPipeline

pipe = StableDiffusionXLPipeline.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0",
    torch_dtype=torch.float16,
)
pipe = pipe.to("cuda")

image = pipe(
    prompt="a highly detailed editorial photo of a futuristic library interior",
    negative_prompt="low resolution, deformed, extra limbs",
    num_inference_steps=35,
    guidance_scale=6.5,
).images[0]

image.save("sdxl-output.png")
```

- SDXL generally produces stronger prompt fidelity and image quality than SD 1.5, but it also requires more VRAM.

## Key Parameters

- `prompt`: the main text instruction
- `negative_prompt`: what to suppress
- `num_inference_steps`: denoising step count
- `guidance_scale`: classifier-free guidance strength
- `seed`: random seed for reproducibility

## Seeded Generation

- Use a seed when you need repeatable outputs:

```python
import torch
from diffusers import StableDiffusionPipeline

pipe = StableDiffusionPipeline.from_pretrained(
    "runwayml/stable-diffusion-v1-5",
    torch_dtype=torch.float16,
).to("cuda")

generator = torch.Generator(device="cuda").manual_seed(42)

image = pipe(
    prompt="a clean product photo of a ceramic mug on a wood table",
    negative_prompt="blurry, noisy, warped",
    num_inference_steps=28,
    guidance_scale=7.0,
    generator=generator,
).images[0]

image.save("seeded-output.png")
```

- The same seed and settings help with debugging prompt and LoRA changes.

## Save Output

- Save the generated image with PIL:

```python
image.save("output.png")
```

- Always save prompt metadata separately if you need auditability or experiment tracking.

## Img2Img

- Use `StableDiffusionImg2ImgPipeline` to transform an existing image while preserving composition.

```python
import torch
from diffusers import StableDiffusionImg2ImgPipeline
from PIL import Image

pipe = StableDiffusionImg2ImgPipeline.from_pretrained(
    "runwayml/stable-diffusion-v1-5",
    torch_dtype=torch.float16,
).to("cuda")

init_image = Image.open("input.png").convert("RGB").resize((768, 768))

image = pipe(
    prompt="turn this concept sketch into a polished sci-fi matte painting",
    negative_prompt="blurry, low contrast, artifacts",
    image=init_image,
    strength=0.65,
    num_inference_steps=30,
    guidance_scale=7.5,
).images[0]

image.save("img2img-output.png")
```

- Lower `strength` preserves more of the input image.
- Higher `strength` pushes the result further away from the source.

## Inpainting

- Use `StableDiffusionInpaintPipeline` to replace or repair masked regions.

```python
import torch
from diffusers import StableDiffusionInpaintPipeline
from PIL import Image

pipe = StableDiffusionInpaintPipeline.from_pretrained(
    "runwayml/stable-diffusion-inpainting",
    torch_dtype=torch.float16,
).to("cuda")

image = Image.open("scene.png").convert("RGB").resize((512, 512))
mask = Image.open("mask.png").convert("RGB").resize((512, 512))

result = pipe(
    prompt="replace the missing area with a wooden chair",
    negative_prompt="blurry, malformed, duplicate objects",
    image=image,
    mask_image=mask,
    num_inference_steps=30,
    guidance_scale=7.5,
).images[0]

result.save("inpaint-output.png")
```

- White mask regions are typically where edits are applied.
- Good masks matter as much as prompts for reliable inpainting.

## ControlNet

- ControlNet is useful when you want stronger control over pose, depth, edges, or composition.
- Typical uses include pose-guided character generation, depth-aware edits, and line-art conditioning.
- Pair ControlNet with SD 1.5 or SDXL depending on the model combination you are using.

## Memory Optimization

- Reduce memory pressure with built-in helpers:

```python
pipe.enable_model_cpu_offload()
pipe.enable_attention_slicing()
```

- `pipe.enable_model_cpu_offload()` is often helpful on constrained GPUs.
- `pipe.enable_attention_slicing()` can reduce peak memory at some performance cost.
- These settings are practical for laptops and single-GPU consumer machines.

## LoRA Loading

- Load LoRA adapters to specialize style, subject, or composition behavior:

```python
pipe.load_lora_weights("./lora.safetensors")
```

- Keep the base model and LoRA pairing compatible.
- Track LoRA names, weights, and prompts in experiment logs.

## Negative Prompts

- Common negative prompts include:
- `blurry`
- `low quality`
- `worst quality`
- `deformed`
- `extra limbs`
- `bad anatomy`
- `artifact`
- `text`
- `watermark`

- Use concise negative prompts first.
- Overly long negative prompts can produce unstable or muddled outputs.

## Prompting Guidance

- Be concrete about subject, style, lighting, framing, and medium.
- Use short prompt iterations during tuning rather than changing many variables at once.
- Record prompt, negative prompt, seed, and model version together.

## SDXL vs SD 1.5

- Use SDXL when:
- prompt fidelity matters
- you need stronger detail and composition
- you have enough VRAM

- Use SD 1.5 when:
- you need a lighter model
- you rely on mature community tooling
- you need broad LoRA and ControlNet ecosystem support

## Common Workflows

- Text-to-image concept generation
- Product mockups and ideation
- Img2img refinement from sketches
- Inpainting object replacement
- Style transfer through LoRAs

## ComfyUI Alternative

- `diffusers` is strong for code-driven workflows.
- ComfyUI is a strong GUI alternative when you want node-based visual workflows.
- Use ComfyUI for rapid experimentation, complex graph composition, or collaborative prompt workflows.

## Practical GPU Guidance

- SD 1.5 is easier on smaller GPUs.
- SDXL generally needs more VRAM and benefits from `float16`.
- CPU generation is possible, but it is much slower and rarely ideal for interactive use.

## Common Failure Modes

- Out-of-memory:
- enable CPU offload
- enable attention slicing
- reduce image size
- use SD 1.5 instead of SDXL

- Muddy or low-quality images:
- increase `num_inference_steps`
- refine the prompt
- simplify the negative prompt
- verify you are using the intended model

- Unreliable edits in img2img:
- lower or raise `strength` depending on whether the source is being ignored or over-preserved
- use clearer prompts
- start from a cleaner input image

- Inpainting artifacts:
- improve the mask
- widen the masked area slightly
- use a prompt that matches the surrounding scene

## Recommended Workflow

- Start with a baseline text-to-image run.
- Lock a seed when comparing prompt or LoRA changes.
- Move to img2img or inpainting only after the base model behavior looks correct.
- Add memory optimizations before assuming you need larger hardware.

## When To Use This Skill

- You need local image generation from Python.
- You want reproducible scripted generation for experiments or pipelines.
- You need SDXL, img2img, inpainting, or LoRA-based customization.
- You prefer code-first workflows over GUI-only tools.

## Quick Reference

- Install: `pip install diffusers transformers accelerate torch`
- SDXL pipeline: `StableDiffusionXLPipeline.from_pretrained("stabilityai/stable-diffusion-xl-base-1.0")`
- SD 1.5 pipeline: `StableDiffusionPipeline`
- Save image: `image.save("output.png")`
- Img2img: `StableDiffusionImg2ImgPipeline`
- Inpainting: `StableDiffusionInpaintPipeline`
- Memory helpers: `pipe.enable_model_cpu_offload()` and `pipe.enable_attention_slicing()`
- LoRA: `pipe.load_lora_weights("./lora.safetensors")`
