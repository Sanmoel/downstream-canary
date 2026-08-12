# Downstream Canary

> **Your library’s tests pass. Downstream Canary checks whether the change breaks the projects that actually depend on it.**

Downstream Canary is drop-in, convention-over-configuration compatibility testing for small JavaScript libraries. It builds one candidate package tarball, checks each explicitly selected downstream repository out at one exact commit in two clean Docker lanes, and deterministically compares the downstream tests.

## Demonstrated result

The self-contained `tiny-parser` regression demo keeps the candidate library's own tests green while changing `parse()` from `{ value }` to `{ text }`:

```text
1. Candidate library tests: pass
2. Baseline downstream tests: pass
3. Candidate downstream tests: fail
4. Classification: candidate-regression
5. Exit code: 1

Consumer                                   Manager      Baseline  Candidate  Classification       Failure phase
-----------------------------------------  -----------  --------  ---------  -------------------  --------------
downstream-canary-fixtures/npm-regression  npm@11.17.0  pass      fail       candidate-regression  candidate-test
```

Run it without modifying user files:

```console
npm ci
npm run build
npm run demo                 # intentional regression; exits 1
npm run demo:compatible      # compatible; exits 0
npm run demo:preexisting     # existing downstream failure; exits 0
```

Each demo prints absolute paths to generated JSON and Markdown reports in a temporary directory.

## GitHub Action

Conventional projects need only pinned consumers:

```yaml
name: Downstream compatibility

permissions:
  contents: read

on:
  pull_request:

jobs:
  downstream-canary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - uses: Sanmoel/downstream-canary@REPLACE_WITH_FULL_COMMIT_SHA
        with:
          consumers: |
            acme/example-client@0123456789abcdef0123456789abcdef01234567
            acme/example-tool@abcdef0123456789abcdef0123456789abcdef01
```

Do not replace the full SHAs with branches or tags. The Action needs Docker (available on GitHub-hosted Ubuntu), no secrets, and only `contents: read`. It produces a terminal table, GitHub Step Summary, stable versioned JSON, bounded redacted diagnostics, `report-path`, and `regression-count` outputs.

## Deterministic result

| Baseline | Candidate | Classification | Blocks |
| --- | --- | --- | --- |
| pass | pass | `compatible` | No |
| pass | fail | `candidate-regression` | Yes |
| fail | fail | `inconclusive-preexisting` | No |
| fail | pass | `candidate-improvement` | No |

Exit `0` means no candidate regression, `1` means at least one candidate regression, and `2` means configuration, unsupported-project, tooling, or infrastructure error. Baseline installation failure is always exit `2`; candidate install failure after a healthy baseline is a candidate regression with phase `candidate-install`.

No statistical or AI decision changes this result. The same command runs in both test lanes. The only compatibility blocker is `candidate-regression`.

## What the engine verifies

1. Copy, install, build, and `npm pack` the candidate inside a hardened container.
2. Validate package identity, tar paths and links, contents, and SHA-256.
3. Clone each public consumer twice with credentials disabled and check out its exact 40-character commit.
4. Frozen-install and test the lockfile baseline.
5. Copy the tarball into the candidate checkout, patch one direct dependency field to a relative `file:` URL, and generate a lockfile with lifecycle scripts disabled.
6. Verify the manifest/lockfile change boundary, perform a fresh frozen install, and compare installed package bytes with the tarball.
7. Test with `--network none`, classify the two results, and clean every temporary lane.

The implementation provides **hardened container isolation for explicitly selected and pinned downstream projects**. Docker is not a complete security boundary. Installation retains network access because public dependencies must be downloaded; see [the threat model](docs/threat-model.md).

## Compatibility

The exact end-to-end-tested matrix is Node 24.19.0, npm 11.17.0, pnpm 11.21.0, and Yarn 4.18.0 with the `node-modules` linker. All use a pinned Debian Bookworm Slim image digest. See [compatibility details and explicit exclusions](docs/compatibility.md).

## Configuration and reports

- [Configuration and CLI](docs/configuration.md)
- [Configuration JSON Schema](schemas/downstream-canary-config.schema.json)
- [Result fields and stability](docs/result-schema.md)
- [Result JSON Schema](schemas/downstream-canary-report.schema.json)
- [Security model](docs/threat-model.md)
- [Maintainer dogfood handoff](docs/dogfooding.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

The repository includes a committed bundled runtime in `dist/`, verified against the TypeScript source in CI. The package/CLI is named `downstream-canary`, but no public npm-package availability is claimed.

## Local validation

```console
npm ci
npm run test:all
```

The integration suite needs a working Docker Engine. It deliberately uses separate writable caches per lane and pulls only the pinned image and exact Corepack package-manager releases.

Apache-2.0 licensed. See [LICENSE](LICENSE).
