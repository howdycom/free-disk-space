# Free Disk Space

Composite GitHub Action that reclaims disk space on a GitHub-hosted runner
before large Docker builds. It deletes preinstalled toolchains you almost
certainly don't need in CI, then prunes Docker images and the builder cache,
printing `df -h /` before and after so the reclaimed space is visible in the
log.

Licensed under the [MIT License](LICENSE).

## Usage

Run it as the **first step** of a job that builds large images, before any
`setup-*` step:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: howdycom/free-disk-space@v1
      - uses: actions/setup-node@v4
        # ... your docker build steps
```

No inputs, no outputs.

## What it removes

| Path | Contents |
|---|---|
| `/opt/ghc` | Glasgow Haskell Compiler |
| `/opt/hostedtoolcache` | Pre-cached toolchains (Python, Node, Go, …) |
| `/usr/local/.ghcup` | Haskell toolchain installer |
| `/usr/local/lib/android` | Android SDK |
| `/usr/local/share/boost` | Boost C++ libraries |
| `/usr/share/dotnet` | .NET SDK |
| `/usr/share/swift` | Swift toolchain |

Plus `docker image prune --all --force` and `docker builder prune --all --force`
(both best-effort — a failure there never fails your job).

## Notes

- GitHub-hosted Ubuntu runners only. The script assumes `sudo` without a
  password and Docker preinstalled, which is the hosted-runner default. Do
  not run this on a self-hosted runner unless you are sure nothing on it
  needs the paths above.
- Because `/opt/hostedtoolcache` is deleted, run this step **before**
  `actions/setup-*`: a toolchain requested afterwards is downloaded on
  demand, costing a little time once instead of disk for every build.
- Pin to a tag (`@v1`), never to `main`.

## Versioning

Changes are tagged with semver (`v1`, `v1.1`, …). The major tag (`v1`) moves
to the latest compatible release; breaking changes bump the major version.
Don't reference `main` from a consumer workflow.

## Contributing

Changes go through a PR, not direct pushes to `main`. This action runs with
`sudo` in consuming repos, so deletions from the path list above need review
scrutiny — never add a path outside the preinstalled toolchain set.
