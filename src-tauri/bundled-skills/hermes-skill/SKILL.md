---
name: hermes-skill
description: Create, improve, inventory, and audit Claude Code skills. Use when turning a solved workflow into a reusable skill, expanding an existing skill, checking trigger quality, or standardizing a skill pack.
version: 0.1.0
author: OpenAI Codex
license: MIT
metadata:
  category: skilling
  ported_from: NousResearch Hermes Agent
  tags:
    - skills
    - reuse
    - authoring
    - maintenance
  tools:
    - filesystem
    - markdown
    - shell
  maturity: beta
---

# Hermes Skill

## Purpose

- Convert repeated workflows into reusable Claude Code skills.
- Keep skills operational rather than descriptive.
- Improve trigger quality so the right skill activates at the right time.
- Audit skill packs for overlap, drift, and incomplete instructions.
- Preserve working patterns after a successful task.

## Required Skill Anatomy

- one folder per skill
- one `SKILL.md` file per folder
- YAML frontmatter at the top
- Markdown instructions below the frontmatter
- commands, outputs, and failure handling in the body

## Frontmatter Schema For This Package

- `name`
- `description`
- `version`
- `author`
- `license`
- `metadata`

## Description Rules

- State what the skill does.
- State when to use it.
- Mention trigger contexts directly.
- Avoid vague phrasing such as "general helper".
- Include important boundaries when the skill is domain-specific.

## Naming Rules

- use lowercase letters, digits, and hyphens only
- keep names short and concrete
- prefer operational nouns or verb-noun pairs
- avoid project-specific private jargon unless the package is private
- do not rename a stable public skill casually

## Create Workflow

1. Identify a repeated workflow that was just solved.
2. Extract the reusable steps, not the chat narrative.
3. List the exact tools, commands, and files involved.
4. Identify preconditions and failure modes.
5. Write the frontmatter with strong trigger language.
6. Write the body as an operator playbook.
7. Include output contracts where consistency matters.
8. Include examples only when they sharpen execution.

## Improve Workflow

1. Read the full skill.
2. Ask what failed or felt ambiguous in actual usage.
3. Tighten the description if triggering was weak.
4. Add missing commands or environment assumptions.
5. Add decision rules where the old version left too much ambiguity.
6. Add failure handling if the skill assumed a happy path.
7. Remove stale instructions and dead commands.

## Audit Dimensions

- trigger clarity
- instruction quality
- command accuracy
- line-count sufficiency
- duplication with nearby skills
- presence of decision rules
- presence of output contracts
- presence of verification steps

## What Makes A Good Skill

- It reduces repeated thinking.
- It includes exact actions for non-obvious steps.
- It names the right tools and commands.
- It narrows ambiguity without overfitting one repo.
- It handles the common failure path.
- It is faster to use than rediscovering the workflow.

## What Makes A Bad Skill

- It repeats generic advice the base model already knows.
- It has weak frontmatter and never triggers.
- It explains philosophy but omits execution.
- It contains stale paths or commands.
- It is so narrow that it only matches one past task.
- It has no failure modes or verification guidance.

## Skill Extraction Questions

- What exact problem was solved?
- What sequence of actions worked?
- What tools or connectors were essential?
- What surprised us during execution?
- What constraints would another agent need to know up front?
- What output structure made the result useful?

## Standard Sections To Include

- purpose
- activation signals
- inputs
- preflight
- step-by-step procedure
- decision rules
- output contract
- failure modes
- examples
- checklist

## Inventory Workflow

1. List all skill folders.
2. Verify that each folder contains `SKILL.md`.
3. Read frontmatter fields.
4. Produce a compact table of name, description, and health.
5. Flag missing or malformed skills.

## Overlap Rules

- Two skills may overlap in domain but should differ in operating goal.
- Merge skills if their triggers, commands, and outputs are nearly identical.
- Keep separate skills if one is strategic and the other is procedural.
- Prefer smaller focused skills over one giant omnibus skill.

## Updating From Real Usage

- Capture friction immediately after using a skill.
- Update the skill while the failure mode is fresh.
- Preserve examples that encode real mistakes.
- Replace speculative guidance with validated instructions.

## Example Improvement Targets

- add missing prereq checks
- tighten "when to use" language
- replace obsolete CLI flags
- add a markdown response template
- split one overloaded skill into two

## Audit Output Template

```markdown
Skill audit report:
- systematic-debugging: Healthy - clear phases, explicit outputs, and verification loop
- old-review-skill: Outdated - stale GitHub CLI commands and no failure handling
- duplicate-debug-skill: Redundant - overlaps heavily with systematic-debugging
```

## Creation Output Template

```markdown
Created skill: my-new-skill
Path: ~/.claude/skills/my-new-skill/SKILL.md
Why it should trigger: handles repeated workflow for ...
Key sections: purpose, procedure, failure modes, output contract
```

## Decision Rules

- Create a new skill only when the workflow is truly repeatable.
- Improve an existing skill when the use case matches its current mission.
- Split a skill when one body now serves multiple unrelated triggers.
- Keep package-wide conventions consistent across all skills.

## Failure Modes

- encoding one conversation instead of the general workflow
- omitting commands because they felt obvious during the original task
- bloating a skill with reference material that belongs elsewhere
- letting frontmatter drift away from actual body content
- failing to update package docs after adding or removing skills

## Recovery Moves

- If the skill reads like a postmortem, rewrite it as instructions.
- If the skill is too abstract, add commands and examples.
- If the skill is too long but still coherent, split by purpose not by arbitrary size.
- If the trigger is too weak, rewrite the description before changing anything else.

## Good Triggers

- "turn this workflow into a skill"
- "improve this skill"
- "audit our skill pack"
- "list installed skills"
- "this keeps repeating, save it"

## Checklist

1. Confirm the workflow is reusable.
2. Choose the right skill name.
3. Write strong frontmatter.
4. Add exact commands and decision rules.
5. Add failure handling and verification.
6. Check for overlap with existing skills.
7. Update package docs if necessary.
8. Validate structure before shipping.
