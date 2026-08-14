# CLI Release Checklist

Run releases from a clean checkout of the THETA Agent repository.

## Dependency baseline

- `config/upstreams.lock.json` identifies the reviewed THETA repository,
  branch, and exact revision.
- `npm run deps:sync` reports THETA at its pinned revision.
- The ignored THETA checkout has a clean working tree.
- Every `@codesoul-co/hypha-*` dependency resolves from the npm registry on
  one release version; `npm run doctor` reports the aligned release line.

## Agent validation

Run from the repository root:

```bash
npm run validate
pnpm install --frozen-lockfile
pnpm --dir apps/cli run release:verify
```

The release gate type-checks the runtime source, runs the Python THETA tools tests,
builds the CLI, and loads the command surface.

## Safety verification

- No secret, dataset, model, runtime database, result, or upstream source is
  present in the Git index.
- `third_party/` remains ignored and no Git submodule is configured.
- Approval gates still protect plan creation, training start, cancellation,
  and approved external inference.
- The deterministic fallback works without a language-provider API key.

## Branch promotion

Merge feature work into `dev`. Promote the tested release commit from `dev` to
`main`, create a version tag, and publish release notes describing user-visible
changes and upstream revision updates.
