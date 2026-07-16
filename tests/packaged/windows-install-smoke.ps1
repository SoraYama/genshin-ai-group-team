$ErrorActionPreference = 'Stop'

$installer = Get-ChildItem release -File -Filter *.exe |
  Where-Object { $_.Name -notmatch 'Uninstall' } |
  Select-Object -First 1
if (-not $installer) { throw 'NSIS installer not found under release/' }

$installDir = Join-Path $env:RUNNER_TEMP 'gta-nsis-smoke'
$userDataDir = Join-Path $env:RUNNER_TEMP 'gta-nsis-user-data'
New-Item -ItemType Directory -Force $userDataDir | Out-Null
$sentinel = Join-Path $userDataDir 'preserve-after-uninstall.txt'
Set-Content $sentinel 'preserve'

try {
  $install = Start-Process -FilePath $installer.FullName -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)" }

  $appExe = Join-Path $installDir 'Genshin Team Advisor.exe'
  if (-not (Test-Path $appExe)) { throw "Installed executable missing: $appExe" }

  $overwrite = Start-Process -FilePath $installer.FullName -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
  if ($overwrite.ExitCode -ne 0) { throw "Overwrite installer exited with $($overwrite.ExitCode)" }
  if (-not (Test-Path $appExe)) { throw 'Overwrite install removed the application executable' }

  $env:GTA_PACKAGED_APP_PATH = $appExe
  $env:GTA_E2E_USER_DATA_DIR = $userDataDir
  npm run test:packaged:sdk
  if ($LASTEXITCODE -ne 0) { throw 'Installed packaged SDK smoke failed' }

  $uninstaller = Get-ChildItem $installDir -File -Filter 'Uninstall*.exe' | Select-Object -First 1
  if (-not $uninstaller) { throw 'NSIS uninstaller not found' }
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
  if (-not (Test-Path $sentinel)) { throw 'Uninstaller deleted user data' }

  Write-Output '{"gate":"windows-install","status":"passed","overwriteInstall":true,"userDataPreserved":true}'
} finally {
  Remove-Item Env:GTA_PACKAGED_APP_PATH -ErrorAction SilentlyContinue
}
