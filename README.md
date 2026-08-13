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
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - uses: Sanmoel/downstream-canary@70d8fab1341fc9afe4c518fa54602e5551008844
        with:
          consumers: |
            acme/example-client@0123456789abcdef0123456789abcdef01234567
            acme/example-tool@abcdef0123456789abcdef0123456789abcdef01
```

This example pins the reviewed v0.1.0 implementation commit. Keep the full commit SHA rather than replacing it with a branch or mutable tag. The Action fails closed unless it is running in GitHub Actions on a GitHub-hosted Linux runner, rejects `pull_request_target`, and accepts only an unset or local Unix-socket `DOCKER_HOST`. It needs no secrets and only `contents: read`.

Action mode never reads `.downstream-canary.yml`. The Action invocation selects consumers, overrides, output location, and resource limits; conventional package-manager and test-script detection is restricted to the selected root package manifests and lockfiles. The resolved policy, its canonical SHA-256, and each exact test argument array are recorded in the report. The local CLI has a separate, explicit `--local --candidate-root <path>` boundary and may use YAML.

## Deterministic result

| Baseline | Candidate | Classification | Blocks |
| --- | --- | --- | --- |
| pass | pass | `compatible` | No |
| pass | fail | `candidate-regression` | Yes |
| fail | fail | `inconclusive-preexisting` | No |
| fail | pass | `candidate-improvement` | No |

Exit `0` means no candidate regression, `1` means at least one candidate regression, and `2` means configuration, unsupported-project, tooling, or infrastructure error. Baseline installation failure and every candidate lockfile-generation failure are exit `2`. A candidate installation failure blocks only when a scripts-disabled attribution run positively proves a package-manager dependency-resolution or lifecycle incompatibility; registry, network, Corepack, Docker, timeout, and unknown causes are tool errors.

No statistical or AI decision changes this result. The same command runs in both test lanes. The only compatibility blocker is `candidate-regression`.

## What the engine verifies

1. Copy, install, build, and `npm pack` the candidate inside a hardened container.
2. Validate package identity, tar paths and links, contents, and SHA-256.
3. Clone each public consumer twice with credentials disabled and check out its exact 40-character commit.
4. Frozen-install and test the lockfile baseline.
5. Copy the tarball into the candidate checkout, patch one direct dependency field to a relative `file:` URL, and generate a lockfile with lifecycle scripts disabled.
6. Verify the manifest/lockfile change boundary, perform a fresh frozen install, and compare installed package bytes with the tarball.
7. Run the exact same recorded test arguments with `--network none`, preserve all tracked/protected files, and record bounded ordinary generated output.
8. Classify deterministically, verify removal of every run-labeled container, and perform a final label sweep.

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

The repository includes a committed bundled runtime in `dist/`, verified against the TypeScript source in CI, and generated [third-party notices](THIRD_PARTY_NOTICES) for its bundled libraries. The package/CLI is named `downstream-canary`, but no public npm-package availability is claimed. The prepared release steps are in [the v0.1.0 checklist](docs/release-checklist.md).

## Local validation

```console
npm ci
npm run test:all
```

The integration suite needs a working Docker Engine. It deliberately uses separate writable caches per lane and pulls only the pinned image and exact Corepack package-manager releases.

Apache-2.0 licensed. See [LICENSE](LICENSE).
