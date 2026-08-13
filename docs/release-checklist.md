# v0.1.0 release checklist

This checklist prepares the first release; it does not authorize a commit, push, tag, npm publication, or GitHub release.

## Source and contract

- [ ] Confirm `HEAD` is the reviewed release-candidate commit and the worktree is clean.
- [ ] Confirm the exact Node/npm/pnpm/Yarn and Docker image versions in `docs/compatibility.md` match the tested matrix.
- [ ] Validate both JSON Schemas and confirm report schema `1.0.0` is treated as an exact contract.
- [ ] Review `SECURITY.md`, `docs/threat-model.md`, configuration scope, and residual risks.
- [ ] Regenerate `THIRD_PARTY_NOTICES` and pass `npm run check:notices`.

## Local gates

- [ ] `npm ci --ignore-scripts --no-audit --no-fund`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run integration`
- [ ] `npm run action:smoke`
- [ ] `npm run build`
- [ ] `npm run check:dist`
- [ ] `npm audit --omit=dev --audit-level=moderate`
- [ ] Regression demo exits 1; compatible and pre-existing demos exit 0.

## Hosted proof and publication boundaries

- [ ] Obtain authorization to commit and push the reviewed files.
- [ ] Replace example Action references with the resulting full release-candidate commit SHA.
- [ ] Verify the GitHub-hosted Ubuntu workflow succeeds on `pull_request`; record its public URL.
- [ ] Obtain separate authorization before creating or moving `v0.1.0`, creating a GitHub release, or publishing npm artifacts.
- [ ] If npm publication is authorized, remove or intentionally retain `private: true` only through an explicit reviewed change and verify the packed file list before publication.

## Dogfooding

- [ ] Ask the maintainer for a real library path or public URL.
- [ ] Select one to three genuine public consumers and pin exact 40-character commits.
- [ ] Record only reproducible maintainer-dogfooding results; do not describe internal fixtures as adoption.
