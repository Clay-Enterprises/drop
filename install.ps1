$ErrorActionPreference = "Stop"

$architecture = $env:PROCESSOR_ARCHITECTURE
if ($architecture -ne "AMD64") {
  Write-Error "Unsupported architecture: $architecture."
  exit 1
}

$asset = "drop-windows-x64.exe"
$version = if ($env:DROP_VERSION) { $env:DROP_VERSION } else { "v0.1.0" }
$repository = if ($env:DROP_REPOSITORY) { $env:DROP_REPOSITORY } else { "Clay-Enterprises/drop" }
$releaseUrl = "https://github.com/$repository/releases/download/$version"
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "drop-install-$([guid]::NewGuid())"

New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
try {
  $binaryPath = Join-Path $temporaryDirectory $asset
  $checksumsPath = Join-Path $temporaryDirectory "SHA256SUMS"
  Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $binaryPath
  Invoke-WebRequest -Uri "$releaseUrl/SHA256SUMS" -OutFile $checksumsPath

  $assetPattern = [regex]::Escape($asset)
  $checksumLine = Get-Content $checksumsPath | Where-Object {
    $_ -match "^([0-9a-fA-F]{64})\s+$assetPattern$"
  } | Select-Object -First 1
  if (-not $checksumLine) {
    Write-Error "SHA256SUMS does not contain $asset."
    exit 1
  }

  $expectedChecksum = ($checksumLine -split "\s+")[0]
  $actualChecksum = (Get-FileHash -Algorithm SHA256 $binaryPath).Hash
  if ($actualChecksum -ne $expectedChecksum) {
    Write-Error "Checksum verification failed for $asset."
    exit 1
  }

  $installDirectory = if ($env:DROP_INSTALL_DIR) {
    $env:DROP_INSTALL_DIR
  } else {
    Join-Path $env:LOCALAPPDATA "Programs\drop\bin"
  }
  New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
  $installedPath = Join-Path $installDirectory "drop.exe"
  $stagedPath = Join-Path $installDirectory ".drop-install-$PID.exe"
  Copy-Item $binaryPath $stagedPath
  Move-Item -Force $stagedPath $installedPath

  Write-Output "Installed drop $version to $installedPath"
} finally {
  Remove-Item -Force -Recurse $temporaryDirectory -ErrorAction SilentlyContinue
}
