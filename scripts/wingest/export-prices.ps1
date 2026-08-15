# Read-only export of Wingest price tiers + units for the DADA portal.
#
# RUN ON SERVER (Windows PowerShell 5.1). It touches the ERP database with ONE
# SELECT against wgdemo, the live Wingest catalog database: no writes, no schema
# changes, no locks beyond the read. Expect roughly 2.9k articles.
#
# HANDLE prices.csv AS CONFIDENTIAL: it is the full six-tier price matrix for
# every article, the exact data the portal revokes from logged-in customers.
# Keep it out of the repository (.gitignore already lists it), move it to the
# portal workstation, and delete both copies once the merge has run.
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
# The password is never stored in this file, but Read-Host echoes it as you type
# and it stays in $PW until the console closes: clear it with
# `Remove-Variable PW` when the export is done. It must be a PLAIN STRING here,
# so do not use -AsSecureString. Output: prices.csv
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
# A SecureString (Read-Host -AsSecureString) passes every content check below,
# because interpolating one yields the literal text "System.Security.SecureString"
# - which is then what SQL Server receives as the password.
if ($PW -isnot [string]) {
  throw "`$PW must be a plain-text string, not a $($PW.GetType().Name). A SecureString interpolates into the connection string as its type name and reaches SQL Server as that literal password."
}
# The connection string is built by interpolation, so the password has to survive
# it literally. Each of these surfaces later as an unexplained "Login failed"
# against the ERP, so name the one that matched; the fix is to quote the Password
# value in $conn below.
$pwProblem = $null
if ($PW -match '^\s|\s$') {
  $pwProblem = 'leading or trailing whitespace, which is silently trimmed'
} elseif ($PW -match ';') {
  $pwProblem = 'a semicolon, which separates connection-string keywords and truncates the password'
} elseif ($PW -match '"') {
  $pwProblem = 'a double quote, which delimits connection-string values'
} elseif ($PW -match "'") {
  $pwProblem = 'a single quote, which breaks the quoting of the Password value'
}
if ($pwProblem) {
  throw "The dada_bridge password has $pwProblem. Quote the Password value in `$conn before running."
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
  # This header must stay BYTE-IDENTICAL to WINGEST_PRICE_CSV_HEADER in
  # src/lib/catalog/wingest.ts: the merge script refuses any file whose header
  # differs, because the columns are otherwise indistinguishable positional
  # numbers and a reordered export would write tier 6 prices into tier 1.
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
