# Contributing

## Branches

`dev` is the integration branch for active work. Create short-lived feature or
fix branches from `dev` and merge them back through review. `main` is reserved
for tested, release-ready snapshots promoted from `dev`.

## Language

Repository documentation, README files, source-code comments, commit messages,
and pull-request descriptions must be written in English. Runtime localization
strings and localization tests may use their target language.

## Dependency hygiene

Do not commit third-party repositories, datasets, model files, credentials, or
run artifacts. Use `npm run deps:sync` to reproduce reviewed upstream versions
and `npm run deps:update` to propose an upstream update. Commit only the lock
file after the update has been reviewed and tested.

## Change checklist

1. Start from an up-to-date `dev` branch.
2. Keep generic agent behavior independent of THETA-specific paths and types.
3. Add or update tests for changed contracts.
4. Run `npm run validate` and the relevant CLI or bridge test suites.
5. Document user-visible behavior and migration requirements in English.
