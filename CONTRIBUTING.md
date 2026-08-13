# Contributing

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

1. Keep generic agent behavior independent of THETA-specific paths and types.
2. Add or update tests for changed contracts.
3. Run `npm run validate` and the relevant CLI or THETA tools test suites.
4. Document user-visible behavior and migration requirements in English.
