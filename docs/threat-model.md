# Threat model

Downstream Canary provides **hardened container isolation for explicitly selected and pinned downstream projects**. Docker is not a complete security boundary, and this project does not claim that it makes arbitrary untrusted code safe.

## Trust boundaries

Candidate source, build scripts, downstream dependency lifecycle scripts, and downstream tests may be hostile. The GitHub Action invocation is a separate policy boundary from the local CLI: Action mode never loads candidate `.downstream-canary.yml`, while the explicitly selected local CLI may. The Action itself, its pinned runtime image, local Docker Engine, GitHub-hosted runner, public npm registry, GitHub transport, and explicitly selected commit identities remain trusted dependencies.

## Implemented controls

- Candidate source is copied before build; build and pack do not mutate the checked-out source.
- Each consumer has two independent exact-commit checkouts and separate writable package caches. Its exact Corepack manager is provisioned once, hashed, and exposed through the same verified read-only store to both lanes. `COREPACK_ENV_FILE=0`, automatic pin/latest updates are disabled, and manager downloads plus package installs are pinned to `https://registry.npmjs.org`.
- Containers run as the host's non-root UID/GID with all Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem, bounded tmpfs, no privileged mode, and no Docker socket mount.
- Containers receive CPU, memory, process-count, log-output, and wall-clock limits. A monotonic whole-run deadline allocates each remaining consumer a bounded share. Candidate tarballs are bounded to 50 MiB compressed, 200 MiB unpacked, and 20,000 headers. Every container has a unique per-run label; kill/remove is retried and verified with inspect, a final label sweep must be empty, and unresolved cleanup is fatal. `SIGINT` and `SIGTERM` initiate the same cleanup; `--init` reaps child processes.
- Each lane has only its workspace and its own writable cache mounted. No shared writable package cache exists across lanes.
- Only a small environment allowlist is forwarded. Names containing `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `CREDENTIAL`, or `AUTH` are rejected. `GITHUB_TOKEN`, registry configuration, SSH agents, Git credentials, and host package-manager configuration are not mounted or forwarded.
- Git runs with prompts and credential helpers disabled and a disposable global configuration.
- Test phases use Docker `--network none`; only loopback remains.
- Candidate lockfile generation disables lifecycle scripts with manager flags and a fail-closed environment override. Candidate and baseline fresh installs intentionally run lifecycle scripts because consumer behavior can depend on them.
- The candidate tarball is checked for `package/package.json`, identity, traversal, absolute paths, checksums, entry types, and escaping links. The installed package's file bytes and links are compared with the validated tarball.
- The original checkout is never a lane. Pre-test injection restricts changes to the planned manifest field and expected lockfile. After tests, tracked files and package-manager protected files are verified separately. Ordinary newly generated regular files are recorded and allowed up to 2,000 files and 100 MiB per lane; other entry types or excess output are tool errors. Output logs are bounded and redacted.
- Action mode rejects `pull_request_target`, non-Linux and self-hosted runners, remote Docker endpoints, and non-absolute workspaces. The local CLI requires explicit `--local --candidate-root <path>` intent.
- A canonical SHA-256 covers the resolved policy, including exact test argument arrays and resource limits. The identical recorded test command runs in baseline and candidate.
- Candidate lockfile failures are always tool errors. Candidate install regression attribution requires positive manager evidence from a scripts-disabled frozen-install probe; network, registry, Corepack, Docker, timeout, and unknown failures remain tool errors.

## Residual risks

Dependency installation needs outbound network access to retrieve public packages. Malicious install scripts can make network requests, attack a registry or dependency, consume the allowed resources, temporarily exceed post-test generated-output limits, fill the host-backed temporary workspace before timeout, and exploit a Docker/kernel/runtime vulnerability. Public registries can return compromised content. Docker daemon compromise could affect its host. DNS and registry metadata leak the packages being installed. Build and test commands can read the files mounted in their own isolated workspace, including the candidate tarball. The Docker client necessarily controls the local host daemon, although the socket is never mounted into an untrusted container.

Git checkout occurs on the host using the system Git client, but no repository hooks, submodules, or credential helpers run. Tarball parsing happens on the host against bounded package output; malformed archives are treated as tool errors.

GitHub-hosted runners are required because they are ephemeral. Self-hosted runners are explicitly unsupported. Keep workflows on `pull_request`, grant only `contents: read`, pass no secrets, and pin every action by full commit SHA.

## Implementation references

- [GitHub Actions default variables and `RUNNER_ENVIRONMENT`](https://docs.github.com/actions/reference/workflows-and-actions/variables)
- [Corepack environment controls](https://github.com/nodejs/corepack/blob/main/README.md#environment-variables)
- [npm configuration](https://docs.npmjs.com/cli/using-npm/config/)
- [Docker object labels](https://docs.docker.com/engine/manage-resources/labels/) and [Docker endpoint schemes](https://docs.docker.com/reference/cli/docker/)
