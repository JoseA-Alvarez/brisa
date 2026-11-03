# Asistente de hardware de Brisa (Windows PowerShell 5.1). Se ejecuta elevado y solo a demanda.
# Usa la biblioteca LibreHardwareMonitorLib (sin su aplicacion) para leer la placa base/CPU y fijar la velocidad de ventiladores.
# Escucha en localhost:<Port>, exige la cabecera X-Token y devuelve el control a la BIOS al salir
# o si Brisa deja de contactar durante WatchdogSec segundos.
param(
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$Token,
  [Parameter(Mandatory)][string]$LibDir,
  [string]$LibSha256 = '',
  [int]$WatchdogSec = 10
)
$ErrorActionPreference = 'Stop'

$libPath = Join-Path $LibDir 'LibreHardwareMonitorLib.dll'
if (-not (Test-Path $libPath)) { throw "No se encuentra $libPath" }
if ($LibSha256) {
  $h = (Get-FileHash $libPath -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $LibSha256.ToLower()) { throw 'El hash de LibreHardwareMonitorLib.dll no coincide; no se carga.' }
}
# Dependencias que no vienen con .NET Framework
foreach ($n in 'HidSharp','BlackSharp.Core','DiskInfoToolkit','RAMSPDToolkit-NDD') {
  $p = Join-Path $LibDir "$n.dll"; if (Test-Path $p) { try { [void][Reflection.Assembly]::LoadFrom($p) } catch {} }
}
[void][Reflection.Assembly]::LoadFrom($libPath)

$comp = New-Object LibreHardwareMonitor.Hardware.Computer
$comp.IsMotherboardEnabled = $true
$comp.IsCpuEnabled = $true
$comp.Open()

$script:controls = @{}   # id del control -> sensor
$script:touched  = @{}   # controles que Brisa ha modificado
$script:warnings = @()

function Update-Hw($hw) { $hw.Update(); foreach ($sh in $hw.SubHardware) { Update-Hw $sh } }
function Collect-Hw($hw, $list) { [void]$list.Add($hw); foreach ($sh in $hw.SubHardware) { Collect-Hw $sh $list } }

function Get-Snapshot {
  $all = New-Object System.Collections.Generic.List[object]
  foreach ($hw in $comp.Hardware) { Update-Hw $hw; Collect-Hw $hw $all }
  $sensors = @(); $fans = @(); $script:controls = @{}
  foreach ($hw in $all) {
    $ctl = @{}
    foreach ($s in $hw.Sensors) { if ($s.SensorType.ToString() -eq 'Control') { $ctl[[int]$s.Index] = $s; $script:controls[$s.Identifier.ToString()] = $s } }
    foreach ($s in $hw.Sensors) {
      $t = $s.SensorType.ToString()
      if ($t -eq 'Temperature' -and $s.Value -ne $null -and $s.Value -gt 0 -and $s.Value -lt 125) {  # 0 o fuera de rango = lectura no valida
        $sensors += @{ id = $s.Identifier.ToString(); name = "$($hw.Name) - $($s.Name)"; value = [double]$s.Value }
      } elseif ($t -eq 'Fan') {
        $c = $ctl[[int]$s.Index]
        $fans += @{
          id = $s.Identifier.ToString(); name = "$($hw.Name) - $($s.Name)"
          rpm = $(if ($s.Value -ne $null) { [double]$s.Value } else { $null })
          duty = $(if ($c -and $c.Value -ne $null) { [double]$c.Value } else { $null })
          canControl = [bool]($c -and $c.Control -ne $null)
          controlId = $(if ($c) { $c.Identifier.ToString() } else { $null })
        }
      }
    }
  }
  $notes = @()
  if ($fans.Count -eq 0) { $notes += 'La biblioteca no encontro ventiladores de la placa base. Suele faltar el controlador PawnIO (https://pawnio.eu) o la placa no es compatible.' }
  return @{ sensors = $sensors; fans = $fans; notes = $notes }
}

function Release-All {
  foreach ($id in @($script:touched.Keys)) { try { $script:controls[$id].Control.SetDefault() } catch {} }
  $script:touched = @{}
}

function Send($ctx, [int]$code, $obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
  $b = [Text.Encoding]::UTF8.GetBytes($json)
  $ctx.Response.StatusCode = $code; $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.OutputStream.Write($b, 0, $b.Length); $ctx.Response.Close()
}

$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
$last = [DateTime]::UtcNow
try {
  while ($true) {
    $ar = $l.BeginGetContext($null, $null)
    while (-not $ar.AsyncWaitHandle.WaitOne(1000)) {
      if (([DateTime]::UtcNow - $last).TotalSeconds -gt $WatchdogSec) { throw 'Brisa dejo de contactar: se devuelve el control a la BIOS.' }
    }
    $ctx = $l.EndGetContext($ar); $last = [DateTime]::UtcNow
    try {
      if ($ctx.Request.Headers['X-Token'] -ne $Token) { Send $ctx 403 @{ error = 'token' }; continue }
      $path = $ctx.Request.Url.AbsolutePath; $q = $ctx.Request.QueryString
      switch ($path) {
        '/read'   { Send $ctx 200 (Get-Snapshot) }
        '/set'    {
          $c = $script:controls[$q['id']]; $v = 0.0
          if (-not $c -or -not $c.Control -or -not [double]::TryParse($q['value'], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$v)) { Send $ctx 400 @{ error = 'control o valor invalido' }; break }
          $c.Control.SetSoftware([single][Math]::Max(0, [Math]::Min(100, $v))); $script:touched[$q['id']] = $true; Send $ctx 200 @{ ok = $true }
        }
        '/release' { $c = $script:controls[$q['id']]; if ($c -and $c.Control) { $c.Control.SetDefault(); $script:touched.Remove($q['id']) }; Send $ctx 200 @{ ok = $true } }
        '/quit'   { Send $ctx 200 @{ ok = $true }; return }
        default   { Send $ctx 404 @{ error = 'no encontrado' } }
      }
    } catch { try { Send $ctx 500 @{ error = $_.Exception.Message } } catch {} }
  }
} finally {
  Release-All
  try { $comp.Close() } catch {}
  try { $l.Close() } catch {}
}
