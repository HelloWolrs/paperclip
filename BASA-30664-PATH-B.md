# BASA-30664 Path B — durable delivery of BAA Slice C via own npm scope

## Status

**Ready to ship after one small PAT scope bump.**

`GITHUB_TOKEN_FORK` (fine-grained PAT, `Contents: R/W`, provisioned in [BASA-30678](../issues/BASA-30678)) can push code but **cannot commit files under `.github/workflows/`** — GitHub gates that at both the Contents API and the Git Data API, requiring an additional `Workflows: write` scope. Verified this branch: regular-file PUT returned 201; workflow-file PUT and git-data tree write both returned `403 Resource not accessible by personal access token`.

**Ask on the human board:** open the existing PAT `paperclip-fork-write` at https://github.com/settings/personal-access-tokens → **Permissions → Repository permissions → Workflows** dropdown → change from **No access** → **Read and write** → Update. Same PAT, no token rotation needed. Takes ~30 sec. Then a follow-up PR will land the workflow file below.

## What Path B ships

A `workflow_dispatch`-only workflow that publishes `server/` (the `@paperclipai/server` package with Slice C at `server/src/index.ts:861-874`) under the `@basysanalytics` npm scope as `@basysanalytics/paperclip-server`. Default input is `dry_run: true` (pnpm pack only) so the first dispatch is a safe rehearsal.

- **No source rename in the fork.** The rename is CI-side only — `server/package.json` stays named `@paperclipai/server` in `master` so the existing pnpm workspace stays coherent for local dev.
- **No touch to existing workflows.** `release.yml` / `pr.yml` etc. are unchanged. The existing `release.yml` will still fire on `push: master` and attempt to publish `@paperclipai/*` packages using `NPM_TOKEN` — but that token is now scoped to `@basysanalytics`, so the existing publish steps will fail. A follow-up PR should add a `if: github.repository == 'paperclipai/paperclip'` guard on `release.yml` in the fork, or delete it. Non-blocking for this PR since the new workflow is `workflow_dispatch` only.
- **npm publish inside a workspace.** `pnpm publish` from `server/` handles `workspace:*` dep rewriting at pack time (this is standard pnpm behavior; validated that `@paperclipai/server@0.3.1` already exists on npm published via the same infrastructure).

## Workflow to add — `.github/workflows/basys-server-publish.yml`

```yaml
name: Publish @basysanalytics/paperclip-server

on:
  workflow_dispatch:
    inputs:
      version:
        description: "Version to publish (semver, e.g. 0.1.0)"
        required: true
        default: "0.1.0"
      dry_run:
        description: "Dry run (npm pack only, no publish)"
        required: false
        type: boolean
        default: true

concurrency:
  group: basys-server-publish
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9.15.4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: 'https://registry.npmjs.org'
          cache: pnpm

      - name: Configure npm auth
        run: |
          echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$HOME/.npmrc"
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Install workspace dependencies
        run: pnpm install --no-frozen-lockfile

      - name: Build UI (produces ui-dist consumed by server prepack)
        run: pnpm --filter @paperclipai/ui run build

      - name: Build server
        run: pnpm --filter @paperclipai/server run build

      - name: Rewrite server/package.json for @basysanalytics scope
        run: |
          node -e "
          const fs = require('fs');
          const p = JSON.parse(fs.readFileSync('server/package.json', 'utf8'));
          p.name = '@basysanalytics/paperclip-server';
          p.version = process.env.VERSION;
          p.homepage = 'https://github.com/HelloWolrs/paperclip';
          p.bugs = { url: 'https://github.com/HelloWolrs/paperclip/issues' };
          p.repository = { type: 'git', url: 'https://github.com/HelloWolrs/paperclip', directory: 'server' };
          fs.writeFileSync('server/package.json', JSON.stringify(p, null, 2) + '\n');
          console.log('rewrote server/package.json:', p.name, p.version);
          "
        env:
          VERSION: ${{ inputs.version }}

      - name: Pack (dry run)
        if: ${{ inputs.dry_run == true }}
        run: |
          cd server
          pnpm pack --pack-destination ..
          ls -la ../*.tgz
          echo "--- pack contents ---"
          tar tzf ../basysanalytics-paperclip-server-*.tgz | head -20 || true

      - name: Publish to npm
        if: ${{ inputs.dry_run == false }}
        run: |
          cd server
          pnpm publish --access public --no-git-checks
```

## Delivery sequence after PAT scope bump

1. `curl -X PATCH .github/workflows/basys-server-publish.yml` on this branch (via same PAT, now with Workflows: write) — commits the .yml above.
2. Mark this PR ready for review.
3. Someone with HelloWolrs write clicks **Merge** on master.
4. From HelloWolrs/paperclip → Actions tab → "Publish @basysanalytics/paperclip-server" → Run workflow → `version: 0.1.0`, `dry_run: true` → observe pack contents.
5. Re-run with `dry_run: false` → publishes to npm.
6. Verify: `curl -s https://registry.npmjs.org/@basysanalytics/paperclip-server | jq '.["dist-tags"]'` → `{"latest":"0.1.0"}`.
7. Update [BASA-30662](../issues/BASA-30662): swap Marcus's runtime from in-place dist splice to `npx @basysanalytics/paperclip-server run` (or equivalent CLI shim).

## What this does NOT do

- Does not publish `paperclipai` (the CLI). If Marcus's launcher stays `npx paperclipai run`, we either need to also fork/publish `cli/` under BAA scope, or ship a small basys CLI wrapper. Out of scope for this PR.
- Does not touch `release.yml`. The follow-up "add repo guard" PR is separate.
- Does not verify that `pnpm publish` from `server/` correctly rewrites all 13 `workspace:*` deps to actual versions. That's what `dry_run: true` is for.

## Blast radius

Two-way door across the board:
- **Delete this workflow** → nothing on npm changes retroactively.
- **Delete the published package** (npm unpublish, or deprecate) → registry cleared, no ongoing charges.
- **Delete the `@basysanalytics` org** → package disappears, revertible with a re-publish under any other name.
