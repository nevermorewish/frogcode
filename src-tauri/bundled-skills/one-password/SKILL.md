---
name: one-password
description: 1Password CLI integration — retrieve secrets, manage vaults, inject credentials into scripts without hardcoding.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Security, 1Password, Secrets, Credentials, CLI, Vault]
    related_skills: []
---

# 1Password CLI

Retrieve secrets and manage credentials from 1Password without hardcoding them in scripts or environment files.

## Setup

```bash
# Install 1Password CLI (op)
# macOS
brew install 1password-cli

# Linux
curl -sS https://downloads.1password.com/linux/keys/1password.asc | gpg --import
# See: developer.1password.com/docs/cli/get-started

# Windows
winget install AgileBits.1Password.CLI

# Verify
op --version
```

## Authentication

```bash
# Sign in (opens browser or prompts)
op signin

# Or with service account (CI/CD)
export OP_SERVICE_ACCOUNT_TOKEN="eyJhbGci..."

# Check auth
op whoami
```

---

## Read Secrets

```bash
# Read a field from an item
op item get "AWS Credentials" --field "access key id"
op item get "GitHub Token" --field password

# Read by item ID
op item get "abc123xyz" --field password

# Read as env var format
op item get "AWS Credentials" --format json
```

---

## Inject into Environment

```bash
# op run: inject secrets into any command
op run --env-file=".env.1password" -- python my_script.py

# .env.1password format:
# AWS_ACCESS_KEY_ID=op://Private/AWS Credentials/access key id
# AWS_SECRET_ACCESS_KEY=op://Private/AWS Credentials/secret access key
# DATABASE_URL=op://Work/Production DB/connection string
```

---

## Secret Reference Syntax

```
op://VAULT/ITEM/FIELD
op://Private/GitHub/token
op://Work/AWS Production/access key id
```

Use in .env.1password or in shell scripts:

```bash
export GITHUB_TOKEN=$(op item get "GitHub" --field token)
export DB_PASS=$(op item get "PostgreSQL Prod" --field password)
```

---

## In Python Scripts

```python
import subprocess

def get_secret(vault, item, field):
    result = subprocess.run(
        ["op", "item", "get", item, "--vault", vault, "--field", field],
        capture_output=True, text=True, check=True
    )
    return result.stdout.strip()

db_password = get_secret("Work", "PostgreSQL Prod", "password")
api_key = get_secret("Private", "OpenAI", "api key")
```

---

## List and Search

```bash
# List all vaults
op vault list

# List items in vault
op item list --vault Private

# Search
op item list --categories Login --tags production
```

---

## Create Items

```bash
# Create a login
op item create \
  --category Login \
  --title "My Service" \
  --vault Work \
  username="admin" \
  password="$(openssl rand -base64 32)"

# Create an API credential
op item create \
  --category "API Credential" \
  --title "OpenAI" \
  credential="sk-..."
```

---

## CI/CD Integration

```yaml
# GitHub Actions
- name: Configure 1Password
  uses: 1password/load-secrets-action@v2
  with:
    export-env: true
  env:
    OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
    AWS_ACCESS_KEY_ID: op://CI/AWS/access-key-id
    AWS_SECRET_ACCESS_KEY: op://CI/AWS/secret-access-key
```

---

## SSH Key Management

```bash
# 1Password SSH Agent (stores SSH keys in 1Password)
# Enable in 1Password Settings → Developer → SSH Agent

# Use in ~/.ssh/config:
Host github.com
  IdentityAgent "~/Library/Group Containers/.../agent.sock"

# List SSH keys
op item list --categories "SSH Key"
```

---

## Why Use 1Password CLI

- No secrets in `.env` files committed to git
- Rotate credentials without touching code
- Audit log of who accessed what
- Works offline (cached vault)
- Team sharing without exposing plaintext
