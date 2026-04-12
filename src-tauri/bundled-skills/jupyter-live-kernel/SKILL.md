---
name: jupyter-live-kernel
description: Jupyter notebook and kernel operations — start kernels, execute cells programmatically, export, and data analysis patterns.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Data-Science, Jupyter, Python, Analysis, Notebooks, Kernels]
    related_skills: [grpo-rl-training, huggingface-hub]
---

# Jupyter Live Kernel

Run notebooks, execute cells programmatically, and manage Jupyter kernels.

## Setup

```bash
pip install jupyter jupyterlab nbformat nbconvert ipykernel
python -m ipykernel install --user --name myenv --display-name "My Env"
```

---

## Start Jupyter

```bash
# JupyterLab (recommended)
jupyter lab --no-browser --port 8888

# Classic notebook
jupyter notebook --no-browser --port 8888

# Allow remote access (careful with security)
jupyter lab --ip 0.0.0.0 --no-browser

# Start with specific directory
jupyter lab /path/to/project
```

---

## Execute Notebooks Programmatically

```bash
# Execute and save output
jupyter nbconvert --to notebook --execute input.ipynb --output output.ipynb

# With timeout
jupyter nbconvert --to notebook --execute --ExecutePreprocessor.timeout=300 input.ipynb

# Export to HTML
jupyter nbconvert --to html notebook.ipynb

# Export to Python script
jupyter nbconvert --to script notebook.ipynb

# Export to PDF (requires LaTeX)
jupyter nbconvert --to pdf notebook.ipynb
```

---

## Create Notebooks with nbformat

```python
import nbformat

nb = nbformat.v4.new_notebook()

# Add markdown cell
nb.cells.append(nbformat.v4.new_markdown_cell("# My Analysis"))

# Add code cell
nb.cells.append(nbformat.v4.new_code_cell("""
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv('data.csv')
df.head()
"""))

# Save
with open("analysis.ipynb", "w") as f:
    nbformat.write(nb, f)
```

---

## Execute Cells Programmatically with nbclient

```python
import nbformat
from nbclient import NotebookClient

with open("analysis.ipynb") as f:
    nb = nbformat.read(f, as_version=4)

client = NotebookClient(nb, timeout=600, kernel_name="python3")
client.execute()

with open("analysis_output.ipynb", "w") as f:
    nbformat.write(nb, f)
```

---

## Papermill — Parameterized Notebooks

```bash
pip install papermill

# Run with parameters
papermill input.ipynb output.ipynb -p learning_rate 0.001 -p epochs 10

# Pass dict parameter
papermill input.ipynb output.ipynb -y "{'config': {'lr': 0.001}}"
```

Mark parameter cell with tag `parameters` in the notebook.

---

## Kernel Management

```bash
# List running kernels
jupyter kernel list

# List available kernel specs
jupyter kernelspec list

# Install a kernel from venv
source myenv/bin/activate
pip install ipykernel
python -m ipykernel install --user --name myenv

# Remove kernel
jupyter kernelspec remove myenv
```

---

## Magic Commands (in notebooks)

```python
# Time a single line
%timeit [i**2 for i in range(1000)]

# Time a cell
%%timeit
result = [i**2 for i in range(1000)]

# Run shell command
!pip install pandas
!ls -la

# Show matplotlib inline
%matplotlib inline

# Load external script
%load script.py

# Auto-reload modules
%load_ext autoreload
%autoreload 2

# Run bash cell
%%bash
echo "Hello from bash"
ls
```

---

## Common Data Analysis Pattern

```python
import pandas as pd
import matplotlib.pyplot as plt
import numpy as np

# Load data
df = pd.read_csv("data.csv")

# Quick overview
print(df.shape)
df.info()
df.describe()
df.isnull().sum()

# Plot
fig, axes = plt.subplots(1, 2, figsize=(12, 4))
df["column"].hist(ax=axes[0])
df.plot.scatter(x="col1", y="col2", ax=axes[1])
plt.tight_layout()
plt.savefig("plot.png", dpi=150)
plt.show()
```

---

## VS Code Integration

- Install "Jupyter" extension
- Open `.ipynb` files directly
- Select kernel from top-right dropdown
- Run cells with `Shift+Enter`
- Variables panel: View → Variables
