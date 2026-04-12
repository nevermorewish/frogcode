---
name: sherlock
description: OSINT username search across 400+ social networks using the Sherlock Project.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [OSINT, Security, Username, Social-Media, Reconnaissance]
    related_skills: []
---

# Sherlock

## Purpose

- Use this skill to search for username presence across many public social platforms and web services.
- Sherlock is useful for OSINT, account enumeration, alias correlation, and open-source reconnaissance.
- It is a reconnaissance utility, not a guarantee of identity resolution.

## Install

```bash
pip install sherlock-project
```

Alternative source install:

```bash
git clone https://github.com/sherlock-project/sherlock
cd sherlock
python -m pip install -r requirements.txt
python sherlock.py username
```

## Basic Search

```bash
sherlock username
```

- This searches a broad set of supported sites for a single username.
- Output normally shows which sites likely contain a matching profile.
- Results are only a starting point and should be verified manually.

## Multiple Usernames

```bash
sherlock user1 user2 user3
```

- Use this when comparing handles across several candidate aliases.
- Batch searching is useful when the target uses variations of the same naming pattern.
- Keep the candidate list short enough to review carefully.

## Output to a File

```bash
sherlock username --output results.txt
```

- Save results when you need an audit trail or want to compare scans over time.
- Text output is convenient for quick archival, case notes, and manual review.

## CSV Output

```bash
sherlock username --csv
```

- CSV output is useful for spreadsheet triage and bulk analysis.
- This is the better option when integrating results into reporting or other tooling.

## Restrict Search to Specific Sites

```bash
sherlock username --site twitter github
```

- Site filtering is useful when you only care about a narrow platform set.
- Restricting sites speeds up focused investigations and reduces noise.
- Use it for targeted checks like developer handles, gaming handles, or creator profiles.

## Timeout Control

```bash
sherlock username --timeout 10
```

- Increase the timeout on slow or unstable networks.
- Decrease it when you want faster but less patient scans.
- Timeouts affect coverage and speed, so tune them to the environment.

## Tor Support

```bash
sherlock username --tor
```

- This requires Tor to be installed and available.
- Use Tor only when your environment and policy allow it.
- Expect slower requests and occasional site behavior differences.

## Print All Results

```bash
sherlock username --print-all
```

- This includes not-found results in addition to matches.
- It is useful when you want a full per-site record rather than only positive hits.
- Full output is better for documentation and reproducible analysis.

## Practical Workflow

1. Start with a single username search.
2. Save results to a file or CSV.
3. Filter to high-value platforms for deeper review.
4. Manually verify candidate profiles.
5. Correlate bios, avatars, links, timestamps, and naming patterns.

## Verification Guidance

- A found username is not proof that the account belongs to the same person.
- Check profile metadata such as avatar reuse, linked websites, self-descriptions, and posting patterns.
- Compare account creation dates, geographic references, and cross-links.
- Treat weak matches as leads, not conclusions.

## Good Use Cases

- Brand protection checks
- Public alias discovery
- Security research on exposed usernames
- Reconnaissance for incident response
- Confirming whether a handle is broadly reused

## Limitations

- Site behavior changes can break detection.
- Some platforms throttle or block automated requests.
- False positives and false negatives both happen.
- Private or suspended accounts may not appear reliably.

## Output Handling

- Keep raw outputs with timestamps when the result matters.
- Store CSV when the data will be joined with other OSINT sources.
- Re-run focused scans rather than assuming old results are still valid.

## Ethical Use

- Use Sherlock only for authorized research, defensive security work, or lawful OSINT.
- Do not use it to harass, dox, stalk, or profile individuals without authorization.
- Respect the legal and policy boundaries of your organization and jurisdiction.

## Summary

- Install with `pip install sherlock-project` or from the upstream GitHub repo.
- Search one handle with `sherlock username`.
- Search several with `sherlock user1 user2 user3`.
- Save results with `--output results.txt` or `--csv`.
- Restrict sites with `--site twitter github`.
- Tune network behavior with `--timeout 10` and optionally `--tor`.
- Use `--print-all` when a complete site-by-site record is needed.
