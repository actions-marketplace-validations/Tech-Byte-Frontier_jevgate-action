#!/usr/bin/env bash
# check.sh gives JevGate api-key in the variable it reads for api-key-kind,
# and no other kind's key; it stops before checking when the installed
# JevGate predates gateway keys. A stand-in jevgate records the key
# variables it was given.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat > "$work/bin/jevgate" << 'EOF'
#!/usr/bin/env bash
if [ "$1" = --version ]; then
    echo "jevgate $STUB_VERSION"
    exit 0
fi
for name in TYPESAFE_API_KEY OPENROUTER_API_KEY AI_GATEWAY_API_KEY; do
    if [ -n "${!name:-}" ]; then echo "$name=${!name}"; fi
done > "$STUB_SEEN"
EOF
chmod +x "$work/bin/jevgate"

# The exit code of check.sh given api-key KEY of KIND with JevGate VERSION and
# the job's key variables VAR=VALUE..., then the key variables the check saw.
check() {
    local kind=$1 version=$2 key=$3 code=0 seen
    shift 3
    : > "$work/seen"
    (cd "$work" && env -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY -u AI_GATEWAY_API_KEY "$@" \
        PATH="$work/bin:$PATH" STUB_VERSION="$version" STUB_SEEN="$work/seen" \
        GITHUB_OUTPUT="$work/output" RUNNER_TEMP="$work" BASE= FORMAT=agent ARGS= \
        SARIF_FILE= API_KEY="$key" API_KEY_KIND="$kind" bash "$here/../check.sh" > /dev/null 2>&1) || code=$?
    seen=$(tr '\n' ' ' < "$work/seen")
    echo "exit $code${seen:+ ${seen% }}"
}

failed=0
# expect EXPECTED KIND VERSION KEY [VAR=VALUE...]
expect() {
    local expected=$1 actual
    shift
    actual=$(check "$@")
    if [ "$actual" != "$expected" ]; then
        echo "::error::check $*: expected '$expected', got '$actual'"
        failed=1
    fi
}

expect "exit 0 TYPESAFE_API_KEY=k" typesafe 0.25.0 k
expect "exit 0 OPENROUTER_API_KEY=k" openrouter 0.26.0 k
expect "exit 0 AI_GATEWAY_API_KEY=k" vercel 0.26.0 k
expect "exit 0 AI_GATEWAY_API_KEY=k" vercel 1.0.0 k
expect "exit 2" openrouter 0.25.0 k
expect "exit 2" anthropic 0.26.0 k
# Keys the job holds for other services never reach JevGate.
expect "exit 0 TYPESAFE_API_KEY=k" typesafe 0.26.0 k OPENROUTER_API_KEY=job AI_GATEWAY_API_KEY=job
# With no api-key, the job's own key of that kind is used.
expect "exit 0 OPENROUTER_API_KEY=job" openrouter 0.26.0 "" OPENROUTER_API_KEY=job TYPESAFE_API_KEY=job
exit "$failed"
