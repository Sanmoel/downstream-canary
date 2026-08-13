# Changelog

All notable changes to this project will be documented here. The format follows Keep a Changelog and versions follow Semantic Versioning.

## [Unreleased]

No changes are currently queued beyond the prepared v0.1.0 release candidate below.

## [0.1.0] - Unreleased

This release has been prepared but not tagged, published to npm, or released on GitHub.

### Added

- TypeScript CLI and reusable Node 24 GitHub Action.
- Deterministic two-lane comparison and exit-code contract.
- Verified npm, pnpm, and modern Yarn adapters at exact pinned versions.
- Hardened Docker execution, candidate tarball and installed-byte verification, secret redaction, and bounded diagnostics.
- Versioned JSON/Markdown reports and JSON Schemas.
- Unit, integration, security, Action-smoke, distribution-drift, and self-contained demo coverage.

### Security

- Separated GitHub Action invocation policy from candidate-controlled CLI/YAML configuration and recorded a canonical policy SHA-256 plus exact test arguments.
- Enforced the GitHub-hosted Linux `pull_request` trust boundary and local Unix Docker endpoints in Action mode.
- Made lockfile failures tool errors and added typed, positive attribution for candidate-install regressions.
- Removed public install/lockfile command overrides; disabled project Corepack environment files and Corepack auto-pin/update behavior; pinned the public npm registry.
- Provisioned exact package managers once per comparison, hash-verified them, and mounted the shared provision read-only in both lanes.
- Added run-labeled, verified container cleanup, signal cleanup, whole-run deadlines, and bounded generated-output reporting.

### Release engineering

- Added generated bundled-dependency notices, an exact report schema contract, a successful bundled-Action harness, and a v0.1.0 release checklist.

[Unreleased]: https://github.com/Sanmoel/downstream-canary/commits/main
