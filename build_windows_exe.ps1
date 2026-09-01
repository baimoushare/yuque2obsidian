param(
  [string]$AppName = 'YuqueExporterObsidian',
  [string]$SigningCertificateThumbprint = $env:YUQUE_CODE_SIGN_CERT_THUMBPRINT
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
$entryScript = Join-Path $projectRoot 'desktop_app.py'
$browserDataArg = @()
$buildSucceeded = $false
$finalExeValidated = $false
$preserveReleaseNames = @(
  'output',
  'desktop-launch.log',
  'crash-reports',
  $exeName,
  "$exeName.WebView2",
  "$exeName.previous"
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

# 若 Puppeteer 本地缓存已有浏览器，则一并打入发布包，减少新机器对系统浏览器的依赖。
$puppeteerBrowserPath = (& $nodeExe -e "import('puppeteer').then(async m=>process.stdout.write(await m.default.executablePath()))")
if ($puppeteerBrowserPath -and (Test-Path $puppeteerBrowserPath)) {
  $browserDir = Split-Path -Parent $puppeteerBrowserPath
  $browserDataArg = @('--add-data', "$browserDir;browsers\chrome")
}
else {
  Write-Warning "Puppeteer browser binary was not found; the EXE will require an installed Chrome/Edge or a configured browser path."
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

function Test-PyInstallerArchive {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PythonExe,
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath
  )

  if (-not (Test-Path $ExecutablePath)) {
    return $false
  }

  & $PythonExe -m PyInstaller.utils.cliutils.archive_viewer $ExecutablePath -l *> $null
  return $LASTEXITCODE -eq 0
}

function Publish-ValidatedExe {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceExe,
    [Parameter(Mandatory = $true)]
    [string]$DestinationExe,
    [Parameter(Mandatory = $true)]
    [string]$PythonExe
  )

  $stagePath = "$DestinationExe.new"
  $previousPath = "$DestinationExe.previous"

  if (-not (Test-PyInstallerArchive -PythonExe $PythonExe -ExecutablePath $SourceExe)) {
    throw "Built exe validation failed before publishing: $SourceExe"
  }

  if (Test-Path $stagePath) {
    Remove-PathWithRetries -LiteralPath $stagePath
  }

  Move-Item -LiteralPath $SourceExe -Destination $stagePath -Force

  if (-not (Test-PyInstallerArchive -PythonExe $PythonExe -ExecutablePath $stagePath)) {
    throw "Published staging exe validation failed: $stagePath"
  }

  try {
    if (Test-Path $previousPath) {
      Remove-PathWithRetries -LiteralPath $previousPath
    }
    if (Test-Path $DestinationExe) {
      Move-Item -LiteralPath $DestinationExe -Destination $previousPath -Force
    }
    Move-Item -LiteralPath $stagePath -Destination $DestinationExe -Force

    if (-not (Test-PyInstallerArchive -PythonExe $PythonExe -ExecutablePath $DestinationExe)) {
      throw "Final exe validation failed after publish: $DestinationExe"
    }
  }
  catch {
    if (Test-Path $DestinationExe) {
      Remove-PathWithRetries -LiteralPath $DestinationExe
    }
    if (Test-Path $previousPath) {
      Move-Item -LiteralPath $previousPath -Destination $DestinationExe -Force
    }
    throw
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
  if ($_.Name -like '*.exe' -or $preserveReleaseNames -contains $_.Name) {
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
    --add-binary "$nodeExe;bin" `
    @browserDataArg `
    "$entryScript"
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed."
  }

  Publish-ValidatedExe -SourceExe (Join-Path $distDir $exeName) -DestinationExe $finalExePath -PythonExe $pythonExe
  $signed = $false
  if (-not [string]::IsNullOrWhiteSpace($SigningCertificateThumbprint)) {
    $signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
    if (-not $signtool) {
      throw 'A signing certificate was configured, but signtool.exe was not found.'
    }
    & $signtool sign /sha1 $SigningCertificateThumbprint.Trim() /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 $finalExePath
    if ($LASTEXITCODE -ne 0) {
      throw 'Code signing failed.'
    }
    & $signtool verify /pa $finalExePath
    if ($LASTEXITCODE -ne 0) {
      throw 'Code signature verification failed.'
    }
    $signed = $true
  }
  else {
    Write-Warning 'No code-signing certificate was configured. The SHA-256 manifest will be generated, but Windows publisher trust will remain unavailable.'
  }
  $manifest = [ordered]@{
    appName = $appName
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
    file = $exeName
    sha256 = ([BitConverter]::ToString(([System.Security.Cryptography.SHA256]::Create()).ComputeHash([System.IO.File]::ReadAllBytes($finalExePath))).Replace('-', '')).ToLowerInvariant()
    signed = $signed
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseDir 'manifest.json') -Encoding UTF8
  Remove-LegacyPackageArtifacts -RootPath $projectRoot
  $finalExeValidated = $true
  $buildSucceeded = $true

  Write-Host ""
  Write-Host "Build finished:"
  Write-Host $finalExePath
}
finally {
  if ($buildSucceeded -and $finalExeValidated -and (Test-Path $tempRoot)) {
    Remove-PathWithRetries -LiteralPath $tempRoot
  }
  elseif (Test-Path $tempRoot) {
    Write-Warning "Packaging temp directory was preserved for diagnosis: $tempRoot"
  }
}
