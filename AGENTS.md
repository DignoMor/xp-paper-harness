# Paper Harness — code repository

This is the public implementation repository. It is the sibling of the private
control-plane repository at `../private/`, which holds the authoritative
delivery specifications and API contracts.

## Branching and releases

- **`dev` is the integration branch.** All work — features, fixes, refactors —
  is committed and pushed to `dev`.
- **`main` is the release branch.** It advances only through a `dev` → `main`
  pull request opened when a version is released. Release tags are cut on
  `main`.
- **Never push directly to `main`.** No feature or fix commit may be pushed to
  `main` outside a release PR.
- Keep `dev` green: the checks below must pass before pushing.

## Checks before pushing

```sh
npm run typecheck
npm test
npm run build
```

## Environment

- Mutable data lives under the external `PAPER_HARNESS_DATA_ROOT`, never in the
  source tree.
- Credentials come only from environment variables (see `.env.example`) and are
  never committed.
- The service is unauthenticated and must remain loopback-only.
