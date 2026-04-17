param(
  [string]$AppName = 'YuqueExporterObsidian'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$appName = if ([string]::IsNullOrWhiteSpace($AppName)) { 'YuqueExporterObsidian' } else { $AppName.Trim() }
$exeName = "$appName.exe"
$releaseDir = Join-Path $projectRoot 'release'
$finalExePath = Join-Path $releaseDir $exeName
$tempRoot = Join-Path $projectRoot '.packaging-temp'
$distDir = Join-Path $tempRoot 'dist'
$buildDir = Join-Path $tempRoot 'build'
$specDir = Join-Path $tempRoot 'spec'
$iconPng = Join-Path $projectRoot 'app-icon.png'
$iconIco = Join-Path $tempRoot 'app-icon.ico'
$desktopDir = Join-Path $projectRoot 'desktop'
$srcDir = Join-Path $projectRoot 'src'
$nodeModulesDir = Join-Path $projectRoot 'node_modules'
$cookieFile = Join-Path $projectRoot 'cookies.json'
$desktopSettingsFile = Join-Path $projectRoot 'desktop.settings.json'
$entryScript = Join-Path $projectRoot 'desktop_app.py'
$releaseCookieFile = Join-Path $releaseDir 'cookies.json'
$releaseSettingsFile = Join-Path $releaseDir 'desktop.settings.json'
$preserveReleaseNames = @(
  'output',
  'cookies.json',
  'desktop.settings.json',
  'desktop-launch.log',
  'crash-reports',
  "$exeName.WebView2"
)

$pythonCandidates = @(
  (Join-Path $projectRoot '.venv\Scripts\python.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe')
)

$pythonExe = $pythonCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $pythonExe) {
  $pythonExe = (Get-Command python).Source
}

if (-not (Test-Path $pythonExe)) {
  throw "python.exe not found."
}

$nodeExe = (Get-Command node).Source
if (-not (Test-Path $nodeExe)) {
  throw "node.exe not found."
}

if (-not (Test-Path $iconPng)) {
  throw "app-icon.png not found in project root."
}

function Stop-OldPackagedProcesses {
  param(
    [string]$RootPath,
    [string]$ExecutableName
  )

  $webViewDataDir = Join-Path $releaseDir "$ExecutableName.WebView2"
  $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.ExecutablePath -and (
      ($_.ExecutablePath -like "$RootPath*") -or
      ($_.ExecutablePath -ieq $finalExePath)
    )) -or (
      $_.CommandLine -and ($_.CommandLine -like "*$webViewDataDir*")
    )
  }

  foreach ($process in $targets | Sort-Object ProcessId -Unique) {
    $displayPath = if ($process.ExecutablePath) { $process.ExecutablePath } else { $process.Name }
    Write-Host "Stopping packaged process: $displayPath (PID $($process.ProcessId))"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Milliseconds 1200
}

function Remove-PathWithRetries {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,
    [int]$Attempts = 5,
    [int]$DelayMs = 600
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    if (-not (Test-Path $LiteralPath)) {
      return
    }

    try {
      Remove-Item -LiteralPath $LiteralPath -Recurse -Force
      return
    }
    catch {
      if ($attempt -ge $Attempts) {
        throw
      }
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Remove-LegacyPackageArtifacts {
  param([string]$RootPath)

  $legacyPatterns = @(
    'build',
    'build_*',
    'dist',
    'dist_*',
    'spec_*',
    'tmp-test'
  )

  foreach ($pattern in $legacyPatterns) {
    Get-ChildItem -Path $RootPath -Force -Filter $pattern -Directory -ErrorAction SilentlyContinue |
      ForEach-Object {
        if ($_.FullName -ieq $releaseDir) {
          return
        }
        Write-Host "Removing old package directory: $($_.FullName)"
        Remove-PathWithRetries -LiteralPath $_.FullName
      }
  }
}

Stop-OldPackagedProcesses -RootPath $projectRoot -ExecutableName $exeName

if (Test-Path $tempRoot) {
  Remove-PathWithRetries -LiteralPath $tempRoot
}
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
New-Item -ItemType Directory -Path $specDir -Force | Out-Null
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

Get-ChildItem -Path $releaseDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
  if ($preserveReleaseNames -contains $_.Name) {
    Write-Host "Preserving release artifact: $($_.FullName)"
    return
  }
  Write-Host "Removing old release artifact: $($_.FullName)"
  Remove-PathWithRetries -LiteralPath $_.FullName
}

try {
  & $pythonExe -c "from PIL import Image; img = Image.open(r'$iconPng'); img.save(r'$iconIco', format='ICO', sizes=[(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)])"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to convert app-icon.png to ICO."
  }

  & $pythonExe -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name "$appName" `
    --icon "$iconIco" `
    --distpath "$distDir" `
    --workpath "$buildDir" `
    --specpath "$specDir" `
    --add-data "${desktopDir};desktop" `
    --add-data "${srcDir};src" `
    --add-data "${nodeModulesDir};node_modules" `
    --add-data "${cookieFile};." `
    --add-data "${desktopSettingsFile};." `
    --add-binary "$nodeExe;bin" `
    "$entryScript"
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed."
  }

  Copy-Item -LiteralPath (Join-Path $distDir $exeName) -Destination $finalExePath -Force
  if (-not (Test-Path $releaseCookieFile) -and (Test-Path $cookieFile)) {
    Copy-Item -LiteralPath $cookieFile -Destination $releaseCookieFile -Force
  }
  if (-not (Test-Path $releaseSettingsFile) -and (Test-Path $desktopSettingsFile)) {
    Copy-Item -LiteralPath $desktopSettingsFile -Destination $releaseSettingsFile -Force
  }
  Remove-LegacyPackageArtifacts -RootPath $projectRoot

  Write-Host ""
  Write-Host "Build finished:"
  Write-Host $finalExePath
}
finally {
  if (Test-Path $tempRoot) {
    Remove-PathWithRetries -LiteralPath $tempRoot
  }
}
