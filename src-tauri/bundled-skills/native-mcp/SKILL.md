---
name: native-mcp
description: MCP server integration in Claude Code — add servers to .mcp.json, configure transports, and use their tools natively.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [MCP, Tools, Integrations, Configuration, Claude-Code]
    related_skills: [mcporter]
---

# Native MCP Integration

Connect MCP servers to Claude Code and use their tools as first-class native tools.

## How It Works

1. Add server config to `.mcp.json` in your project root
2. Restart Claude Code
3. The server's tools appear as native tools Claude can call directly

---

## .mcp.json Schema

```json
{
  "mcpServers": {
    "server-name": {
      "command": "python",
      "args": ["path/to/server.py"],
      "env": {
        "API_KEY": "secret"
      }
    }
  }
}
```

---

## Transport Types

### stdio (default — for local processes)
```json
{
  "mcpServers": {
    "my-server": {
      "command": "python",
      "args": ["server.py"]
    }
  }
}
```

### HTTP/SSE (for remote or HTTP servers)
```json
{
  "mcpServers": {
    "remote-server": {
      "url": "http://localhost:8080/sse"
    }
  }
}
```

---

## Common MCP Servers

### Filesystem
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

### Git
```json
{
  "mcpServers": {
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "."]
    }
  }
}
```

### GitHub
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."}
    }
  }
}
```

### Obsidian
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "mcp-obsidian"],
      "env": {"OBSIDIAN_VAULT_PATH": "/path/to/vault"}
    }
  }
}
```

### Playwright (Browser Automation)
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp"]
    }
  }
}
```

### Notion
```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/mcp"],
      "env": {"NOTION_API_KEY": "secret_..."}
    }
  }
}
```

### SQLite
```json
{
  "mcpServers": {
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "./data.db"]
    }
  }
}
```

---

## Prerequisites

### npx servers (Node.js)
```bash
node --version   # must be 18+
npm --version
```

### uvx servers (Python)
```bash
pip install uv
uvx --version
```

### Python servers
```bash
pip install fastmcp mcp
```

---

## After Adding a Server

1. Save `.mcp.json`
2. Restart Claude Code (or reload window in IDE extension)
3. Tools from the server now appear in Claude's tool list
4. Test: ask Claude to use one of the new tools

---

## Debugging

Check Claude Code MCP logs:
- Mac/Linux: `~/.claude/logs/`
- Windows: `%APPDATA%\Claude\logs\`

Common issues:
- `command not found`: install npx/uvx or use full path
- Auth errors: check `env` section for API keys
- Timeout: server took too long to start

---

## Security Best Practices

Never hardcode secrets in `.mcp.json` — use env vars from shell:
```json
{
  "mcpServers": {
    "my-api": {
      "command": "python",
      "args": ["server.py"],
      "env": {
        "API_KEY": "${MY_API_KEY}"
      }
    }
  }
}
```

Or set in `.env` and load via direnv / shell profile.

---

## Multiple Servers

```json
{
  "mcpServers": {
    "filesystem": {...},
    "github": {...},
    "obsidian": {...},
    "playwright": {...},
    "custom-api": {...}
  }
}
```

All tools from all servers are available simultaneously.
