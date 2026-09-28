#!/usr/bin/env bash
# Windows entrypoint for the safe staging wrapper. Git Bash does not expose the
# Windows Credential Manager entry used by the Supabase CLI, so delegate to
# PowerShell instead of falling back to an untrusted .env value.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "Este wrapper requer PowerShell no Windows. Em CI, use SUPABASE_ACCESS_TOKEN explicitamente." >&2
  exit 1
fi

if command -v wslpath >/dev/null 2>&1; then
  script_path="$(wslpath -w "$PWD/scripts/sb-staging.ps1")"
elif command -v cygpath >/dev/null 2>&1; then
  script_path="$(cygpath -w "$PWD/scripts/sb-staging.ps1")"
else
  script_path="$PWD/scripts/sb-staging.ps1"
fi
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$script_path" "$@"
