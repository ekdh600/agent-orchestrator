#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

has_top_level_image() {
  local file="$1"

  if command -v yq >/dev/null 2>&1; then
    [[ "$(yq e 'has("image")' "$file")" == "true" ]]
    return
  fi

  python3 - "$file" <<'PY'
import sys
import yaml

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = yaml.safe_load(f)

sys.exit(0 if isinstance(data, dict) and "image" in data else 1)
PY
}

main() {
  local failed=0
  local file

  while IFS= read -r file; do
    if has_top_level_image "$file"; then
      printf 'ERROR: top-level image key is not allowed in PROD values: %s\n' "$file" >&2
      failed=1
    fi
  done < <(find apps -type f -name values-prod.yaml | sort)

  if [[ "$failed" -ne 0 ]]; then
    exit 1
  fi
}

main "$@"
