# JevGate action

Runs [JevGate](https://github.com/Tech-Byte-Frontier/jevgate), a code-review gate, on pull requests. It reviews only the files a pull request changes, annotates the changed lines with each finding, lists them all in one pull request comment, writes a job summary and fails the job when the gate fails.

```yaml
name: JevGate
on: pull_request
permissions:
  contents: read
  pull-requests: write # the comment
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
          version: 0.30.0
```

The action installs a release binary (checked against its SHA-256), keeps JevGate's answer cache in the Actions cache so unchanged code costs nothing (and removes one the pull request commits, whose answers could clear its own code), and runs `jevgate check --base <pull request base> --format github`. It needs no Rust toolchain and runs on Linux, macOS and Windows runners.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `api-key` | | TypeSafe API key ([get one](https://console.typesafe.ai/settings/keys)), or an OpenRouter or Vercel AI Gateway key with `api-key-kind`. Save it as a repository secret |
| `api-key-kind` | `typesafe` | Which service issued `api-key`: `typesafe`, `openrouter` or `vercel` (the gateways need JevGate 0.26.0 or later) |
| `version` | `latest` | JevGate version; pin one for repeatable results |
| `base` | the pull request's base commit | Review only what changed since this revision: from JevGate 0.26.0 the changed lines of changed files (`--whole-files` in `args` for whole files), before it changed files whole; empty on other events, which review the whole repository |
| `args` | | More `jevgate check` arguments, such as `--rule default --rule security --include-tests` |
| `format` | `github` | `github`, `agent`, `json`, `jsonl`, `sarif` or `gitlab` |
| `sarif-file` | | Also write the findings as SARIF to this path, for `upload-sarif` (JevGate 0.18.0 or later) |
| `comment` | `true` | On pull requests, list every finding in [one comment](#the-pull-request-comment), updated on each run |
| `cache` | `true` | Keep answers in the Actions cache |
| `working-directory` | `.` | Repository root to check |

## Outputs

| Output | Meaning |
|---|---|
| `exit-code` | `0` gate passed, `1` gate failed, `2` run incomplete |
| `report` | Path of the full JSON report (`.jevgate/latest.json`), to upload as an artifact |

## The pull request comment

GitHub shows at most 10 error and 10 warning annotations per step, so on pull requests the action also lists every finding in one comment and updates it on each run. Reviews come first, then considers, then notes (collapsed), each grouped by file with a link to the line. The comment gives the gate's result and the run's API requests, input tokens and cost; from JevGate 0.26.0 it also marks each finding that fails the gate and counts those reported without failing it while their rules are still being measured, and from 0.28.0 each finding ends with how often findings of its rule and level were right on projects JevGate was never tuned on. When the run could not finish (exit code 2: no key, a provider error such as HTTP 402, or the request budget), it says so first, with the reasons.

- It needs `pull-requests: write`. Where the token can't comment, as on pull requests from forks, the run says so in the log and the job summary and carries on.
- Each job, and each `working-directory`, keeps its own comment; the jobs of a matrix share one. A run for an older push never replaces a newer run's comment.
- A run too large for one comment (GitHub's limit is 65,536 characters) leaves out notes first, then the lowest-ranked considers, and says how many; the JSON report (the `report` output) keeps them all.
- `comment: false` turns it off.

## Code scanning

`sarif-file` also writes the findings as SARIF, replayed from the answers the check just cached, so it costs nothing. Upload it to show them in the repository's Security tab and on pull requests (needs JevGate 0.18.0 or later):

```yaml
permissions:
  contents: read
  pull-requests: write
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

## Keys from OpenRouter or Vercel AI Gateway

OpenRouter and Vercel AI Gateway also serve Jev. With JevGate 0.26.0 or later, pass their key and say which it is; the action gives it to JevGate as `OPENROUTER_API_KEY` or `AI_GATEWAY_API_KEY`, and no other kind's key, so a key the job holds for something else is never used:

```yaml
      - uses: Tech-Byte-Frontier/jevgate-action@v1
        with:
          api-key: ${{ secrets.OPENROUTER_API_KEY }}
          api-key-kind: openrouter # or vercel
          version: 0.30.0
```

With an older version the check stops with an error instead of running without a key.

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
