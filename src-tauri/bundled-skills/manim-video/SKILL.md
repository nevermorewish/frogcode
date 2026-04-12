---
name: manim-video
description: Create mathematical animations and explainer videos with Manim Community - code-driven animations for math, CS concepts, data visualization.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Creative, Manim, Animation, Video, Mathematics, Visualization]
    related_skills: []
---

# Manim Video

## Purpose

- Use this skill to create precise, code-driven animations for mathematics, computer science, algorithms, and data visualization.
- Prefer Manim when the content is structural, symbolic, or instructional rather than cinematic live-action editing.
- Manim is especially strong for equations, graphs, geometric constructions, and animated explanations of abstract systems.

## Install

```bash
pip install manim
```

- On some systems you may also need FFmpeg and LaTeX-related dependencies for full math rendering support.
- Verify the installation with `manim --version`.

## Mental Model

- A Manim scene is a Python class.
- You place visual objects into the scene.
- You animate transitions between states.
- The render command converts the scene into a video file.
- The code is the asset, which makes revisions reproducible.

## Minimal Scene Structure

```python
from manim import *

class MyScene(Scene):
    def construct(self):
        text = Text("Hello, Manim")
        self.play(Write(text))
        self.wait()
```

## Basic Workflow

1. Create a Python file such as `scene.py`.
2. Define one or more scene classes.
3. Render the desired scene by name.
4. Inspect the output video.
5. Revise the code and rerender.

## Render Command

```bash
manim -pql scene.py MyScene
```

- `-pql` means preview plus quality low.
- Use `-pqh` when you want a higher-quality render for export or sharing.
- Low-quality previews are much faster during iteration.

## Core Objects

- `Circle`
- `Square`
- `Text`
- `MathTex`
- `Axes`
- `NumberPlane`
- `Arrow`

These cover a large fraction of introductory math and CS explainer work.

## Shapes Example

```python
from manim import *

class Shapes(Scene):
    def construct(self):
        circle = Circle(color=BLUE)
        square = Square(color=GREEN).shift(RIGHT * 2)
        arrow = Arrow(circle.get_right(), square.get_left(), color=YELLOW)

        self.play(Create(circle), Create(square))
        self.play(Create(arrow))
        self.wait()
```

## Text and Labels

- Use `Text` for plain words, labels, titles, and UI-like annotations.
- Use `MathTex` for equations and symbolic math.
- Keep labels short and readable.
- Position text relative to objects with helpers like `.next_to()` and `.to_edge()`.

## Math Rendering

```python
from manim import *

class Derivative(Scene):
    def construct(self):
        expr = MathTex(r"\frac{d}{dx} x^2 = 2x")
        self.play(Write(expr))
        self.wait()
```

- Use raw strings for LaTeX-heavy expressions.
- Split long formulas into chunks if you want to animate parts independently.
- `MathTex` is one of Manim's highest-value primitives for educational video.

## Graphs

```python
from manim import *

class PlotExample(Scene):
    def construct(self):
        ax = Axes()
        graph = ax.plot(lambda x: x**2, color=BLUE)
        label = ax.get_graph_label(graph, label="x^2")

        self.play(Create(ax))
        self.play(Create(graph), FadeIn(label))
        self.wait()
```

- Use `Axes()` for standard 2D coordinate systems.
- Use `NumberPlane()` when you want a visible grid.
- Use `.plot()` for function graphs.
- Add labels only when they clarify the message.

## Coordinate Grid Example

```python
from manim import *

class PlaneExample(Scene):
    def construct(self):
        plane = NumberPlane()
        point = Dot(plane.c2p(2, 3), color=RED)
        note = Text("Point (2, 3)").scale(0.5).next_to(point, UP)

        self.play(Create(plane))
        self.play(FadeIn(point), Write(note))
        self.wait()
```

## Common Animations

- `Create`
- `Write`
- `Transform`
- `FadeIn`
- `FadeOut`
- `MoveAlongPath`

These are enough to build most educational sequences.

## Animation Example

```python
from manim import *

class AnimateBasics(Scene):
    def construct(self):
        circle = Circle(color=BLUE)
        square = Square(color=GREEN)

        self.play(Create(circle))
        self.play(Transform(circle, square))
        self.play(FadeOut(circle))
```

## Move Along Path

```python
from manim import *

class AlongPath(Scene):
    def construct(self):
        path = Circle(radius=2, color=WHITE)
        dot = Dot(color=YELLOW).move_to(path.point_from_proportion(0))

        self.add(path, dot)
        self.play(MoveAlongPath(dot, path), run_time=3)
        self.wait()
```

- `MoveAlongPath` is useful for state machines, orbital motion, and process flow visuals.
- Use it for conceptual journeys, packets moving through systems, or points moving across graphs.

## Layout Helpers

- `.shift()`
- `.move_to()`
- `.next_to()`
- `.align_to()`
- `.to_edge()`
- `.to_corner()`
- `VGroup(...)` for grouping and arrangement

Good layout discipline saves time during revision.

## Colors

- `RED`
- `BLUE`
- `GREEN`
- `YELLOW`
- `WHITE`
- `ORANGE`
- `PURPLE`
- `TEAL`

Use consistent semantic coloring across the scene.

## Color Strategy

- Use one color for inputs, another for transformations, and another for outputs.
- Keep background contrast in mind.
- Avoid using too many unrelated colors in the same explanation.
- Use `WHITE` or light tones for neutral reference geometry.

## Camera Control

```python
from manim import *

class CameraExample(Scene):
    def construct(self):
        plane = NumberPlane()
        self.add(plane)
        self.play(self.camera.frame.animate.scale(0.5))
        self.wait()
```

- Camera animation helps when zooming into local detail.
- Use it sparingly so viewers do not lose context.
- Zooming is most useful for dense graphs, local geometry, or multi-part explanations.

## Output

- Manim writes rendered video outputs under `media/videos/`.
- Preview renders and partial intermediates also appear under the `media/` tree.
- Treat the Python source as canonical and the rendered MP4 as generated output.
- Final videos are typically MP4 files.

## Timing

- Use `self.wait()` to hold the frame.
- Adjust `run_time=` on animation calls to tune pacing.
- Move slower for conceptual reveals and faster for purely decorative transitions.
- Educational clarity depends on timing as much as layout.

## Narration-Oriented Design

- Write scenes as if a narrator is speaking over them.
- Introduce one concept at a time.
- Avoid changing too many objects in the same beat.
- Keep equations readable on screen long enough to be processed.
- Use transforms to show continuity rather than replacing everything at once.

## Reusable Pattern for Explainers

1. Title the concept.
2. Show the initial objects.
3. Animate the transformation or derivation.
4. Highlight the result.
5. Pause.

This pattern works for algorithms, math derivations, and data stories.

## Computer Science Use Cases

- Sorting algorithm visualizations
- Graph traversal animations
- Finite-state machines
- Distributed systems message flow
- Complexity intuition with plotted growth curves
- Data structure operations such as stack and queue updates

## Data Visualization Use Cases

- Plot a function or data series
- Animate parameter changes
- Show area under a curve
- Reveal axes, labels, and legend in stages
- Compare two functions through `Transform`

## Three-Dimensional Scenes

```python
from manim import *

class My3DScene(ThreeDScene):
    def construct(self):
        axes = ThreeDAxes()
        sphere = Sphere(radius=1, color=BLUE)
        self.set_camera_orientation(phi=75 * DEGREES, theta=30 * DEGREES)
        self.play(Create(axes), FadeIn(sphere))
        self.begin_ambient_camera_rotation(rate=0.2)
        self.wait(3)
```

- Use `ThreeDScene` for surfaces, vectors, and spatial intuition.
- Keep 3D scenes simple unless the extra dimension is genuinely explanatory.
- Camera motion in 3D should support understanding, not distract from it.

## Debugging Tips

- Start with `-pql` for fast feedback.
- Build the scene incrementally.
- Comment out complex sections while debugging layout.
- If math fails to render, verify the TeX environment and formula syntax.
- Use small prototype scenes before composing a long final animation.

## Production Guidance

- Keep one concept per scene unless continuity demands otherwise.
- Name classes clearly so render commands stay obvious.
- Break long videos into scene modules and concatenate later if needed.
- Use higher quality only after content and timing are stable.

## Summary

- Install with `pip install manim`.
- Build scenes with `class MyScene(Scene): def construct(self):`.
- Use objects like `Circle`, `Square`, `Text`, `MathTex`, `Axes`, `NumberPlane`, and `Arrow`.
- Animate with `Create`, `Write`, `Transform`, `FadeIn`, `FadeOut`, and `MoveAlongPath`.
- Render with `manim -pql scene.py MyScene` and switch to `-pqh` for higher quality.
- Use `MathTex(r"\\frac{d}{dx} x^2 = 2x")` for math and `Axes().plot(...)` for graphs.
- Use `self.camera.frame.animate.scale(0.5)` when zooming improves comprehension.
- Expect MP4 output under `media/videos/`.
