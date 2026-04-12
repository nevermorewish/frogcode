---
name: mcporter
description: Convert any CLI tool or Python function into an MCP server using fastmcp. Zero-config tool injection into Claude Code.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [MCP, Tools, Development, fastmcp, Integration, Server]
    related_skills: [native-mcp]
---

# MCPorter — CLI to MCP Converter

Turn any Python function or CLI tool into an MCP server that Claude Code can call natively.

## Setup

```bash
pip install fastmcp
```

---

## Minimal Server

```python
# my_server.py
from fastmcp import FastMCP

mcp = FastMCP("my-tool")

@mcp.tool()
def hello(name: str) -> str:
    """Say hello to someone."""
    return f"Hello, {name}!"

if __name__ == "__main__":
    mcp.run()  # stdio transport (for Claude Code)
```

Register in `.mcp.json`:
```json
{
  "mcpServers": {
    "my-tool": {
      "command": "python",
      "args": ["my_server.py"]
    }
  }
}
```

Restart Claude Code → `hello` tool appears natively.

---

## Type Annotations Matter

Claude reads your type hints to understand the tool:

```python
@mcp.tool()
def search_files(
    query: str,
    directory: str = ".",
    max_results: int = 10,
    case_sensitive: bool = False,
) -> list[str]:
    """Search for files matching query in directory."""
    import subprocess
    flag = "" if case_sensitive else "-i"
    result = subprocess.run(
        ["grep", "-rl", flag, query, directory],
        capture_output=True, text=True
    )
    return result.stdout.strip().split("\n")[:max_results]
```

---

## Wrap a CLI Tool

```python
import subprocess
from fastmcp import FastMCP

mcp = FastMCP("git-helper")

@mcp.tool()
def git_log(n: int = 10, format: str = "oneline") -> str:
    """Show git commit history."""
    result = subprocess.run(
        ["git", "log", f"-{n}", f"--format={format}"],
        capture_output=True, text=True
    )
    return result.stdout

@mcp.tool()
def git_diff(staged: bool = False) -> str:
    """Show git diff."""
    args = ["git", "diff"]
    if staged:
        args.append("--staged")
    result = subprocess.run(args, capture_output=True, text=True)
    return result.stdout

if __name__ == "__main__":
    mcp.run()
```

---

## Async Tools

```python
import asyncio
import httpx
from fastmcp import FastMCP

mcp = FastMCP("web-fetcher")

@mcp.tool()
async def fetch_url(url: str, timeout: int = 10) -> str:
    """Fetch content from a URL."""
    async with httpx.AsyncClient() as client:
        response = await client.get(url, timeout=timeout)
        return response.text[:5000]  # first 5k chars

if __name__ == "__main__":
    mcp.run()
```

---

## Resources (Read-Only Data)

```python
@mcp.resource("config://settings")
def get_settings() -> str:
    """Return current settings."""
    import json, pathlib
    settings = pathlib.Path("settings.json").read_text()
    return settings

@mcp.resource("file://{path}")
def read_file(path: str) -> str:
    """Read a file by path."""
    return pathlib.Path(path).read_text()
```

---

## Prompts

```python
@mcp.prompt()
def code_review_prompt(code: str, language: str = "python") -> str:
    """Generate a code review prompt."""
    return f"Review this {language} code for bugs and improvements:\n\n```{language}\n{code}\n```"
```

---

## HTTP Transport (for non-CC clients)

```python
if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8080)
```

Then register as:
```json
{"mcpServers": {"my-tool": {"url": "http://localhost:8080/sse"}}}
```

---

## Error Handling

```python
@mcp.tool()
def risky_operation(value: str) -> str:
    """Do something that might fail."""
    if not value:
        raise ValueError("value cannot be empty")  # MCP returns error to Claude
    return process(value)
```

---

## Test Interactively

```bash
fastmcp dev my_server.py
# Opens interactive MCP inspector in browser
```

---

## With Environment Variables

```json
{
  "mcpServers": {
    "my-api": {
      "command": "python",
      "args": ["api_server.py"],
      "env": {
        "API_KEY": "your-secret-key",
        "BASE_URL": "https://api.example.com"
      }
    }
  }
}
```
