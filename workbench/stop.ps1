# Stop the memory workbench background node process.
# Kept ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM.
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*workbench*server.mjs*' }
if (-not $p) {
  Write-Host 'workbench is not running'
  exit 0
}
foreach ($x in $p) {
  Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host ('stopped pid ' + $x.ProcessId)
}
