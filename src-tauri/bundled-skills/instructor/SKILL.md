---
name: instructor
description: Structured LLM outputs with Instructor — Pydantic models as response schemas for OpenAI, Anthropic, and any OpenAI-compatible API.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [MLOps, Instructor, Structured-Output, Pydantic, LLM, Extraction]
    related_skills: [vllm]
---

# Instructor — Structured LLM Outputs

Get type-safe, validated Pydantic objects from any LLM instead of raw strings.

## Setup

```bash
pip install instructor pydantic
pip install anthropic  # or openai
```

---

## Basic Usage (Anthropic)

```python
import anthropic
import instructor
from pydantic import BaseModel

client = instructor.from_anthropic(anthropic.Anthropic())

class UserProfile(BaseModel):
    name: str
    age: int
    skills: list[str]
    experience_years: int

profile = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{
        "role": "user",
        "content": "Extract: John is a 32-year-old Python developer with 8 years experience in ML and DevOps."
    }],
    response_model=UserProfile,
)

print(profile.name)          # "John"
print(profile.age)           # 32
print(profile.skills)        # ["Python", "ML", "DevOps"]
print(profile.experience_years)  # 8
```

---

## With OpenAI

```python
import openai
import instructor

client = instructor.from_openai(openai.OpenAI())

result = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "..."}],
    response_model=UserProfile,
)
```

---

## Nested Models

```python
from pydantic import BaseModel, Field
from typing import Optional

class Address(BaseModel):
    street: str
    city: str
    country: str

class Company(BaseModel):
    name: str
    industry: str
    founded_year: int
    headquarters: Address
    employee_count: Optional[int] = None

class ResearchPaper(BaseModel):
    title: str
    authors: list[str]
    abstract: str
    key_findings: list[str] = Field(description="3-5 bullet points")
    methodology: str
    year: int
```

---

## Validation with Pydantic

```python
from pydantic import BaseModel, field_validator, Field

class SentimentAnalysis(BaseModel):
    sentiment: str = Field(description="positive, negative, or neutral")
    confidence: float = Field(ge=0, le=1)
    reasoning: str

    @field_validator("sentiment")
    def validate_sentiment(cls, v):
        if v not in ["positive", "negative", "neutral"]:
            raise ValueError("Must be positive, negative, or neutral")
        return v
```

---

## Streaming Partial Objects

```python
from instructor import Partial

for partial_profile in client.messages.stream(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "..."}],
    response_model=Partial[UserProfile],
):
    print(partial_profile)  # updates as tokens arrive
```

---

## Batch Extraction

```python
from typing import Iterable

class Contact(BaseModel):
    name: str
    email: str
    phone: Optional[str]

# Extract multiple contacts from one text
class ContactList(BaseModel):
    contacts: list[Contact]

text = """
Alice: alice@example.com, 555-1234
Bob: bob@example.com
Carol: carol@example.com, 555-5678
"""

result = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=512,
    messages=[{"role": "user", "content": f"Extract contacts:\n{text}"}],
    response_model=ContactList,
)

for contact in result.contacts:
    print(contact.name, contact.email)
```

---

## With vLLM / Local Models

```python
client = instructor.from_openai(
    openai.OpenAI(
        base_url="http://localhost:8000/v1",
        api_key="not-needed"
    ),
    mode=instructor.Mode.JSON,
)
```

---

## Use Cases

- Entity extraction from documents
- Structured data from unstructured text
- Classification with confidence scores
- RAG with typed outputs
- Form filling automation
- API response parsing
