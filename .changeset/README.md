# Changesets

This folder holds [changesets](https://github.com/changesets/changesets): small Markdown files
describing changes, which become version bumps and changelog entries on release.

Add one with `npx changeset` in any pull request that changes the published package. When
changesets land on `main`, the release workflow opens (or updates) a "Version Packages" pull
request; merging it publishes the new version to npm.
