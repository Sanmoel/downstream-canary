# Configuration

Conventional projects need only an explicit list of pinned consumers. Downstream Canary detects the candidate name from its root `package.json`, then detects each project using the precedence in [the compatibility contract](compatibility.md).

```yaml
permissions:
  contents: read

on:
  pull_request:

jobs:
  downstream-canary:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - uses: Sanmoel/downstream-canary@<FULL_COMMIT_SHA>
        with:
          consumers: |
            acme/example-client@0123456789abcdef0123456789abcdef01234567
            acme/example-tool@abcdef0123456789abcdef0123456789abcdef01
```

The workflow must use `pull_request`, a GitHub-hosted Ubuntu runner, `contents: read`, and no secrets. Pin both actions to full commit SHAs. The Action enforces GitHub Actions, Linux, `RUNNER_ENVIRONMENT=github-hosted`, rejection of `pull_request_target`, and a local Unix Docker daemon.

Action mode has no `config` input and never checks whether `.downstream-canary.yml` exists. If a legacy or injected `INPUT_CONFIG` value is present, it fails closed. Consumer identities and explicit manager/test/limit overrides come from the Action invocation. If an override is omitted, convention detection reads only root package metadata and the exact pinned consumer checkout; candidate YAML cannot alter the policy. The Action-version defaults are a 600-second command limit and a 2,700-second monotonic whole-run limit.

Optional Action overrides include exact candidate/consumer manager names and versions, `candidate-build-command`, and `consumer-test-command`. Commands are JSON argument arrays, for example `consumer-test-command: '["npm","run","test:compat"]'`. There are no public install-command or lockfile-command overrides in v0.1.

## Local-CLI-only `.downstream-canary.yml`

Use the optional file only with the explicit local CLI boundary for nonstandard projects. The GitHub Action ignores it. Its schema is [`schemas/downstream-canary-config.schema.json`](../schemas/downstream-canary-config.schema.json).

```yaml
version: 1
candidate:
  workingDirectory: .
  buildCommand: [npm, run, build]
defaults:
  testCommand: [npm, run, test:compat]
consumers:
  - repository: acme/example-client
    commit: 0123456789abcdef0123456789abcdef01234567
  - repository: https://github.com/acme/example-tool
    commit: abcdef0123456789abcdef0123456789abcdef01
timeoutSeconds: 600
runTimeoutSeconds: 2700
outputDirectory: .downstream-canary-results
```

All command overrides are argument arrays. Shell strings, interpolation, redirection, pipelines, and shell operators are not accepted. Subprocesses are spawned without a shell.

Candidate-root, configuration, and output paths must be safe paths inside the checked-out workspace. Symbolic-link path components are rejected for host-side reads and writes. The v0.1 `workingDirectory` value is only `.`, matching the single-package root contract; use the CLI or Action `candidate-root` input to select a candidate package directory. `.downstream-canary` and `node_modules` are reserved and must not already exist in a clean consumer checkout.

## CLI

The repository-local CLI is `downstream-canary`. Local intent and the candidate path are both mandatory:

```console
node dist/cli.js \
  --local \
  --candidate-root . \
  --consumers 'acme/example-client@0123456789abcdef0123456789abcdef01234567'
```

Run `node dist/cli.js --help` for all overrides. This repository has not claimed or performed an npm publication; install or invoke it from a verified repository checkout.

Exit codes are stable: `0` means no candidate regression, `1` means at least one candidate regression, and `2` means a configuration, unsupported-project, tooling, or infrastructure error. A tool error takes precedence over a regression because the complete run is not trustworthy.
