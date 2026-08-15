# npm `folder-structure-sync@1.1.0` recovery

The checked-in archive [folder-structure-sync-1.1.0.tgz](./folder-structure-sync-1.1.0.tgz) is the byte-for-byte tarball recovered from the public npm registry on 2026-08-15. It is retained as migration evidence only; it is not a workspace package or a future release entry point.

## Registry provenance and integrity

The registry metadata returned the following values:

| Field | Value |
| --- | --- |
| Tarball | `https://registry.npmjs.org/folder-structure-sync/-/folder-structure-sync-1.1.0.tgz` |
| `dist.integrity` | `sha512-DMLwBKls8g/9ZSx2iSTW6ChOkuZSFjoe8cnn3k1NO7oM0D0sRNGXy2GuipFqhtukoUGwI1YdfENsHfzCZTjY1w==` |
| `dist.shasum` | `5cbc1470b492f36bad11653f2b8545a62daf5929` |
| `gitHead` | `a9cb35279f65db6e939c884a0503f2e13b3a5d93` |

The downloaded archive verified with both commands:

```text
$ shasum -a 1 docs/baseline/folder-structure-sync-1.1.0.tgz
5cbc1470b492f36bad11653f2b8545a62daf5929  docs/baseline/folder-structure-sync-1.1.0.tgz

$ openssl dgst -sha512 -binary docs/baseline/folder-structure-sync-1.1.0.tgz | openssl base64 -A
DMLwBKls8g/9ZSx2iSTW6ChOkuZSFjoe8cnn3k1NO7oM0D0sRNGXy2GuipFqhtukoUGwI1YdfENsHfzCZTjY1w==
```

## Unreachable original Git head

The registry records `a9cb35279f65db6e939c884a0503f2e13b3a5d93` as the publish head, but it is not present in this clone:

```text
$ git cat-file -e a9cb35279f65db6e939c884a0503f2e13b3a5d93^{commit}
fatal: Not a valid object name a9cb35279f65db6e939c884a0503f2e13b3a5d93^{commit}

$ git branch -a --contains a9cb35279f65db6e939c884a0503f2e13b3a5d93
error: no such commit a9cb35279f65db6e939c884a0503f2e13b3a5d93
```

This recovery is a new commit and does not amend, reset, or otherwise rewrite repository history.

## Legacy behavior retained for migration

The complete published source remains available inside the checked-in archive. The existing root `index.js` and `sync-config.json` are intentionally left untouched as the pre-workspace migration evidence.

In the recovered `1.1.0` source, recursive scanning checks for a `.ignore` file before reading a directory. Its presence stops scanning that directory and all of its descendants; a nested directory has already been discovered by its parent, so the marker prunes children rather than the nested directory itself. Future core work must preserve that pruning semantics deliberately, rather than changing legacy history to retrofit it.

## Related

- [Rootline documentation](../README.md) - Documentation navigation.
- [Migration to 2.0.0](../migration-v1-to-v2.md) - Safe user upgrade sequence.
- [Rootline Desktop + CLI v2 implementation plan](../superpowers/plans/2026-08-15-rootline-desktop-cli-v2.md) - The migration plan this evidence supports.
