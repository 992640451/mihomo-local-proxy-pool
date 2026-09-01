$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectRoot '.env'
if (-not (Test-Path -LiteralPath $EnvFile)) { throw ".env not found: $EnvFile" }
Get-Content -LiteralPath $EnvFile | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$env:MIHOMO_HOST_CONFIG_PATH = Join-Path $env:CATALOG_SOURCE 'clash-verge.yaml'
$env:MIHOMO_BRIDGE_HOST = '0.0.0.0'
$env:MIHOMO_BRIDGE_PORT = '9098'
Set-Location -LiteralPath $ProjectRoot
& node server/mihomoBridge.mjs
