---
name: excalidraw
description: Create and export diagrams with Excalidraw - whiteboard-style sketches, flowcharts, architecture diagrams via MCP or CLI.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Creative, Excalidraw, Diagrams, Visualization, Whiteboard]
    related_skills: []
---

# Excalidraw

## Purpose

- Use this skill to create lightweight diagrams, sketches, and whiteboard-style visuals quickly.
- Prefer Excalidraw when the output should feel hand-drawn, fast to edit, and easy to embed into notes or design docs.
- This skill works well for architecture reviews, brainstorming, flowcharts, and teaching visuals.
- In this environment, Excalidraw MCP tooling is already available.

## Core Mental Model

- Describe the diagram you want in plain language.
- Claude can translate that description into an Excalidraw JSON scene specification.
- The scene can then be rendered in a view, exported, saved as a checkpoint, or shared through Excalidraw.
- Treat the JSON spec as the source of truth for reproducible diagram generation.

## MCP Integration

- Use `mcp__claude_ai_excalidraw__create_view` to generate or render a diagram view from a structured scene.
- Use `mcp__claude_ai_excalidraw__export_to_excalidraw` to export the scene into a format compatible with Excalidraw workflows.
- Use `save_checkpoint` to preserve an intermediate diagram state before large edits.
- Use `read_checkpoint` to reload a previously saved scene when you need to continue, branch, or recover.
- A good workflow is: describe -> generate JSON -> create view -> inspect -> checkpoint -> revise -> export.

## What To Ask For

- "Draw a system architecture diagram for a FastAPI app backed by Postgres and Redis."
- "Create a flowchart for user sign-up with email verification."
- "Sketch an ERD with users, teams, memberships, and permissions."
- "Make a sequence diagram for browser -> API -> worker -> database."
- "Turn this process into a whiteboard-style diagram with short labels and arrows."

## Describe First, Then Refine

- Start with the intent of the diagram, not low-level coordinates.
- Include the major entities, the relationships, and the desired reading direction.
- Mention whether you want a rough sketch, a cleaner box-and-arrow layout, or a board-like visual.
- If the first result is too dense, ask for fewer labels or more spacing.
- If the first result is too vague, specify grouping, order, and arrow directions.

## Scene Building Blocks

- `rectangle`: best for services, systems, containers, and grouped components.
- `ellipse`: useful for external actors, start/end states, or soft conceptual nodes.
- `arrow`: best for directional relationships, calls, control flow, and data movement.
- `line`: useful for visual separators, boundaries, or non-directional links.
- `text`: labels, notes, titles, annotations, and step numbers.
- `diamond`: decision points in a flowchart or branching logic.

## Common Diagram Types

### System Architecture

- Use rectangles for services, databases, queues, and external providers.
- Use arrows to show request flow, event flow, and data movement.
- Group related services into logical zones such as frontend, backend, storage, and third-party systems.
- Add short text notes for protocols like HTTP, gRPC, Kafka, or WebSocket.

### Flowchart

- Use rectangles for actions.
- Use diamonds for decisions.
- Use arrows for the main control path.
- Keep text short and action-oriented.
- Prefer top-to-bottom or left-to-right consistency.

### ERD

- Use rectangles to represent tables or entities.
- Put the entity name at the top and key fields below as text.
- Use arrows or simple connecting lines to show relationships.
- Label one-to-many or many-to-many edges with short text if needed.
- Keep column lists focused on primary keys, foreign keys, and the fields relevant to the explanation.

### Sequence Diagram

- Use text labels for actors across the top.
- Use vertical lines or repeated arrows to indicate message order.
- Use arrows with labels like `POST /login`, `enqueue job`, or `ACK`.
- Number key steps if the interaction is long.
- Keep parallel flows separated visually rather than forcing too many crossing arrows.

## Practical Prompt Patterns

- "Create a whiteboard-style architecture diagram with six boxes and directional arrows."
- "Make the frontend, API, and worker visually separated into columns."
- "Use a decision diamond after payment validation."
- "Add labels to arrows showing request type and payload."
- "Keep the style sketchy and informal, suitable for an engineering design note."

## Suggested JSON Planning

- Think in terms of elements, labels, and relationships.
- Define each node first.
- Define the connectors second.
- Add titles and notes last.
- Keep IDs stable if you expect to revise the same diagram repeatedly.

## Revision Workflow

- Generate the initial scene from a natural-language description.
- Render it with `mcp__claude_ai_excalidraw__create_view`.
- Inspect for overlap, unclear labels, and missing relationships.
- Save the working state with `save_checkpoint`.
- Make incremental changes rather than regenerating from scratch if the structure is already mostly right.
- If a revision goes sideways, recover the previous state using `read_checkpoint`.

## Checkpoints

- Use `save_checkpoint` before major layout changes.
- Use `save_checkpoint` before adding dozens of new elements.
- Use `read_checkpoint` when you need to compare alternative diagram versions.
- Use checkpoints to maintain a clean "baseline" for architecture documents.
- Checkpoints are especially useful for iterative design sessions with multiple stakeholders.

## Export Workflow

- Use `mcp__claude_ai_excalidraw__export_to_excalidraw` when you want a portable Excalidraw artifact.
- Export to Excalidraw format when the diagram should remain editable in the Excalidraw ecosystem.
- Export as PNG when you need a static image for reports, PRs, slides, or issue comments.
- Export as SVG when you need scalable vector output for documents or web embedding.
- Prefer SVG when crisp text and resizable diagrams matter.

## PNG vs SVG

- PNG is easy to paste into chat, docs, and presentations.
- PNG is better when consumers do not need to edit the figure.
- SVG is better for documentation sites, architecture handbooks, and print-quality scaling.
- SVG is easier to version in some documentation pipelines.
- If unsure, export both.

## Sharing

- Excalidraw scenes can be shared via `https://excalidraw.com/` workflows after export.
- This is useful when collaborators want to tweak the drawing manually in the browser.
- Excalidraw sharing is convenient for design reviews and async comments.
- Keep exported scene files with the related document so the diagram is reproducible.

## Style Guidance

- Keep node labels short.
- Avoid paragraphs inside shapes.
- Use whitespace aggressively to reduce overlap.
- Use consistent arrow direction when possible.
- Put titles outside the main node grid.
- Group annotations near the edge instead of in the center of the flow.

## Good Defaults

- System diagrams: left-to-right flow, clear zones, arrows labeled only when needed.
- Flowcharts: top-to-bottom, one decision per diamond, one short phrase per node.
- ERDs: entity name plus only important fields.
- Sequence diagrams: ordered messages with minimal crossings.
- Whiteboard sketches: rough but readable beats pixel-perfect precision.

## Example Requests

```text
Create a system architecture diagram for a RAG application with:
- Browser client
- FastAPI gateway
- Retrieval service
- Vector database
- Background worker
- External LLM API
Use rectangles for systems, arrows for data flow, and a handwritten whiteboard feel.
```

```text
Create a flowchart for password reset:
- User requests reset
- System validates account
- If invalid, show error
- If valid, send email
- User clicks token link
- System verifies token
- If token expired, restart flow
- If valid, allow password update
```

## When Excalidraw Fits Best

- Early-stage architecture thinking
- Fast diagrams during debugging
- Design docs that need quick visuals
- Workshop and brainstorming artifacts
- Teaching and onboarding materials

## When To Use Something Else

- Use Mermaid when you need diagram-as-code in Markdown-first pipelines.
- Use Graphviz when you need algorithmic layouts for large graphs.
- Use presentation tools when heavy branding matters more than editability.
- Use CAD or vector illustration tools when exact geometry matters.

## Operational Tips

- Keep diagram generation prompts close to the engineering language of the system.
- Name services exactly as they appear in the codebase when possible.
- Reuse checkpointed scenes for versioned architecture docs.
- Export to SVG for stable documentation output.
- Export to Excalidraw format when team members want browser editing.

## Summary

- Describe what you want as a diagram and Claude can generate the JSON spec.
- Render scenes with `mcp__claude_ai_excalidraw__create_view`.
- Export editable artifacts with `mcp__claude_ai_excalidraw__export_to_excalidraw`.
- Save progress with `save_checkpoint` and recover with `read_checkpoint`.
- Use Excalidraw for system architecture, flowcharts, ERDs, sequence diagrams, and sketch-style visuals.
