# Threat model

Downstream Canary provides **hardened container isolation for explicitly selected and pinned downstream projects**. Docker is not a complete security boundary, and this project does not claim that it makes arbitrary untrusted code safe.

## Trust boundaries

Candidate build scripts, downstream dependency lifecycle scripts, and downstream tests may be hostile. The Action itself, its pinned runtime image, Docker Engine, GitHub-hosted runner, public package registries, GitHub transport, and explicitly selected commit identities remain trusted dependencies.

## Implemented controls

- Candidate source is copied before build; build and pack do not mutate the checked-out source.
- Each consumer has two independent exact-commit checkouts and separate writable package caches. Exact Corepack manager executables are provisioned into a separate per-lane store, then remounted read-only for install, build, lockfile, pack, and test phases.
- Containers run as the host's non-root UID/GID with all Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem, bounded tmpfs, no privileged mode, and no Docker socket mount.
- Containers receive CPU, memory, process-count, log-output, and wall-clock limits. Candidate tarballs are bounded to 50 MiB compressed, 200 MiB unpacked, and 20,000 headers. Docker containers are named and forcibly cleaned after failures or timeouts; `--init` reaps child processes.
- Each lane has only its workspace and its own writable cache mounted. No shared writable package cache exists across lanes.
- Only a small environment allowlist is forwarded. Names containing `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `CREDENTIAL`, or `AUTH` are rejected. `GITHUB_TOKEN`, registry configuration, SSH agents, Git credentials, and host package-manager configuration are not mounted or forwarded.
- Git runs with prompts and credential helpers disabled and a disposable global configuration.
- Test phases use Docker `--network none`; only loopback remains.
- Candidate lockfile generation disables lifecycle scripts with manager flags and a fail-closed environment override. Candidate and baseline fresh installs intentionally run lifecycle scripts because consumer behavior can depend on them.
- The candidate tarball is checked for `package/package.json`, identity, traversal, absolute paths, checksums, entry types, and escaping links. The installed package's file bytes and links are compared with the validated tarball.
- The original checkout is never a lane. Original fixture/consumer files are rehashed, candidate changes are restricted to the planned manifest field and expected lockfile, and output logs are bounded and redacted.

## Residual risks

Dependency installation needs outbound network access to retrieve public packages. Malicious install scripts can make network requests, attack a registry or dependency, consume the allowed resources, fill the host-backed temporary workspace before timeout, and exploit a Docker/kernel/runtime vulnerability. Public registries can return compromised content. Docker daemon compromise could affect its host. DNS and registry metadata leak the packages being installed. Build and test commands can read the files mounted in their own isolated workspace, including the candidate tarball.

Git checkout occurs on the host using the system Git client, but no repository hooks, submodules, or credential helpers run. Tarball parsing happens on the host against bounded package output; malformed archives are treated as tool errors.

GitHub-hosted runners are required because they are ephemeral. Self-hosted runners are explicitly unsupported. Keep workflows on `pull_request`, grant only `contents: read`, pass no secrets, and pin every action by full commit SHA.
