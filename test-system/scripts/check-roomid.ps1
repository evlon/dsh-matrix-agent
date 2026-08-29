$r = Invoke-RestMethod -Uri 'http://ai-test.ict.cmcc/state' -TimeoutSec 8
Write-Output "=== rooms ==="
foreach ($room in $r.rooms) {
  Write-Output ("room=" + $room.roomName + " status=" + $room.status + " id=" + $room.roomId.Substring(0, [Math]::Min(24, $room.roomId.Length)))
}
Write-Output "=== events by room ==="
$grouped = @{}
foreach ($e in $r.events) {
  $k = $e.roomId.Substring(0, [Math]::Min(24, $e.roomId.Length))
  if (-not $grouped.ContainsKey($k)) { $grouped[$k] = 0 }
  $grouped[$k]++
}
$grouped.GetEnumerator() | ForEach-Object { Write-Output ($_.Key + ": " + $_.Value + " events") }
$roomIds = @($r.rooms | ForEach-Object { $_.roomId })
$mismatch = 0
foreach ($e in $r.events) { if ($roomIds -notcontains $e.roomId) { $mismatch++ } }
Write-Output ("mismatched events: " + $mismatch + " / " + $r.events.Count)
