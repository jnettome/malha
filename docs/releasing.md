# Releasing Malha

A release is a git tag. Pushing `vX.Y.Z` runs the Release workflow, which checks and tests the tagged commit, publishes `@malha/cli` to npm, and creates a GitHub Release with the same package attached as a `.tgz` and the version's changelog section as its notes.

No secret is stored for this. npm accepts the package through [trusted publishing](https://docs.npmjs.com/trusted-publishers): the workflow proves with a short-lived GitHub OIDC token that it is `release.yml` in `jnettome/malha`, and npm records [provenance](https://docs.npmjs.com/generating-provenance-statements) linking each version to the commit and workflow run that built it.

## Once: setting up npm

The package is `@malha/cli`, in the npm organization `malha` (npm refused the unscoped name `malha` as too similar to `mocha` and `hasha`; scoped names aren't checked). The command it installs is still `malha`.

npm sets trusted publishers per package, so the very first version goes up by hand, from an account in the `malha` organization (npmjs.com → Add Organization, free for public packages):

```bash
git checkout v0.6.0            # the first version on npm, tagged as usual
npm ci && npm run build
npm login                      # with two-factor authentication on
npm publish --provenance=false # provenance needs CI; later versions have it
```

Then on npmjs.com: the `@malha/cli` package → Settings → Trusted publishing → GitHub Actions, with owner `jnettome`, repository `malha` and workflow `release.yml`. Under "Publishing access", require two-factor authentication and disallow tokens: from then on only the workflow can publish. If npm offers to add the trusted publisher before the package exists, do that instead and skip the manual publish.

## Choosing the version

Malha is 0.x, so:

- **Minor** (0.2.0 → 0.3.0) for new features and for anything that breaks: a schema change that makes existing topology files invalid, a removed or renamed command or option, a change to the plugin API (`src/plugins/sdk.ts`) or to `malha-plugin.json`.
- **Patch** (0.2.0 → 0.2.1) for fixes that change nothing else.

Say what breaks, and how to adapt, in the changelog.

## As you work

Add a line under `## Unreleased` at the top of `CHANGELOG.md` with each change worth telling users about. The release turns that heading into the version.

## Cutting a release

From an up-to-date `main` with a clean working tree:

```bash
npm run release -- 0.2.0          # checks, tests, bumps, commits and tags; does not push
git push origin main v0.2.0       # publishes
```

`npm run release -- 0.2.0 --push` does both. The script ([scripts/release.mjs](../scripts/release.mjs)) stops at the first problem, before changing anything:

1. The version is newer than `package.json`'s, and the tag does not exist here or on GitHub.
2. You are on `main`, nothing is uncommitted, and `main` matches `origin/main`.
3. `CHANGELOG.md` has a non-empty `## Unreleased` section.
4. `npm run typecheck`, `npm test`, `npm run build` and `npm run e2e` pass (`--skip-e2e` skips the browser tests, which CI runs again anyway).

Then it renames `## Unreleased` to `## 0.2.0`, sets the version in `package.json` and `package-lock.json`, commits "Release 0.2.0" and creates the annotated tag `v0.2.0`.

## Checking it

```bash
gh run watch --repo jnettome/malha "$(gh run list --repo jnettome/malha --workflow Release --limit 1 --json databaseId -q '.[0].databaseId')"
gh release view v0.2.0 --repo jnettome/malha
npm view @malha/cli version dist-tags   # 0.2.0 is "latest"
```

Then install it the way users do and run it once:

```bash
npm install -g @malha/cli@0.2.0
malha --version && malha validate path/to/topology.yaml
npm audit signatures                 # in a project that depends on malha: checks the provenance
```

## Telling users

Users upgrade with npm, then refresh the editor schema next to their topology:

```bash
npm install -g @malha/cli@latest
malha schema infra
```

A new release changes the code of the plugins that ship with Malha, so their saved approvals reset and they ask again once. That is by design.

## When it goes wrong

- **The workflow failed before "npm publish".** Nothing was published. Delete the tag, fix the problem on `main`, and release the same version again:

  ```bash
  git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0
  git reset --soft HEAD~1      # only if the release commit is the last one and not pushed; else keep it
  ```

- **It failed after "npm publish".** npm never accepts the same version twice, even after an unpublish. Fix forward with a patch release (0.2.1). If only the GitHub Release step failed, create it by hand from the tagged commit: `npm pack`, then `gh release create v0.2.0 malha-0.2.0.tgz --notes-file <the changelog section>`.
- **npm answers 404 or 403 on publish.** The trusted publisher on npmjs.com doesn't match the workflow: check owner, repository and the workflow file name (`release.yml`).
- **"Tag does not match package.json".** The tag was pushed without the release commit. Push `main` too, delete and re-push the tag.

## Without the script

The script only saves typing. By hand: check, test and build; rename `## Unreleased` in `CHANGELOG.md`; `npm version 0.2.0 --no-git-tag-version`; commit; `git tag -a v0.2.0 -m "Malha 0.2.0"`; push `main` and the tag.
