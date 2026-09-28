#!/usr/bin/env bash
# Run `jevgate check` and pass its exit code on: 0 passed, 1 failed, 2 incomplete.
set -uo pipefail

report=.jevgate/latest.json
version=$(jevgate --version 2> /dev/null)
# This run's report for the comment step, empty when the check wrote none.
comment_report=

# A path Node can open: on Windows, Git Bash's $PWD (/d/a/...) is not one.
native() {
    if command -v cygpath > /dev/null; then cygpath -m "$1"; else echo "$1"; fi
}

# Write the step's outputs, then exit with CODE.
finish() {
    {
        echo "exit-code=$1"
        echo "report=$(native "$PWD")/$report"
        echo "comment-report=$comment_report"
        echo "commit=$(git rev-parse HEAD 2> /dev/null)"
        echo "prefix=$(git rev-parse --show-prefix 2> /dev/null)"
        echo "version=$version"
    } >> "$GITHUB_OUTPUT"
    exit "$1"
}

# The key goes in the variable JevGate reads for its kind.
case "$API_KEY_KIND" in
    typesafe) key_variable=TYPESAFE_API_KEY ;;
    openrouter) key_variable=OPENROUTER_API_KEY ;;
    vercel) key_variable=AI_GATEWAY_API_KEY ;;
    *)
        echo "::error::api-key-kind is typesafe, openrouter or vercel, not $API_KEY_KIND."
        finish 2
        ;;
esac
if [ "$API_KEY_KIND" != typesafe ]; then
    # Older versions read only TYPESAFE_API_KEY and would say no key is configured.
    IFS=. read -r major minor _ <<< "${version##* }"
    if [ "$major" = 0 ] && [ "${minor:-0}" -lt 26 ] 2> /dev/null; then
        echo "::error::api-key-kind: $API_KEY_KIND needs JevGate 0.26.0 or later; this is ${version##* }."
        finish 2
    fi
fi
# Only a key that was given, so an empty input leaves one set in the job's env.
if [ -n "$API_KEY" ]; then
    export "$key_variable=$API_KEY"
fi
# And only that kind's: a key the job holds for another service is never spent.
for variable in TYPESAFE_API_KEY OPENROUTER_API_KEY AI_GATEWAY_API_KEY; do
    if [ "$variable" != "$key_variable" ]; then unset "$variable"; fi
done

command=(jevgate check)
if [ -n "$BASE" ]; then
    if ! git cat-file -e "$BASE^{commit}" 2> /dev/null; then
        echo "::error::The base revision $BASE is not in the checkout. Check out with fetch-depth: 0 so --base can find the fork point."
        finish 2
    fi
    command+=(--base "$BASE")
fi
# Extra arguments are split on spaces, as written in the workflow.
read -r -a extra <<< "$ARGS"
command+=(${extra[@]+"${extra[@]}"})

# Each report JevGate writes is a new generation, so its checksum changes;
# one left from an earlier check is not this run's.
before=
if [ -f "$report" ]; then before=$(cksum < "$report"); fi
"${command[@]}" --format "$FORMAT"
code=$?
if [ -f "$report" ] && [ "$(cksum < "$report")" != "$before" ]; then
    # Saved before the SARIF replay publishes its own, which sent no request.
    saved="$RUNNER_TEMP/jevgate-report-$$.json"
    cp "$report" "$saved" && comment_report=$saved
fi

# The same check again from the answers just cached: no request is sent.
if [ -n "${SARIF_FILE:-}" ]; then
    "${command[@]}" --cache-only --format sarif > "$SARIF_FILE"
    replay=$?
    if [ "$replay" -gt 1 ]; then
        echo "::warning::Could not write $SARIF_FILE (exit $replay); --format sarif needs JevGate 0.18.0 or later."
    fi
fi

if [ "$code" = 2 ] && [ -z "${!key_variable:-}" ]; then
    echo "::error::No API key. Pass api-key: \${{ secrets.$key_variable }}. Pull requests from forks don't receive secrets; skip the job for them."
fi
finish "$code"
