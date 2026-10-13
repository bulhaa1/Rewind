# perf-sample.ps1 — sample GPU-engine utilization and CPU for a set of PIDs.
#
# The app's own "Resource sample" line only covers its main process. This
# samples the real cost: per-process GPU engines (Windows "GPU Engine"
# performance counters) plus nvidia-smi's global GPU/encoder numbers, so a
# state (buffer on / paused / app closed) can be compared by numbers.
#
# Usage:
#   powershell -NoProfile -File scripts/perf-sample.ps1 -Seconds 30 -Pids 123,456 -Label "buffer-on"

param(
  [int]$Seconds = 30,
  [string]$Pids = '',
  [string]$Label = 'sample'
)

$ErrorActionPreference = 'Continue'
$PidList = @()
if ($Pids.Trim().Length -gt 0) {
  $PidList = $Pids.Split(',') | ForEach-Object { [int]$_.Trim() }
}

function Get-GpuByPid {
  $out = @{}
  try {
    $cs = (Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -MaxSamples 1 -ErrorAction Stop).CounterSamples
    foreach ($c in $cs) {
      if ($c.InstanceName -match 'pid_(\d+)_.*engtype_([a-z0-9]+)') {
        $p = [int]$Matches[1]; $eng = $Matches[2]
        if ($PidList.Count -eq 0 -or $PidList -contains $p) {
          $key = "{0}|{1}" -f $p, $eng
          if (-not $out.ContainsKey($key)) { $out[$key] = 0.0 }
          $out[$key] += $c.CookedValue
        }
      }
    }
  } catch { }
  return $out
}

$cpu0 = @{}
foreach ($p in $PidList) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) { $cpu0[$p] = $proc.CPU }
}
$t0 = Get-Date

$acc = @{}
$nvs = @()
for ($i = 0; $i -lt $Seconds; $i++) {
  foreach ($kv in (Get-GpuByPid).GetEnumerator()) {
    if (-not $acc.ContainsKey($kv.Key)) { $acc[$kv.Key] = New-Object System.Collections.ArrayList }
    [void]$acc[$kv.Key].Add($kv.Value)
  }
  try {
    $nv = (nvidia-smi --query-gpu=utilization.gpu,utilization.encoder,utilization.memory,power.draw --format=csv,noheader,nounits 2>$null)
    if ($nv) { $nvs += ($nv | Select-Object -First 1).Trim() }
  } catch { }
  Start-Sleep -Seconds 1
}

$t1 = Get-Date
$elapsed = ($t1 - $t0).TotalSeconds

"=== $Label ($([math]::Round($elapsed,1))s) ==="
'---- GPU engine utilization by pid (avg/max, summed across instances) ----'
$acc.GetEnumerator() | Sort-Object { $_.Key } | ForEach-Object {
  $v = $_.Value
  if ($v.Count -gt 0) {
    $avg = ($v | Measure-Object -Average).Average
    $max = ($v | Measure-Object -Maximum).Maximum
    '{0,-30} avg {1,7:N2}%  max {2,7:N2}%  n={3}' -f $_.Key, $avg, $max, $v.Count
  }
}
'---- CPU delta (% of one core) ----'
foreach ($p in $PidList) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc -and $cpu0.ContainsKey($p)) {
    $d = $proc.CPU - $cpu0[$p]
    if ($elapsed -gt 0) { $pct = $d / $elapsed * 100 } else { $pct = 0 }
    '{0,-12} pid {1,-7} cpu {2,7:N1}%  (d={3:N1}s / {4:N1}s)' -f $proc.ProcessName, $p, $pct, $d, $elapsed
  }
}
if ($nvs.Count -gt 0) {
  $gpuAvg = ($nvs | ForEach-Object { [double](($_ -split ',')[0]) } | Measure-Object -Average).Average
  $encAvg = ($nvs | ForEach-Object { [double](($_ -split ',')[1]) } | Measure-Object -Average).Average
  $memAvg = ($nvs | ForEach-Object { [double](($_ -split ',')[2]) } | Measure-Object -Average).Average
  $powAvg = ($nvs | ForEach-Object { [double](($_ -split ',')[3]) } | Measure-Object -Average).Average
  '---- nvidia-smi over the window ----'
  'AVG: gpu {0:N1}%   encoder {1:N1}%   mem {2:N1}%   power {3:N1} W' -f $gpuAvg, $encAvg, $memAvg, $powAvg
}
