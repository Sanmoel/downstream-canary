# Compatibility contract

Downstream Canary v0.1 targets small, single-package JavaScript libraries and explicitly selected public GitHub consumers. The tested runtime is Linux on GitHub-hosted Ubuntu with the pinned image `node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03`.

## Tested matrix

| Component | Exact tested version | v0.1 status | Lockfile | Frozen install |
| --- | --- | --- | --- | --- |
| Node.js | 24.19.0 | Supported | — | — |
| npm | 11.17.0 | Supported | `package-lock.json` | `npm ci` |
| pnpm | 11.21.0 | Supported | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| Yarn | 4.18.0 | Supported with `nodeLinker: node-modules` and the public npm registry | `yarn.lock` | `yarn install --immutable` |

Each manager passed compatible and candidate-regression end-to-end fixtures through candidate packing, direct dependency injection, lockfile generation, fresh installation, installed-byte verification, and identical tests. This is a claim about those exact versions and modes, not every release in their major lines.

Detection order is explicit input, exact `packageManager`, exactly one recognized lockfile, then the v0.1-pinned default shown above. A declaration and lockfile disagreement, multiple recognized lockfiles, non-exact declared version, or other ambiguity is an exit-code-2 configuration error.

## Supported project shape

- Linux and GitHub-hosted Ubuntu runners.
- A non-root runner account; root host users/groups are rejected rather than mapped into containers.
- One to ten public `github.com` repositories, each pinned to an exact lowercase 40-character commit SHA.
- Root `package.json`, one recognized root lockfile, and a single package.
- Candidate dependency in exactly one root `dependencies`, `devDependencies`, or `optionalDependencies` field.
- Root test script, or an explicit test command argument array.
- Candidate root build script when present, or an explicit build command argument array.
- Public npm registry packages; non-registry and credential-bearing lockfile URLs are rejected.

## Explicitly unsupported

- Branches, tags, abbreviated SHAs, private repositories, private/alternate registries, and arbitrary Git hosting.
- Monorepos, package workspaces, Git submodules, nested consumer package roots, and self-references.
- Peer-only, transitive-only, directory `file:`, `link:`, `workspace:`, Git, URL, and package-alias dependencies.
- Yarn Plug'n'Play, Zero-Install/local-cache layouts, custom Yarn binaries/plugins, Classic Yarn, or other Yarn linker modes.
- Self-hosted runners, Windows, and macOS.
- User-level npm, pnpm, Yarn, Git, or SSH credential configuration, plus project-level registry credentials or proxy settings.

An explicitly selected consumer may still have requirements outside this contract. Those are reported as unsupported-project or infrastructure errors, never silently converted into candidate regressions.
