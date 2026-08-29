$r = Invoke-RestMethod -Uri 'http://127.0.0.1:3088/state' -TimeoutSec 5
foreach ($room in $r.rooms) {
  Write-Output ("room: " + $room.roomName + " status=" + $room.status + " round=" + $room.round + " msgs=" + $room.messageCount)
}
Write-Output "=== 最近事件 ==="
$r.events | Select-Object -Last 10 | ForEach-Object {
  if ($_.text) { $txt = $_.text; if ($txt.Length -gt 50) { $txt = $txt.Substring(0, 50) + "..." } }
  else { $txt = $_.status }
  Write-Output ("[" + $_.kind + "] " + $_.from + ": " + $txt)
}
