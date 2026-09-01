param(
  [string]$Version = '',
  [Parameter(Mandatory = $true)]
  [string]$Title,
  [string[]]$Note = @(),
  [string]$PrivateKeyPath = $env:YUQUE_UPDATE_SIGNING_KEY,
  [string]$AuthenticodeThumbprint = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (& node -p "require('./package.json').version").Trim()
}
if ([string]::IsNullOrWhiteSpace($PrivateKeyPath) -or -not (Test-Path -LiteralPath $PrivateKeyPath)) {
  throw '缺少 OTA Ed25519 私钥。请通过 -PrivateKeyPath 或 YUQUE_UPDATE_SIGNING_KEY 传入本机私钥路径。'
}

$exePath = Join-Path $projectRoot 'release\YuqueExporterObsidian.exe'
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "未找到已构建 EXE：$exePath。请先执行 npm run build:exe 并完成本地验收。"
}

$outputPath = Join-Path $projectRoot 'release\ota-upload'
$publishArgs = @(
  '.\tools\ota_publish.py',
  '--exe', $exePath,
  '--version', $Version,
  '--private-key', $PrivateKeyPath,
  '--output', $outputPath,
  '--title', $Title
)
foreach ($item in $Note) {
  if (-not [string]::IsNullOrWhiteSpace($item)) {
    $publishArgs += @('--note', $item)
  }
}
if (-not [string]::IsNullOrWhiteSpace($AuthenticodeThumbprint)) {
  $publishArgs += @('--authenticode-thumbprint', $AuthenticodeThumbprint)
}

& py @publishArgs
if ($LASTEXITCODE -ne 0) {
  throw 'OTA 上传目录生成失败。'
}

Write-Host "完成。请按 release\ota-upload\上传顺序.txt 上传到 C:/wwwroot/update.baimoushare.cn/yuque2obsidian。"
