---
name: grpo-rl-training
description: Expert guidance for GRPO/RL fine-tuning with TRL for reasoning and task-specific model training.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [GRPO, RL-Training, Fine-tuning, TRL, Post-Training, Reasoning, Reward-Modeling, RLHF]
    related_skills: [huggingface-hub]
---

# GRPO/RL Training with TRL

Expert guidance for Group Relative Policy Optimization (GRPO) using the TRL library. Battle-tested patterns for fine-tuning language models with custom reward functions.

## When to Use

- Teaching a model to follow specific output formats (JSON, structured reasoning)
- Improving accuracy on math, coding, or reasoning tasks
- Custom task-specific behavior without labeled datasets
- Distilling reasoning capabilities from larger models

---

## Setup

```bash
pip install transformers>=4.47.0 trl>=0.14.0 datasets>=3.2.0 peft>=0.14.0 torch accelerate
```

Optional for logging:
```bash
pip install wandb
wandb login
```

---

## Minimal GRPO Example

```python
from trl import GRPOConfig, GRPOTrainer
from transformers import AutoModelForCausalLM, AutoTokenizer
from datasets import load_dataset

model_name = "Qwen/Qwen2.5-1.5B-Instruct"
model = AutoModelForCausalLM.from_pretrained(model_name)
tokenizer = AutoTokenizer.from_pretrained(model_name)

dataset = load_dataset("your/dataset")

# Define reward function
def reward_fn(prompts, completions, **kwargs):
    """
    Returns list of floats — one reward per completion.
    Higher = better. Typically in range [-1, 1] or [0, 1].
    """
    rewards = []
    for completion in completions:
        # Example: reward for correct format
        if completion.strip().startswith("<answer>"):
            rewards.append(1.0)
        else:
            rewards.append(-0.5)
    return rewards

config = GRPOConfig(
    output_dir="./grpo-output",
    learning_rate=5e-6,
    num_train_epochs=3,
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,
    num_generations=8,        # completions per prompt (G in GRPO)
    max_prompt_length=512,
    max_completion_length=256,
    kl_coef=0.1,              # KL penalty — start low, tune up if reward hacking
    logging_steps=10,
    save_steps=100,
    report_to="wandb",        # or "none"
)

trainer = GRPOTrainer(
    model=model,
    args=config,
    reward_funcs=reward_fn,
    train_dataset=dataset["train"],
    tokenizer=tokenizer,
)

trainer.train()
trainer.save_model("./grpo-final")
```

---

## Reward Function Patterns

### Format Reward
```python
import re

def format_reward(prompts, completions, **kwargs):
    pattern = r"<think>.*?</think>\s*<answer>.*?</answer>"
    return [1.0 if re.fullmatch(pattern, c, re.DOTALL) else -1.0 for c in completions]
```

### Accuracy Reward
```python
def accuracy_reward(prompts, completions, ground_truth, **kwargs):
    rewards = []
    for completion, gt in zip(completions, ground_truth):
        extracted = extract_answer(completion)
        rewards.append(1.0 if extracted == gt else 0.0)
    return rewards
```

### Length Penalty
```python
def length_penalty_reward(prompts, completions, **kwargs):
    return [max(0, 1.0 - len(c) / 2000) for c in completions]
```

### Combined Rewards
```python
reward_funcs = [format_reward, accuracy_reward]  # TRL averages them
```

---

## PEFT/LoRA Integration (Memory Efficient)

```python
from peft import LoraConfig, get_peft_model

lora_config = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "v_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
)

model = get_peft_model(model, lora_config)
model.print_trainable_parameters()
```

---

## Key Hyperparameters

| Param | Default | Effect |
|-------|---------|--------|
| `num_generations` | 8 | More = better gradient estimate, more memory |
| `kl_coef` | 0.1 | Higher = stays closer to reference model |
| `learning_rate` | 5e-6 | Lower than SFT — RL is unstable with high LR |
| `max_completion_length` | 256 | Controls max tokens generated |

---

## Common Pitfalls

**Reward Hacking**: Model finds shortcuts to maximize reward without actually improving.
→ Fix: Add KL penalty (`kl_coef`), diverse reward signals, human evaluation

**Mode Collapse**: All completions become similar.
→ Fix: Increase `num_generations`, add temperature, check reward diversity

**OOM**: Large models with many generations blow up memory.
→ Fix: Use LoRA, reduce `num_generations`, use `gradient_checkpointing=True`

**Reward too sparse**: Model rarely gets positive reward → no learning signal.
→ Fix: Start with easier examples, use shaped reward (partial credit)

---

## Monitoring with W&B

Key metrics to watch:
- `train/reward`: should increase over time
- `train/kl`: should stay bounded (spike = reward hacking)
- `train/policy_loss`: learning signal
- `train/entropy`: diversity of completions (drop = mode collapse)

---

## Checkpoint and Resume

```bash
# Resume from checkpoint
trainer = GRPOTrainer(..., resume_from_checkpoint="./grpo-output/checkpoint-500")
trainer.train(resume_from_checkpoint=True)
```
