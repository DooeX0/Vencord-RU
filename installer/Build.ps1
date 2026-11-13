param(
    [ValidatePattern('^[a-zA-Z0-9_-]+\.exe$')]
    [string] $OutputName = 'Vencord-RU-Setup.exe'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The Windows .NET Framework C# compiler (csc.exe) was not found.'
}

$installerUrl = 'https://github.com/Vencord/Installer/releases/download/v1.4.2/VencordInstallerCli.exe'
$installerSha256 = '15268ABA25625797BF562187DD87DDADF42882E079C7B6192880AD3E83353EF5'
$nodeSha256 = '6CAC9FFBCA8F6A47091E4B5C772E0606049C3871CB67D900C0CEDDE630E545BA'
$gitSha256 = '4A92850B6E917DA4FD010669B614B55DCCF5B0EC333A534CC4BE4700DFEFDAFD'
$pnpmSha256 = '84CF69DB1BE19E95BB4E5BEF329291A046F2821B390D87E00F5690809D8A2ED7'
$official = 'https://github.com/Vendicated/Vencord.git'
$state = Join-Path $root '.vencord-ru'
$stage = Join-Path $state ('installer-' + [guid]::NewGuid().ToString('N'))
$artifactDir = Join-Path $root 'dist'

function Get-VerifiedAsset($name, $url, $sha256) {
    $cache = Join-Path $state $name
    if (-not (Test-Path -LiteralPath $cache -PathType Leaf)) {
        $download = Join-Path $stage $name
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $sha256) {
            throw "SHA-256 mismatch for $name."
        }
        Move-Item -LiteralPath $download -Destination $cache
    }
    if ((Get-FileHash -LiteralPath $cache -Algorithm SHA256).Hash -ne $sha256) {
        throw "SHA-256 mismatch for cached $name."
    }
    return $cache
}

Push-Location $root
try {
    & node (Join-Path $root 'vencord-ru.mjs') --package
    if ($LASTEXITCODE -ne 0) { throw 'Vencord package build failed.' }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null

    $helper = Get-VerifiedAsset 'VencordInstallerCli-1.4.2.exe' $installerUrl $installerSha256
    $node = Get-VerifiedAsset 'node-v24.20.0-win-x64.zip' 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip' $nodeSha256
    $git = Get-VerifiedAsset 'MinGit-2.56.1-64-bit.zip' 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip' $gitSha256
    $pnpm = Get-VerifiedAsset 'pnpm-v12.15.0-win32-x64.zip' 'https://github.com/pnpm/pnpm/releases/download/v12.15.0/pnpm-win32-x64.zip' $pnpmSha256

    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $payload = Join-Path $stage 'payload'
    $projectState = Join-Path $payload '.vencord-ru'
    $current = Join-Path $projectState 'current'
    $payloadDist = Join-Path $current 'dist'
    New-Item -ItemType Directory -Path $payloadDist -Force | Out-Null
    $build = Join-Path $state 'package'
    foreach ($file in 'patcher.js', 'preload.js', 'renderer.js', 'renderer.css', 'patcher.js.LEGAL.txt', 'renderer.js.LEGAL.txt') {
        Copy-Item -LiteralPath (Join-Path $build "dist/$file") -Destination $payloadDist
    }
    Set-Content -LiteralPath (Join-Path $payloadDist 'package.json') -Value '{"type":"commonjs"}' -Encoding ascii
    foreach ($file in 'fingerprint.txt', 'revision.txt', 'package.json', 'scripts') {
        Copy-Item -LiteralPath (Join-Path $build $file) -Destination $current -Recurse
    }
    foreach ($file in 'LICENSE', 'vencord-ru.mjs', 'overlay.mjs', 'ru.json', 'runtime') {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $payload -Recurse
    }

    $tools = Join-Path $payload 'tools'
    [IO.Compression.ZipFile]::ExtractToDirectory($pnpm, $tools)
    [IO.Compression.ZipFile]::ExtractToDirectory($git, (Join-Path $tools 'git'))
    $nodeArchive = [IO.Compression.ZipFile]::OpenRead($node)
    try {
        [IO.Compression.ZipFileExtensions]::ExtractToFile(
            $nodeArchive.GetEntry('node-v24.20.0-win-x64/node.exe'), (Join-Path $tools 'node.exe'))
        [IO.Compression.ZipFileExtensions]::ExtractToFile(
            $nodeArchive.GetEntry('node-v24.20.0-win-x64/LICENSE'), (Join-Path $tools 'Node-LICENSE'))
    } finally {
        $nodeArchive.Dispose()
    }

    $seed = Join-Path $projectState 'upstream'
    $portableGit = Join-Path $tools 'git/cmd/git.exe'
    & $portableGit clone --depth 1 --branch main --template= --config core.longpaths=true $official $seed
    if ($LASTEXITCODE -ne 0) { throw 'Could not seed the official Vencord checkout.' }
    $revision = Join-Path $build 'revision.txt'
    $seedRevision = & $portableGit -C $seed rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $seedRevision -ne (Get-Content -LiteralPath $revision -Raw).Trim()) {
        throw 'Upstream changed while building the installer. Run the packaging script again.'
    }

    $idMaterial = @('updater-v1', (Get-Content -LiteralPath (Join-Path $build 'fingerprint.txt') -Raw).Trim(),
        $nodeSha256, $gitSha256, $pnpmSha256) -join '|'
    $idInput = Join-Path $stage 'hashes.txt'
    Set-Content -LiteralPath $idInput -Value $idMaterial -Encoding ascii
    $id = Join-Path $stage 'id.txt'
    Set-Content -LiteralPath $id -Value (Get-FileHash -LiteralPath $idInput -Algorithm SHA256).Hash.Substring(0, 24).ToLowerInvariant() -Encoding ascii

    $zip = Join-Path $stage 'payload.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($payload, $zip)
    $candidate = Join-Path $stage 'Vencord-RU-Setup.exe'
    $logo = Join-Path $seed 'browser/icon.png'
    $compilerArgs = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
        '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.FileSystem.dll',
        "/resource:$zip,Bundle", "/resource:$helper,VencordInstallerCli", "/resource:$id,BundleId", "/resource:$logo,VencordLogo",
        "/out:$candidate", (Join-Path $PSScriptRoot 'Setup.cs'), (Join-Path $PSScriptRoot 'SetupTheme.cs'),
        (Join-Path $PSScriptRoot 'FolderPicker.cs')
    )
    & $compiler @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw 'The setup executable did not compile.' }

    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
    $output = Join-Path $artifactDir $OutputName
    Copy-Item -LiteralPath $candidate -Destination $output -Force
    Get-FileHash -LiteralPath $output -Algorithm SHA256
} finally {
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).ProviderPath
        $resolvedState = (Resolve-Path -LiteralPath $state).ProviderPath
        if ([IO.Path]::GetDirectoryName($resolvedStage) -eq $resolvedState -and
            [IO.Path]::GetFileName($resolvedStage) -match '^installer-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
    Pop-Location
}
