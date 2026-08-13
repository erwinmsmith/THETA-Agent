# CLI fixtures

These files support the commands documented in `docs/CLI.md` and
`docs/CLI.zh-CN.md`.

- `workflow-input.json` starts a V2 workflow from a complete input object.
- `dataset-confirmation.json` resumes the dataset-confirmation wait.
- `plan-adjustment.json` submits a natural-language plan revision.

Plan review, dry-run, and training-start inputs are intentionally not static
fixtures. Their hashes and approval IDs must be created from the same live Run.
Use the conversational workflow to generate this bound chain; do not edit or
reuse receipts from another Run.
