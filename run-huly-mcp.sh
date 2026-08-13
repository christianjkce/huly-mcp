#!/usr/bin/env bash
set -euo pipefail

umask 077
key_file=/srv/projects/key.env
token=$(awk -F= '$1 == "HulyToken" { print substr($0, index($0, "=") + 1); exit }' "$key_file")
if [[ -z "$token" ]]; then
  echo "HulyToken missing" >&2
  exit 1
fi

workspace=$(TOKEN="$token" node --input-type=module -e '
const token = process.env.TOKEN
const parts = token.split(".")
if (parts.length !== 3) process.exit(1)
const payload = JSON.parse(Buffer.from(parts[1], "base64url"))
if (typeof payload.workspace !== "string" || payload.workspace.length === 0) process.exit(1)
process.stdout.write(payload.workspace)
')

exec env \
  HULY_URL=https://huly.jkce.de \
  HULY_TOKEN="$token" \
  HULY_WORKSPACE="$workspace" \
  HULY_TOOL_MODE=auto \
  PROXY_OUTPUT_STRICT=true \
  TOOLSETS='projects,issues,comments,documents,search' \
  node /srv/projects/huly-mcp/dist/index.cjs
