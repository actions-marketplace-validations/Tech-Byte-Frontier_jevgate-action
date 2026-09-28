# JevGate action

Runs [JevGate](https://github.com/Tech-Byte-Frontier/jevgate), a code-review gate, on pull requests. It reviews only the files a pull request changes, annotates the changed lines with each finding, writes a job summary and fails the job when the gate fails.

```yaml
name: JevGate
on: pull_request
permissions:
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # --base compares with the fork point
      - uses: Tech-Byte-Frontier/jevgate-action@v1
        with:
          api-key: ${{ secrets.TYPESAFE_API_KEY }}
          version: 0.25.0
```

The action installs a release binary (checked against its SHA-256), keeps JevGate's answer cache in the Actions cache so unchanged code costs nothing, and runs `jevgate check --base <pull request base> --format github`. It needs no Rust toolchain and runs on Linux, macOS and Windows runners.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `api-key` | | TypeSafe API key. [Get one](https://console.typesafe.ai/settings/keys) and save it as a repository secret |
| `version` | `latest` | JevGate version; pin one for repeatable results |
| `base` | the pull request's base commit | Review only files changed since this revision; empty on other events, which review the whole repository |
| `args` | | More `jevgate check` arguments, such as `--rule default --rule security --include-tests` |
| `format` | `github` | `github`, `agent`, `json`, `jsonl`, `sarif` or `gitlab` |
| `sarif-file` | | Also write the findings as SARIF to this path, for `upload-sarif` (JevGate 0.18.0 or later) |
| `cache` | `true` | Keep answers in the Actions cache |
| `working-directory` | `.` | Repository root to check |

## Outputs

| Output | Meaning |
|---|---|
| `exit-code` | `0` gate passed, `1` gate failed, `2` run incomplete |
| `report` | Path of the full JSON report (`.jevgate/latest.json`), to upload as an artifact |

## Code scanning

`sarif-file` also writes the findings as SARIF, replayed from the answers the check just cached, so it costs nothing. Upload it to show them in the repository's Security tab and on pull requests (needs JevGate 0.18.0 or later):

```yaml
permissions:
  contents: read
  security-events: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: Tech-Byte-Frontier/jevgate-action@v1
        with:
          api-key: ${{ secrets.TYPESAFE_API_KEY }}
          sarif-file: jevgate.sarif
      - uses: github/codeql-action/upload-sarif@v4
        if: always()
        with:
          sarif_file: jevgate.sarif
          category: jevgate
```

## Pull requests from forks

GitHub doesn't give secrets to pull requests from forks, so the run there ends incomplete with "No API key configured". Skip the job for them:

```yaml
jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
```

## Advisory mode

To report findings without failing the job, pass `args: --fail-on none`, or set `fail_on = ["none"]` in `jevgate.toml`. A run that could not finish still fails, so an outage never passes as a clean review.

Configuration, rules and exit codes are described in [JevGate's README](https://github.com/Tech-Byte-Frontier/jevgate#readme).

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT) at your option.
