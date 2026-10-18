# Release guide

Releases use the existing GitHub Actions trusted-publishing workflow. A pushed
`v*` tag triggers `.github/workflows/release.yml`, verifies the package version,
runs tests and the adapter check, and publishes to npm with provenance.
GitHub release notes are created separately. No npm token belongs in the repo.

## Prepare on main

1. Review all intended changes and the working tree. Keep the release on `main`.
2. Set `package.json` to the new version and update `DASHBOARD_VERSION` in
   `dashboard.html`. Keep SDK minimum/pin changes separate from package version
   changes unless compatibility testing supports them.
3. Group the changelog into user-facing changes, update affected guides and
   landing-page copy, and rebuild the site with `npm run sync:docs`. It copies the
   dashboard, renders the Markdown guides into `docs/`, and stamps the package
   version and FAQ data into the landing page.
4. Run `npm run check`, `node scripts/validate-adapter.mjs @roamhq/wrtc`, and
   `npm pack --dry-run`. Confirm new user guides are included in `package.json`'s
   `files` list and that secrets, scratch files, and local state are excluded.
5. For transport changes, use the repository's live room/swarm validators in
   isolated test rooms. Never use a real streaming channel as a release test.
   Use the [recovery validator](recovery-validation.md) for controlled message
   loss/restart checks and verified TURN-only transfers.

The CI matrix checks Node 20, 22, and 24 with `@roamhq/wrtc` and
`node-datachannel`; separate Node 24 jobs check current-npm installs. Wait for
those jobs to pass before tagging. Local Windows validation complements those
Linux checks. Avoid running a build while a live validator uses `dist`: the
prebuild script recreates that directory.

## Publish and verify

For an example version `0.2.3`:

```bash
git add -A
git commit -m "Release v0.2.3"
git push origin main
# Wait for CI, then tag the exact tested commit.
git tag -a v0.2.3 -m "ninja-p2p v0.2.3"
git push origin v0.2.3
gh run list --workflow release.yml
# Wait for a successful npm publish before announcing the release.
gh release create v0.2.3 --verify-tag --title "ninja-p2p v0.2.3" --notes-file release-notes.md
npm view @vdoninja/ninja-p2p version
git status --short
```

Prepare the notes file from that version's changelog; keep temporary notes outside
the tracked tree. Check the GitHub Pages deployment and installed package version
after publication. The site is served from `docs/`; metadata-only changes need
no dashboard behavior change. Keep room dashboard pages out of search indexes.

If publishing fails, inspect the Actions log first. Do not move a published tag
or overwrite an npm version. Correct the problem, then use a new patch version
when the existing version has already been published.
