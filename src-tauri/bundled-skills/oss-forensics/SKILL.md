---
name: oss-forensics
description: Open-source security forensics - analyze repositories, dependencies, and code for malicious patterns, supply chain risks, and vulnerabilities.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Security, Forensics, OSS, Supply-Chain, Vulnerability, Analysis]
    related_skills: []
---

# OSS Forensics

## Purpose

- Use this skill to investigate open-source repositories, packages, images, and dependency trees for security risk.
- It is useful for package intake, third-party code review, incident response, and supply-chain due diligence.
- Treat this as a forensic and risk-triage workflow, not a single tool.

## High-Level Approach

1. Audit dependencies for known vulnerabilities.
2. Assess repository trust signals and maintainer health.
3. Review code for suspicious patterns.
4. Generate an SBOM and map packages to CVEs.
5. Check history, provenance, and release integrity.

## Dependency Audit

Python:

```bash
pip audit
```

Node:

```bash
npm audit
```

Rust:

```bash
cargo audit
```

- Start with ecosystem-native audit tools because they surface known advisories quickly.
- Audit output is a first-pass signal, not a complete security assessment.

## Repository Trust Review

- Check stars, forks, contributors, and recent activity.
- Look for consistent release cadence rather than vanity popularity alone.
- Review the maintainer set and whether development is concentrated in one fragile account.
- Inspect open issues and unresolved security reports.
- Check whether CI appears healthy and whether releases are reproducible.

## Maintainer Reputation Signals

- Is the maintainer known in the ecosystem.
- Does the project have multiple active reviewers.
- Are releases signed or provenance-documented.
- Has the project recently changed owners or transfer history.
- Did a previously dormant repo suddenly publish a new release with intrusive install-time behavior.

## Dependency Confusion

- Check whether private internal package names also exist publicly.
- If an internal package name is accidentally resolved from a public registry, it can become a dependency confusion vector.
- Review package names in lockfiles, private registries, and CI configuration.
- Ensure package managers are pinned to the intended registry for internal namespaces.

## Typosquatting Detection

- Compare the package name to well-known packages.
- Look for single-character swaps, dropped vowels, pluralization changes, or unicode lookalikes.
- Typosquatted packages often mimic metadata, README wording, or install instructions.
- Review whether the package description feels copied but inconsistent with the code quality.

## License Compliance

Python:

```bash
pip-licenses
```

Repository-level license detection:

```bash
licensee detect .
```

- Security review and license review are separate concerns, but intake usually needs both.
- Unexpected license changes can also be a signal that package ownership changed or quality control weakened.

## SBOM Generation

Using Syft:

```bash
syft .
syft image:myapp
```

CycloneDX example:

```bash
cyclonedx-bom
```

- Generate an SBOM to establish what is actually present.
- SBOMs are useful for later incident response, vulnerability matching, and compliance reporting.

## CVE Lookup

Container image scanning:

```bash
grype image:myapp
```

Filesystem scanning:

```bash
trivy fs ./
```

- Use `grype` for image/package matching against vulnerability databases.
- Use `trivy fs ./` for repository and local filesystem scanning.
- CVE output should be prioritized by exploitability, exposure, and runtime presence.

## Code Review for Malicious Patterns

Look for:

- obfuscated strings
- suspicious `eval()`
- suspicious `exec()`
- large base64 blobs
- dynamic network fetch during install
- shell command execution in setup hooks
- credential collection logic unrelated to the package purpose

These are not proof by themselves, but they deserve deeper inspection.

## Strings and Obfuscation Heuristics

- Long unreadable encoded literals
- split-and-join string tricks
- excessive use of reflection or metaprogramming in simple packages
- hidden payload assembly at runtime
- download-and-execute logic behind environment checks

## Git History Review

Check for suspicious edits and removed secrets:

```bash
git log --all -S 'password'
```

- Search history for credential strings, hardcoded tokens, or suspiciously removed secrets.
- Also inspect install scripts, CI files, release automation, and package publish workflows.
- A secret that existed and was later removed may still indicate a risky maintainer process.

## Release Integrity

- Verify package checksums when the ecosystem supports it.
- Prefer signed releases or trusted provenance where available.
- Compare source tarballs to repository tags when integrity matters.
- Watch for release artifacts that do not match the visible source tree.

## Supply-Chain Compromise Scenarios

- Maintainer account takeover
- malicious dependency injection in a minor release
- registry compromise
- CI secret theft leading to malicious publishing
- abandoned package taken over by a new owner

The question is not only "is this code vulnerable" but also "could this release path be hijacked."

## Package Intake Questions

- Does the package solve a real problem we need.
- Is the dependency count unusually high for its purpose.
- Are there post-install scripts.
- Is the code readable enough to review.
- Is maintenance active and credible.

## Red Flags

- sudden popularity with no substantial code
- no tests but privileged install behavior
- release notes that do not match the diff
- vendor accounts that changed recently
- dependency tree expansion after a minor version bump

## Practical Workflow

1. Run `pip audit`, `npm audit`, or `cargo audit` as appropriate.
2. Generate an SBOM with `syft` or `cyclonedx-bom`.
3. Scan with `grype` or `trivy`.
4. Inspect repo trust signals and maintainer history.
5. Search code for `eval()`, `exec()`, base64 blobs, and obfuscation.
6. Search git history for removed secrets and suspicious release changes.
7. Verify checksums, tags, and signatures when available.

## Scope Boundaries

- A clean audit report does not mean the package is safe.
- A suspicious code pattern does not automatically mean it is malicious.
- Forensics here is about narrowing uncertainty and documenting risk.
- Escalate to deeper manual review for packages with privileged access or broad deployment.

## Summary

- Audit dependencies with `pip audit`, `npm audit`, and `cargo audit`.
- Review GitHub trust signals including stars, forks, contributors, recent activity, and maintainer reputation.
- Check for dependency confusion and typosquatting against expected package names.
- Use `pip-licenses` and `licensee` for license visibility.
- Generate SBOMs with `syft` or `cyclonedx-bom`.
- Match packages and images to CVEs with `grype image:myapp` and `trivy fs ./`.
- Hunt for malicious patterns such as obfuscation, `eval()`, `exec()`, and base64 payload blobs.
- Search git history for removed secrets with `git log --all -S 'password'`.
- Verify checksums, signatures, and whether maintainer accounts may have been compromised.
