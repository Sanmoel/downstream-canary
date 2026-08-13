# Security policy

## Supported versions

Security fixes are provided for the latest released `0.1.x` version. v0.1.0 is a public pilot: pin Action use to the full reviewed implementation SHA in the README because the default branch may contain unreleased changes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for `Sanmoel/downstream-canary` if it is enabled. Otherwise, contact the repository owner privately through the contact method on the owner's GitHub profile. Do not open a public issue containing exploit details, credentials, or private consumer information.

Include the affected commit, operating system and Docker versions, a minimal reproduction, expected impact, and whether the issue crosses the container or credential boundary. You should receive acknowledgement within seven days. Coordinated disclosure timing will depend on severity and fix availability.

Never include real tokens, registry credentials, or private repository content in a report. See [`docs/threat-model.md`](docs/threat-model.md) for intended controls and residual risks.
