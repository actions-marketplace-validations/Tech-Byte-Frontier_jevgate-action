#!/usr/bin/env bash
# Create a repository at DIR whose last commit adds one function. Its answers
# are never in a cache, so `jevgate check --base HEAD~1 --cache-only` writes a
# report and ends incomplete (exit 2), with no key and nothing sent.
set -euo pipefail

dir=$1
if [ -e "$dir" ]; then
    echo "$dir already exists" >&2
    exit 1
fi
git -c init.defaultBranch=main init -q "$dir"
cd "$dir"
commit() {
    git -c user.name=test -c user.email=test@example.com commit -q "$@"
}
commit --allow-empty -m "Start"
mkdir -p src
cat > src/records.js << 'EOF'
function parseRecord(line, options) {
  const fields = line.split(options.separator || ",");
  const record = {};
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i].trim();
    if (raw === "") {
      continue;
    }
    if (options.numbers && !isNaN(Number(raw))) {
      record[options.columns[i]] = Number(raw);
    } else if (raw === "true" || raw === "false") {
      record[options.columns[i]] = raw === "true";
    } else {
      record[options.columns[i]] = raw;
    }
  }
  return record;
}
module.exports = { parseRecord };
EOF
git add src
commit -m "Parse records"
