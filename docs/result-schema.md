# Result schema

Each run writes:

- `downstream-canary-report.v1.json`, conforming to [`schemas/downstream-canary-report.schema.json`](../schemas/downstream-canary-report.schema.json).
- `downstream-canary-report.md`, used for the GitHub Step Summary and local reading.

The report schema version is exactly `1.0.0`. The checked-in schema is the complete contract: fields are not added, removed, or retyped without a new schema version and corresponding schema artifact. `additionalProperties: false` is intentional; consumers should validate the complete document rather than assuming additive minor fields.

The deterministic classifications are:

| Baseline | Candidate | Classification | Blocks compatibility |
| --- | --- | --- | --- |
| pass | pass | `compatible` | No |
| pass | fail | `candidate-regression` | Yes |
| fail | fail | `inconclusive-preexisting` | No |
| fail | pass | `candidate-improvement` | No |

`tool-error` is outside that truth table. It covers invalid configuration, unsupported layouts, checkout or Docker failures, baseline installation failure, every candidate lockfile-generation failure, malformed packages, unverified injection, infrastructure timeout, and other failures that make the comparison untrustworthy. A candidate install failure is a regression only with `dependency-resolution` or `lifecycle-incompatibility` attribution; `registry`, `network`, `corepack`, `docker`, `unknown`, and timeout causes are tool errors.

The top-level `policy` contains the fully resolved invocation policy and a canonical SHA-256 over its stable JSON form. Each result records the exact `executedTestCommand`, requested/declared/actual manager versions, the shared manager-provision hash, candidate-install attribution, original/candidate lock hashes, and bounded generated paths for both lanes. Arrays preserve execution order; object keys are serialized stably.

The Action exposes `report-path` and `regression-count`. It appends the Markdown report to `GITHUB_STEP_SUMMARY`. Diagnostic excerpts are redacted, bounded to 8 KiB per result, and are not a substitute for the phase/status fields.
