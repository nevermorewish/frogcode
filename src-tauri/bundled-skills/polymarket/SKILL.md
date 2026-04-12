---
name: polymarket
description: Query Polymarket prediction markets for probability data and research insights on real-world events.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Research, Polymarket, Prediction-Markets, Probability, Events]
    related_skills: []
---

# Polymarket

## Purpose

- Use this skill to pull live prediction market data for research and forecasting workflows.
- Polymarket is useful for probability-oriented views of current events, elections, macro themes, and sports or policy questions.
- Treat the market price as a crowd-implied probability signal, not ground truth.

## API Surface

- Base reference: `https://clob.polymarket.com/`
- Public market discovery is commonly accessed through the gamma API.
- Start with active markets and then filter by topic or keyword.

## Request Discipline and Rate Limits

- Send a timeout on every request and fail fast instead of hanging a long-running research pass.
- Start with at most 1 request per second when iterating on the gamma API and slow down further if responses get unstable.
- Back off and retry once on `429` or transient `5xx` responses with a short sleep before the second request.
- Cache raw JSON snapshots by timestamp when polling the same topic so you do not hit the API repeatedly for the same view.
- Keep `limit` small during discovery, then widen only after you confirm the endpoint shape and the filter logic you need.
- Record the exact URL you used in notes or logs so later analysis can reproduce the same market slice.

## Fetch Active Markets

```bash
curl "https://gamma-api.polymarket.com/markets?active=true&limit=20"
```

- This returns a JSON list of market objects.
- Use small limits during exploration and larger limits when building a topic watcher.

## Important Market Fields

- `question`
- `outcomes`
- `outcomePrices`
- `volume`

These are usually enough for first-pass research.

## Additional Fields to Inspect

- Inspect `slug` when you need a stable human-readable identifier for later lookups or reporting.
- Inspect `endDate` or other settlement timing fields when the timing of resolution matters more than the headline probability.
- Inspect `liquidity` when present to separate tradeable markets from thin markets that move on little size.
- Inspect `active` and `closed` to keep live monitoring separate from post-resolution analysis.
- Inspect `category`, `tags`, or related event metadata when you need to group markets into a watcher by theme.
- Inspect `conditionId` or token identifiers when you need to correlate market data across downstream systems.

## Interpret the Data

- `question` is the market prompt.
- `outcomes` lists the named outcomes, often `Yes` and `No`.
- `outcomePrices` represents the current market-implied probabilities.
- `volume` helps indicate liquidity and how much weight to assign the price signal.

## Probability Interpretation

- Interpret a price like `0.65` as roughly a 65 percent implied chance.
- Lower-liquidity markets may be noisier.
- High probability is not certainty.
- Large probability moves over time can matter more than a single point estimate.

## Python Example

```python
import requests

url = "https://gamma-api.polymarket.com/markets?active=true&limit=20"
markets = requests.get(url, timeout=20).json()

for market in markets:
    question = market.get("question")
    prices = market.get("outcomePrices")
    print(question, prices)
```

- This is the minimum useful fetch loop.
- Add defensive parsing because API field presence can vary.

## Error Handling and Parsing Rules

- Call `response.raise_for_status()` before parsing JSON so transport failures are not mistaken for empty market sets.
- Normalize the response into a list even if the endpoint returns a single object or a wrapped payload.
- Parse `outcomes` and `outcomePrices` defensively because some clients expose them as serialized JSON strings.
- Skip a market if the number of outcomes does not match the number of prices, and log the `question` for review.
- Treat missing `volume` or `liquidity` as a low-confidence signal instead of silently trusting the quoted price.
- Drop closed or inactive markets from live-monitoring runs unless the task is explicitly about settlement or historical analysis.
- Return the raw market object when the schema changes and your parser no longer finds the expected keys.

## Filter by Category or Keyword

- Filter by category when tracking a domain like politics, crypto, or macro.
- Filter by keyword when you care about a specific topic such as `tariffs`, `Fed`, or `OpenAI`.
- Keep the raw result set if you want to backtest or compare price movement later.

Simple pattern:

```python
keyword = "election"
filtered = [
    m for m in markets
    if keyword.lower() in (m.get("question", "")).lower()
]
```

## Concrete Workflows

1. Track a single topic with `curl` and `jq`.

```bash
curl -s "https://gamma-api.polymarket.com/markets?active=true&limit=100" \
  | jq -r '.[] | select((.question // "") | ascii_downcase | contains("fed")) | [.question, .outcomePrices, .volume] | @tsv'
```

2. Save a reproducible snapshot before doing interpretation.

```bash
mkdir -p data/polymarket
curl -s "https://gamma-api.polymarket.com/markets?active=true&limit=100" \
  -o "data/polymarket/markets_$(date +%Y%m%d_%H%M%S).json"
```

3. Filter to liquid markets in Python before ranking.

```python
import requests

markets = requests.get(
    "https://gamma-api.polymarket.com/markets?active=true&limit=100",
    timeout=20,
).json()

liquid = [
    m for m in markets
    if float(m.get("volume") or 0) >= 10000
]
```

Use these workflows for headline watchers, event-specific dashboards, and daily probability snapshots that need to be comparable over time.

## Research Use Cases

- calibration research
- current event probabilities
- forecasting support
- comparing market odds to analyst narratives
- monitoring how expectations move after news breaks

## Practical Workflow

1. Pull active markets.
2. Filter to the topic you care about.
3. Extract `question`, `outcomes`, `outcomePrices`, and `volume`.
4. Rank by liquidity or relevance.
5. Compare probability shifts over time for insight.

## Caveats

- Prediction markets reflect tradable sentiment, not guaranteed truth.
- Low volume can distort the apparent probability.
- Market structure and fees can affect behavior.
- Always interpret results in context of liquidity and market design.

## Summary

- Use Polymarket for research into crowd-implied probabilities on real-world events.
- Start with `https://clob.polymarket.com/` and fetch active markets via `https://gamma-api.polymarket.com/markets?active=true&limit=20`.
- Useful market fields include `question`, `outcomes`, `outcomePrices`, and `volume`.
- A price such as `0.65` can be read as about a 65 percent implied chance.
- Use simple Python `requests` scripts or `curl`, then filter by category or keyword for forecasting and calibration workflows.
