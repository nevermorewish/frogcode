---
name: linear
description: Linear project management — create issues, manage cycles, update projects, and query team progress via Linear API or MCP.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Linear, Project-Management, Issues, Cycles, Productivity, GraphQL]
    related_skills: [github-issues]
---

# Linear Project Management

Manage Linear issues, cycles, projects, and team workflows via the Linear API (GraphQL) or MCP.

## Setup

```bash
# Get API key from Linear: Settings → API → Personal API Keys
export LINEAR_API_KEY="lin_api_..."
```

```python
import requests

LINEAR_API = "https://api.linear.app/graphql"
HEADERS = {
    "Authorization": f"Bearer {LINEAR_API_KEY}",
    "Content-Type": "application/json"
}

def linear_query(query, variables=None):
    resp = requests.post(LINEAR_API, json={"query": query, "variables": variables or {}}, headers=HEADERS)
    return resp.json()["data"]
```

---

## List Issues

```python
query = """
query {
  issues(filter: {assignee: {isMe: {eq: true}}, state: {type: {nin: ["completed", "cancelled"]}}}) {
    nodes {
      id title priority state { name } team { name }
    }
  }
}
"""
data = linear_query(query)
for issue in data["issues"]["nodes"]:
    print(f"[{issue['state']['name']}] {issue['title']}")
```

---

## Create Issue

```python
mutation = """
mutation CreateIssue($title: String!, $teamId: String!, $description: String, $priority: Int) {
  issueCreate(input: {
    title: $title
    teamId: $teamId
    description: $description
    priority: $priority
  }) {
    success
    issue { id title url }
  }
}
"""

data = linear_query(mutation, {
    "title": "Fix auth bug in production",
    "teamId": "TEAM_ID",
    "description": "Users getting 401 on refresh token",
    "priority": 1  # 0=no priority, 1=urgent, 2=high, 3=medium, 4=low
})
print(data["issueCreate"]["issue"]["url"])
```

---

## Get Teams

```python
teams_query = """
query { teams { nodes { id name key } } }
"""
data = linear_query(teams_query)
for team in data["teams"]["nodes"]:
    print(f"{team['key']}: {team['name']} ({team['id']})")
```

---

## Update Issue

```python
update_mutation = """
mutation UpdateIssue($id: String!, $stateId: String) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}
"""
linear_query(update_mutation, {"id": "ISSUE_ID", "stateId": "STATE_ID"})
```

---

## Search Issues

```python
search_query = """
query SearchIssues($query: String!) {
  issueSearch(query: $query) {
    nodes { id title state { name } url }
  }
}
"""
data = linear_query(search_query, {"query": "auth bug"})
```

---

## Cycles (Sprints)

```python
cycles_query = """
query {
  cycles(filter: {isActive: {eq: true}}) {
    nodes {
      id name number startsAt endsAt
      issues { nodes { id title state { name } } }
    }
  }
}
"""
data = linear_query(cycles_query)
```

---

## MCP Integration

If Linear MCP is installed in `.mcp.json`:
```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-linear"],
      "env": {"LINEAR_API_KEY": "lin_api_..."}
    }
  }
}
```

Then Claude can use Linear tools directly without GraphQL code.

---

## Webhooks (receive events)

```python
# Linear sends POST to your endpoint on issue create/update
# Payload includes: type, action, data.issue
# Verify with: X-Linear-Signature header
import hmac, hashlib

def verify_signature(payload, signature, secret):
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)
```
