$ErrorActionPreference = 'Stop'
$packageRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$releaseRoot = Join-Path $packageRoot ('release\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$stageRoot = Join-Path $releaseRoot 'ocs-ai-bridge'
$resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
if (-not $resolvedStage.StartsWith($packageRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid package staging path.' }
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
$sourceFiles = @('package.json','start.cmd','configure.cmd','diagnose.cmd','launcher.mjs','server.mjs','setup.mjs','export-config.mjs','generate-configs.mjs','config.example.json','.env.example','.gitignore','.gitattributes','README.md','VALIDATION.md','SECURITY.md','build-package.ps1')
foreach ($folder in @('lib','web','test','configs','docs','.github')) {
  $folderRoot = Join-Path $packageRoot $folder
  foreach ($file in Get-ChildItem -LiteralPath $folderRoot -Recurse -File) {
    $sourceFiles += $file.FullName.Substring($packageRoot.Length + 1)
  }
}
foreach ($relative in $sourceFiles) {
  $source = Join-Path $packageRoot $relative
  $target = Join-Path $stageRoot $relative
  $contents = [System.IO.File]::ReadAllText($source)
  if ($contents -match 'sk-[a-fA-F0-9]{24,}') { throw "Key-shaped content found; package cancelled: $relative" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}
$zipPath = Join-Path (Split-Path -Parent $packageRoot) 'OCS-AI-Bridge-v2.zip'
Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
  foreach ($privateName in @('.env','config.json','ocs-local.json','ocs-auto.json','ocs-lite.json','ocs-full.json')) {
    if (('ocs-ai-bridge/' + $privateName) -in $entries) { throw "Private runtime file in archive: $privateName" }
  }
  foreach ($required in @('start.cmd','launcher.mjs','server.mjs','web/index.html','web/app.js','web/app.css','README.md','.env.example')) {
    if (('ocs-ai-bridge/' + $required) -notin $entries) { throw "Missing source file: $required" }
  }
} finally { $archive.Dispose() }
Write-Output $zipPath
Write-Output ('Files verified: ' + $sourceFiles.Count + '; runtime secrets and backups excluded.')
