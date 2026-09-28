[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$SupabaseArgs
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# Force the isolated EleveFlow staging project even when .env contains a
# production SUPABASE_PROJECT_ID. Database credentials remain in the native
# credential manager after Supabase link; CI can override them explicitly.
$env:SUPABASE_PROJECT_ID = 'xlycuunqpgpyfmafgajr'

$avastCa = Join-Path $repoRoot '.avast-ca.pem'
if (Test-Path $avastCa) {
  $env:NODE_EXTRA_CA_CERTS = $avastCa
  $env:SSL_CERT_FILE = $avastCa
}

& npx supabase @SupabaseArgs
exit $LASTEXITCODE
