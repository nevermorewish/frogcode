---
name: research-paper-writing
description: Academic paper writing workflow — literature review, LaTeX setup, structure, citations, and conference submissions.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Research, Academic, Writing, LaTeX, Papers, Citations, Conference]
    related_skills: [arxiv]
---

# Research Paper Writing

End-to-end workflow for writing and submitting academic papers.

---

## Paper Structure

```
1. Title & Authors
2. Abstract         ← write last, 150-250 words
3. Introduction     ← problem, gap, contributions, roadmap
4. Related Work     ← what exists, why insufficient
5. Methodology      ← your approach, architecture, algorithm
6. Experiments      ← setup, baselines, metrics
7. Results          ← tables, figures, analysis
8. Discussion       ← limitations, broader impact
9. Conclusion       ← summary, future work
10. References
Appendix (optional)
```

---

## Abstract Formula

```
[PROBLEM] Prior work has struggled with X.
[GAP] Existing approaches fail because Y.
[SOLUTION] We propose Z, which does A and B.
[RESULTS] On benchmark C, we achieve D% improvement.
[IMPACT] This enables E.
```

---

## LaTeX Setup

```bash
# Ubuntu/Debian
sudo apt install texlive-full

# macOS
brew install --cask mactex

# Windows
# Install MiKTeX from miktex.org

# Verify
pdflatex --version
bibtex --version
```

### Compile

```bash
pdflatex paper.tex
bibtex paper
pdflatex paper.tex
pdflatex paper.tex   # run 3x for refs to resolve

# Or with latexmk (auto-detects what to run)
latexmk -pdf paper.tex
latexmk -pdf -pvc paper.tex  # continuous preview
```

---

## Minimal LaTeX Paper

```latex
\documentclass{article}
\usepackage{amsmath, amssymb, graphicx, booktabs, hyperref}
\usepackage[margin=1in]{geometry}
\usepackage[numbers]{natbib}

\title{Your Paper Title}
\author{Author One \and Author Two}
\date{}

\begin{document}
\maketitle

\begin{abstract}
Your abstract here.
\end{abstract}

\section{Introduction}
\label{sec:intro}

\section{Related Work}
Prior work \citep{vaswani2017attention} showed...

\section{Method}
\label{sec:method}

\section{Experiments}

\begin{table}[t]
\centering
\caption{Main results}
\begin{tabular}{lcc}
\toprule
Method & Metric A & Metric B \\
\midrule
Baseline & 70.1 & 65.3 \\
Ours & \textbf{74.8} & \textbf{70.2} \\
\bottomrule
\end{tabular}
\end{table}

\section{Conclusion}

\bibliography{references}
\bibliographystyle{plainnat}
\end{document}
```

---

## References (.bib file)

```bibtex
@article{vaswani2017attention,
  title={Attention is all you need},
  author={Vaswani, Ashish and others},
  journal={NeurIPS},
  year={2017}
}

@inproceedings{devlin2019bert,
  title={{BERT}: Pre-training of deep bidirectional transformers},
  author={Devlin, Jacob and others},
  booktitle={NAACL},
  year={2019}
}
```

Get BibTeX from:
- Google Scholar → Cite → BibTeX
- arXiv → Export BibTeX (bottom of abstract page)
- Semantic Scholar

---

## Literature Review via arXiv

```bash
# Use /arxiv skill to find papers
# Example searches:
# /arxiv search "GRPO reinforcement learning language model"
# /arxiv search "retrieval augmented generation survey"
# /arxiv get 2401.00001
```

---

## Figures

```python
import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots(figsize=(4, 3))
x = np.linspace(0, 10, 100)
ax.plot(x, np.sin(x), label="Our Method")
ax.plot(x, np.cos(x), "--", label="Baseline")
ax.set_xlabel("Epoch")
ax.set_ylabel("Accuracy")
ax.legend()
ax.grid(alpha=0.3)
plt.tight_layout()
plt.savefig("figure1.pdf", bbox_inches="tight", dpi=300)
```

Include in LaTeX:
```latex
\begin{figure}[t]
\centering
\includegraphics[width=0.8\linewidth]{figure1.pdf}
\caption{Comparison of our method vs baseline.}
\label{fig:main}
\end{figure}
```

---

## Conference Templates

| Conference | Deadline | Template |
|-----------|---------|---------|
| NeurIPS | May | neurips.cc |
| ICLR | Oct | iclr.cc |
| ICML | Jan | icml.cc |
| ACL | Feb | acl-org.github.io |
| AAAI | Aug | aaai.org |

Download official template from the conference website — never use unofficial ones.

---

## Overleaf (Collaborative)

1. Upload all `.tex`, `.bib`, `.pdf` files to Overleaf
2. Share link with co-authors
3. Enable Track Changes for reviews
4. Download final PDF when ready

---

## Common Mistakes

- **Vague claims**: "significantly better" → give exact numbers
- **Missing baselines**: always compare against SOTA
- **No ablation**: show which parts of your method matter
- **Figure too small**: aim for readable at 100% zoom
- **Passive voice overuse**: "we propose" not "it is proposed"
- **Missing limitations**: reviewers will point them out; address proactively
