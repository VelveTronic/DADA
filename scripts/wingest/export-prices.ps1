# Read-only export of Wingest price tiers + units for the DADA portal.
#
# RUN ON SERVER (Windows PowerShell 5.1). It touches the ERP database with ONE
# SELECT: no writes, no schema changes, no locks beyond the read.
#
# Run it as a FILE (.\export-prices.ps1), not by pasting the body into a console:
# the output path is resolved from this script's own location, which a pasted
# body does not have.
#
# Encrypt=False in the connection string is acceptable ONLY because this runs on
# the ERP box itself and talks to localhost over the loopback interface. Do NOT
# copy this connection string to a remote host.
#
# Set the dada_bridge SQL password in the session first, then run the script from
# its own folder:
#
#   $PW = Read-Host "dada_bridge password"
#   .\export-prices.ps1
#
# The password is never stored in this file and never printed. Output: prices.csv
# (UTF-8, no BOM) next to this script. Copy that file to the portal workstation
# and merge it into the catalog with:
#
#   pnpm import:wingest-prices <path to prices.csv> --dry-run   # preview
#   pnpm import:wingest-prices <path to prices.csv>             # write
# FIRST statement in the file on purpose: under pwsh this script cannot work at
# all, and every later line would fail in a way that looks like an ERP problem.
# 5.1 reports PSEdition 'Desktop'; 5.0 leaves it unset, so the -and lets it pass.
if ($PSVersionTable.PSEdition -and $PSVersionTable.PSEdition -ne 'Desktop') {
  Write-Error "Run this under Windows PowerShell 5.1 (powershell.exe), not pwsh - System.Data.SqlClient is not available in PowerShell 7"
  exit 1
}

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($PW)) {
  throw 'Set $PW to the dada_bridge SQL password first: $PW = Read-Host "dada_bridge password"'
}
# The connection string is built by interpolation, so the password has to survive
# it literally: ; and " are its delimiters (a password holding one truncates the
# string), ' breaks the quoting of the Password value, and leading or trailing
# whitespace is silently trimmed away. Each surfaces later as an unexplained
# "Login failed" against the ERP. Say which one it is here instead; the fix is to
# quote the Password value in $conn below.
if ($PW -match '^\s|\s$|[''";]') {
  throw 'The password has leading/trailing whitespace or contains '' " or ;, which the connection string cannot carry as written. Quote the Password value in $conn before running.'
}

$conn = "Server=localhost,50352;User ID=dada_bridge;Password=$PW;Initial Catalog=wgdemo;Encrypt=False;TrustServerCertificate=True;Connect Timeout=15"
$cn = New-Object System.Data.SqlClient.SqlConnection($conn)
$cn.Open()
try {
  $c = $cn.CreateCommand()
  $c.CommandText = @"
SELECT RTRIM(CODART) AS codart,
       PREVENA, PREVENB, PREVENC, PREVEND, PREVENE, PREVENF,
       RTRIM(UNIDAD) AS unidad, UNILOT
FROM articulo
"@
  $rows = New-Object System.Collections.Generic.List[string]
  $rows.Add("codart,p1,p2,p3,p4,p5,p6,unidad,unilot")
  $rd = $c.ExecuteReader()
  try {
    while ($rd.Read()) {
      # Decimals render with the server's culture, so a Spanish locale writes
      # "3,50"; the comma becomes a dot because the merge script splits the file
      # on commas and reads the numbers as plain decimals. NULL columns come out
      # as empty strings, which the merge reads as "no value".
      $vals = 0..8 | ForEach-Object { ('' + $rd[$_]).Trim().Replace(',', '.') }
      $rows.Add(($vals -join ','))
    }
  } finally {
    $rd.Close()
  }
} finally {
  # A half-read export must not leave a connection open on the ERP box.
  $cn.Close()
}

$out = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "prices.csv"
[System.IO.File]::WriteAllLines($out, $rows, (New-Object System.Text.UTF8Encoding($false)))
"exported $($rows.Count - 1) articles -> $out"
