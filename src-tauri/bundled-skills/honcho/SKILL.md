---
name: honcho
description: AI-native cross-session user modeling — builds a persistent, growing model of who you are, your expertise, preferences, and working style across all Claude sessions.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [User-Modeling, Memory, Cross-Session, Personalization, Honcho, Dialectic]
    related_skills: [hermes-memory, hermes-persona]
    homepage: https://docs.honcho.dev
---

# Honcho — Cross-Session User Modeling

"The agent that grows with you." Honcho builds a persistent model of who you are across every session — your expertise, communication style, recurring topics, and working preferences.

## Philosophy

Unlike simple memory (saving facts), Honcho models the **user as a person** — updating its understanding through **dialectic reasoning**: observing patterns, forming hypotheses about your preferences, and refining them over time.

This is the core of what makes Hermes Agent feel like it "knows" you.

---

## hermes-CCC Implementation

In hermes-CCC, Honcho runs as a structured user profile in the memory system. Full Honcho (honcho.dev) adds a cloud backend with dialectic reasoning.

### User Profile Structure

Profile stored at: `~/.claude/projects/*/memory/user_honcho_profile.md`

```markdown
---
name: honcho-user-profile
type: user
description: Cross-session user model built by Honcho
updated: 2026-04-07
---

## Identity
- Name: [inferred or stated]
- Role: [developer / researcher / executive / etc.]
- Timezone: [UTC+9 / Korea]
- Primary language: [Korean/English]

## Expertise
- Deep expertise: [Python, AI/ML, ontology design, business strategy]
- Intermediate: [Next.js, Neo4j, blockchain]
- Learning: [Rust, Solana]

## Communication Style
- Preferred verbosity: terse (skip explanations I know)
- Output format: code-first, then explanation
- Language mix: Korean for strategy, English for code
- Tone: direct, no fluff

## Working Patterns
- Session length: typically 2-4 hours
- Recurring projects: [OpenCrab SaaS, hermes-CCC, Ontology workspace]
- Tools always in use: [Claude Code, Discord, Obsidian, Neo4j, LM Studio]
- Peak hours: [evening KST]

## Recurring Interests
- Multi-agent systems and orchestration
- Knowledge graphs / ontology
- AI infrastructure (vLLM, GRPO training)
- SaaS monetization strategy

## Preferences
- Never explain basics I already know
- Always show full code, not snippets
- When blocked, say so immediately
- Prioritize speed over perfection on first pass
- Delegate heavy builds to Codex

## Session History Patterns
- Often starts: checking project status
- Common requests: code generation, architecture review, Discord automation
- Frequently uses: /hermes-route, /hermes-memory, codex:rescue
```

---

## Commands

### `/honcho profile`
Display the current user model. Claude reads the profile and summarizes key facts about how it understands you.

### `/honcho update`
After a session, analyze what was discussed and update the profile:
1. New expertise demonstrated?
2. New tools or projects mentioned?
3. Communication preferences revealed?
4. New recurring topics?

Then write updates to `user_honcho_profile.md`.

### `/honcho calibrate`
Run a quick 5-question calibration:
1. What's your primary role?
2. What are your strongest technical areas?
3. How do you prefer explanations? (terse/detailed)
4. What projects are you currently working on?
5. Any specific preferences for how I should behave?

### `/honcho reset`
Clear the user model and start fresh.

### `/honcho export`
Export profile as JSON for backup or transfer.

---

## How Claude Uses the Profile

When Honcho profile is loaded, Claude should:
- **Skip** explanations of tools/concepts the user knows deeply
- **Use** preferred verbosity level in all responses
- **Reference** current projects when suggesting approaches
- **Adapt** language mix (Korean/English as preferred)
- **Assume** expertise level from profile when writing code
- **Prioritize** working patterns (e.g., "delegate to Codex")

---

## Full Honcho Integration (Optional)

For cloud-backed dialectic reasoning:

```bash
pip install honcho-ai
```

```python
from honcho import Honcho

honcho = Honcho(app_id="your-app-id", api_key="your-api-key")

# Create/get user session
user = honcho.apps.users.get_or_create(app_id="hermes-ccc", name="alexlee")
session = honcho.apps.users.sessions.create(app_id="hermes-ccc", user_id=user.id)

# Add observation
honcho.apps.users.sessions.messages.create(
    app_id="hermes-ccc",
    user_id=user.id,
    session_id=session.id,
    is_user=True,
    content="User prefers terse responses with code-first approach"
)

# Dialectic inference — Honcho reasons about the user
response = honcho.apps.users.sessions.chat(
    app_id="hermes-ccc",
    user_id=user.id,
    session_id=session.id,
    query="What communication style does this user prefer?"
)
print(response.content)
```

See [docs.honcho.dev](https://docs.honcho.dev) for full API reference.
