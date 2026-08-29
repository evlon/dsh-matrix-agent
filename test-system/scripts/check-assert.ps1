$r = Invoke-RestMethod -Uri 'http://ai-test.ict.cmcc/state' -TimeoutSec 8
foreach ($room in $r.rooms) {
  $a = @()
  foreach ($x in $room.asserts) {
    $mark = if ($x.passed) { 'PASS' } else { 'FAIL' }
    $a += ($x.label + ':' + $mark)
  }
  Write-Output ("room=" + $room.roomName + " status=" + $room.status + " passed=" + $room.passed + " asserts=[" + ($a -join ', ') + "]")
}
