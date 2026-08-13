# Maintainer dogfooding

No dogfood library or genuine downstream consumers have been supplied yet. Internal fixtures prove implementation behavior; they are not external adoption, ecosystem demand, or maintainer dogfooding.

## Ready-to-copy workflow

After a Downstream Canary commit is pushed, copy this into the maintained library and replace every placeholder with a verified full SHA:

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
            OWNER/REAL_PUBLIC_CONSUMER@REPLACE_WITH_CONSUMER_FULL_SHA
```

## Consumer-selection checklist

Select one to three repositories that are genuine, maintained public consumers:

- The root `package.json` directly declares the library in `dependencies`, `devDependencies`, or `optionalDependencies`.
- The root has exactly one supported lockfile and a meaningful deterministic test script.
- The project is a single package, not a workspace or monorepo.
- Its current public commit is reproducible, uses no private registry, and needs no secrets.
- Its license and public status permit a normal public clone and test.
- Pin the selected state to an exact lowercase 40-character commit SHA; never use a tag or branch.
- Prefer consumers that exercise distinct real APIs rather than duplicate toy examples.

Provide the local path or public URL of the maintained library when ready. Downstream Canary will then inspect it, identify only verifiable public consumers, prepare the minimal pinned workflow, run locally where possible, and describe the result as maintainer dogfooding—not external adoption.
