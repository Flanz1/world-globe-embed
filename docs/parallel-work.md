# Working on several branches at once

Many feature branches are open at the same time. These habits keep them merging cleanly.

## Before you say a PR is ready, and after every rebase

```sh
npm run preflight            # behind main? conflicts? generated validators fresh? which e2e suites?
npm run e2e -- --changed     # run only the e2e suites your changes need
```

`npm run preflight -- --fix` regenerates `worker/src/generated/validators.js` if it is stale.

## Generated files

`worker/src/generated/validators.js` is built from `schema/*.json`. Never resolve a conflict in it by hand:
take either side, run `npm run worker:validators`, and commit the result. CI fails early if it is out of date.

## Adding an e2e suite

Create `scripts/e2e/<name>.mjs` with this first line, and you're done:

```js
// e2e-suite: roots=VIEWER,src/admin/preview.ts weight=2
```

- `roots`: the entry files the suite's page loads. Use the groups `ADMIN`, `EDITOR`, `VIEWER` and `WORKER`
  (defined in `scripts/e2e/select.mjs`) or repo paths. A suite with `EDITOR` counts as an editor suite.
- `weight`: a rough runtime from 1 (quick) to 9 (slowest). Slow suites start first.

There's no shared list to edit, so two branches that each add a suite don't conflict. Run a suite with
`npm run e2e -- <name>`; a separate `e2e:<name>` script in package.json isn't needed. A browser check that
is only run by hand starts with `// e2e-tool: <why>` instead.

## Hot files

These files are touched by most features, so a change to them conflicts most often: `src/viewer/globe.ts`,
`src/viewer/flat.ts`, `src/admin/main.ts`, `admin/index.html`, `src/admin/admin.css`, `worker/src/handler.ts`.
Keep the edits there small (an import and a one-line hook call) and put the feature's code in its own module.
When two open PRs touch the same hot file, they merge one at a time, and the second rebases before it merges.
