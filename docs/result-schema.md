# Result schema

Each run writes:

- `downstream-canary-report.v1.json`, conforming to [`schemas/downstream-canary-report.schema.json`](../schemas/downstream-canary-report.schema.json).
- `downstream-canary-report.md`, used for the GitHub Step Summary and local reading.

The report schema version is `1.0.0`. Within a major schema version, fields are additive only; consumers should reject unknown major versions and tolerate new minor fields.

The deterministic classifications are:

| Baseline | Candidate | Classification | Blocks compatibility |
| --- | --- | --- | --- |
| pass | pass | `compatible` | No |
| pass | fail | `candidate-regression` | Yes |
| fail | fail | `inconclusive-preexisting` | No |
| fail | pass | `candidate-improvement` | No |

`tool-error` is outside that truth table. It covers invalid configuration, unsupported layouts, checkout or Docker failures, baseline installation failure, malformed packages, unverified injection, infrastructure timeout, and other failures that make the comparison untrustworthy.

The Action exposes `report-path` and `regression-count`. It appends the Markdown report to `GITHUB_STEP_SUMMARY`. Diagnostic excerpts are redacted, bounded to 8 KiB per result, and are not a substitute for the phase/status fields.
