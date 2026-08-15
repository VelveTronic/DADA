# Read-only export of Wingest price tiers + units for the DADA portal.
#
# RUN ON SERVER (Windows PowerShell 5.1). It touches the ERP database with ONE
# SELECT: no writes, no schema changes, no locks beyond the read.
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
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($PW)) {
  throw 'Set $PW to the dada_bridge SQL password first: $PW = Read-Host "dada_bridge password"'
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
