# Contributing

Thank you for helping improve Downstream Canary.

## Development contract

- Use the pinned Node.js and npm versions in [`docs/compatibility.md`](docs/compatibility.md).
- Install with `npm ci`; do not silently update the lockfile.
- Spawn untrusted project commands without a shell and only through the hardened Docker runner.
- Preserve deterministic classification. AI or heuristic decisions must never affect blocking status.
- Keep runtime dependencies small, exact, and justified.
- Do not weaken exact-SHA, public-repository, secret isolation, frozen-install, tarball verification, or lane-separation checks.
- Update schemas and docs with public contract changes.

Run the full gate before submitting a change:

```console
npm ci
npm run test:all
```

The Docker integration matrix is required for changes to execution, adapters, injection, reporting, fixtures, or security controls. Rebuild and commit `dist/`; `npm run check:dist` must prove it matches source.

Use focused commits and explain security or compatibility tradeoffs. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted under Apache-2.0.
