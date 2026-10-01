#requires -Version 7.0

<#
.SYNOPSIS
  Manages the stamp-level Workflow Generator controller for a private devbox stamp.

.DESCRIPTION
  Runs one WorkflowGeneratorController and colocated WorkflowRunWaitScheduler
  independently from repository worker containers. The service uses the
  developer's mounted Azure CLI identity and may only target an explicitly
  declared private stamp owned by that identity.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [ValidateSet('Start', 'Stop', 'Status', 'Logs', 'Validate')]
    [string]$Action = 'Start',

    [switch]$Follow,

    [ValidateRange(1, 3600)]
    [int]$ReadyTimeoutSec = 300
)

$ErrorActionPreference = 'Stop'

function Get-RequiredString {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Property,
        [Parameter(Mandatory = $true)][string]$Context
    )
    $value = $Object.$Property
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
        throw "$Context requires a non-empty '$Property'."
    }
    return ([string]$value).Trim()
}

function Resolve-ConfigPath {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$BaseDirectory
    )
    $expanded = [Environment]::ExpandEnvironmentVariables($Value)
    if (-not [IO.Path]::IsPathRooted($expanded)) {
        $expanded = Join-Path $BaseDirectory $expanded
    }
    return [IO.Path]::GetFullPath($expanded)
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $detail = ($output | Out-String).Trim()
        throw "$FilePath failed with exit code $exitCode$(if ($detail) { ": $detail" })."
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
}

function Read-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*(?:#|$)' -or $line -notmatch '=') {
            continue
        }
        $key, $value = $line -split '=', 2
        $values[$key.Trim()] = $value.Trim().Trim('"').Trim("'")
    }
    return $values
}

function ConvertTo-SafeName {
    param([Parameter(Mandatory = $true)][string]$Value)
    $safe = ($Value.Trim().ToLowerInvariant() -replace '[^a-z0-9-]+', '-').Trim('-')
    if (-not $safe) {
        throw "Cannot derive a safe name from '$Value'."
    }
    return $safe
}

function Read-ControllerConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Configuration file not found: $resolvedPath"
    }
    try {
        $raw = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
    } catch {
        throw "Could not parse configuration file '$resolvedPath': $($_.Exception.Message)"
    }
    if ($raw.privateStamp -ne $true) {
        throw "Workflow Generator devbox hosting requires 'privateStamp' to be true."
    }
    $baseDirectory = Split-Path -Parent $resolvedPath
    $stampName = (Get-RequiredString $raw 'stampName' 'Configuration').ToLowerInvariant()
    if ($stampName -notmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' -or $stampName.Length -gt 31) {
        throw "Configuration 'stampName' must use at most 31 lowercase letters, digits, or internal hyphens and start with a letter."
    }
    return [pscustomobject]@{
        ConfigPath = $resolvedPath
        StampName = $stampName
        KubernetesContext = Get-RequiredString $raw 'kubernetesContext' 'Configuration'
        WorkerImage = Get-RequiredString $raw 'workerImage' 'Configuration'
        EnvironmentFile = Resolve-ConfigPath `
            (Get-RequiredString $raw 'environmentFile' 'Configuration') $baseDirectory
        ModelProvidersFile = Resolve-ConfigPath `
            (Get-RequiredString $raw 'modelProvidersFile' 'Configuration') $baseDirectory
        CredentialDirectory = if ($raw.credentialDirectory) {
            Resolve-ConfigPath ([string]$raw.credentialDirectory) $baseDirectory
        } else {
            'C:\pilotswarm-az'
        }
        StateDirectory = if ($raw.stateRoot) {
            Join-Path (Resolve-ConfigPath ([string]$raw.stateRoot) $baseDirectory) 'workflow-generator'
        } else {
            'C:\pilotswarm-worker-state\workflow-generator'
        }
        ContainerPrefix = if ($raw.containerPrefix) {
            ConvertTo-SafeName ([string]$raw.containerPrefix)
        } else {
            'pilotswarm-devbox'
        }
    }
}

function Get-PostgresHost {
    param([Parameter(Mandatory = $true)][string]$ConnectionString)
    if ($ConnectionString -match '@([^:/?]+)') {
        return $Matches[1].ToLowerInvariant()
    }
    if ($ConnectionString -match '^postgres(?:ql)?://([^:/?]+)') {
        return $Matches[1].ToLowerInvariant()
    }
    throw "Could not extract a PostgreSQL host from DATABASE_URL."
}

function Get-ImageTag {
    param([Parameter(Mandatory = $true)][string]$Image)
    $withoutDigest = ($Image -split '@', 2)[0]
    $lastSlash = $withoutDigest.LastIndexOf('/')
    $lastColon = $withoutDigest.LastIndexOf(':')
    if ($lastColon -le $lastSlash) {
        throw "Image must use an explicit version tag: $Image"
    }
    return $withoutDigest.Substring($lastColon + 1)
}

function Resolve-DeveloperSubject {
    param([Parameter(Mandatory = $true)][string]$CredentialDirectory)
    $az = Get-Command az -ErrorAction SilentlyContinue
    if (-not $az) {
        throw "Azure CLI 'az' was not found."
    }
    $previousConfigDir = $env:AZURE_CONFIG_DIR
    try {
        $env:AZURE_CONFIG_DIR = $CredentialDirectory
        $result = Invoke-Native $az.Source @(
            'ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv'
        )
        $subject = (($result.Output | Select-Object -First 1) | Out-String).Trim()
        if (-not $subject) {
            throw "Azure CLI returned an empty signed-in user object ID."
        }
        return $subject.ToLowerInvariant()
    } finally {
        if ($null -eq $previousConfigDir) {
            Remove-Item Env:AZURE_CONFIG_DIR -ErrorAction SilentlyContinue
        } else {
            $env:AZURE_CONFIG_DIR = $previousConfigDir
        }
    }
}

function Test-PrivateStamp {
    param([Parameter(Mandatory = $true)]$Config)
    foreach ($item in @(
        @{ Path = $Config.EnvironmentFile; Kind = 'Leaf'; Description = 'environment file' },
        @{ Path = $Config.ModelProvidersFile; Kind = 'Leaf'; Description = 'model provider catalog' },
        @{ Path = $Config.CredentialDirectory; Kind = 'Container'; Description = 'Azure CLI credential directory' }
    )) {
        if (-not (Test-Path -LiteralPath $item.Path -PathType $item.Kind)) {
            throw "$($item.Description) not found: $($item.Path)"
        }
    }

    $environment = Read-DotEnv $Config.EnvironmentFile
    if (-not $environment.DATABASE_URL) {
        throw "Environment file must define DATABASE_URL."
    }
    $actualDatabaseHost = Get-PostgresHost $environment.DATABASE_URL
    $deployPostgresValue = if ($environment.ContainsKey('DEPLOY_POSTGRES')) {
        $environment.DEPLOY_POSTGRES.Trim().ToLowerInvariant()
    } else {
        'true'
    }
    if ($deployPostgresValue -notin @('true', '1', 'false', '0')) {
        throw "DEPLOY_POSTGRES must be true or false."
    }
    $deploysPostgres = $deployPostgresValue -in @('true', '1')
    if ($deploysPostgres) {
        $expectedDatabaseHost = "$($Config.StampName)-pg.postgres.database.azure.com"
        if ($actualDatabaseHost -ne $expectedDatabaseHost) {
            throw "Stamp mismatch: DATABASE_URL targets '$actualDatabaseHost'; expected '$expectedDatabaseHost'."
        }
    } elseif (-not $actualDatabaseHost) {
        throw "BYO database configuration must identify an explicit database host."
    }

    if ($environment.IMAGE) {
        $controllerTag = Get-ImageTag $Config.WorkerImage
        $stampTag = Get-ImageTag $environment.IMAGE
        if ($controllerTag -ne $stampTag) {
            throw "Version mismatch: devbox image tag '$controllerTag' does not match stamp image tag '$stampTag'."
        }
    }

    $developerSubject = Resolve-DeveloperSubject $Config.CredentialDirectory
    if (-not $environment.DEVBOX_PRINCIPAL_ID) {
        throw "Private stamp environment must define DEVBOX_PRINCIPAL_ID."
    }
    if ($developerSubject -ne $environment.DEVBOX_PRINCIPAL_ID.Trim().ToLowerInvariant()) {
        throw "Private stamp owner does not match the signed-in Azure identity."
    }

    $kubectl = Get-Command kubectl -ErrorAction SilentlyContinue
    if (-not $kubectl) {
        throw "kubectl was not found."
    }
    $contextResult = Invoke-Native $kubectl.Source @('config', 'current-context')
    $actualContext = (($contextResult.Output | Select-Object -First 1) | Out-String).Trim()
    if ($actualContext -ne $Config.KubernetesContext) {
        throw "Stamp mismatch: active kubectl context is '$actualContext'; expected '$($Config.KubernetesContext)'."
    }
    if ($environment.AKS_CLUSTER_NAME -and $environment.AKS_CLUSTER_NAME -ne $Config.KubernetesContext) {
        throw "Stamp mismatch: configured context does not match AKS_CLUSTER_NAME."
    }
    return $developerSubject
}

function Get-ControllerIdentity {
    param([Parameter(Mandatory = $true)]$Config)
    $machine = ConvertTo-SafeName ($env:COMPUTERNAME ?? [Environment]::MachineName)
    return [pscustomobject]@{
        ContainerName = "$($Config.ContainerPrefix)-$machine-workflow-generator"
        WorkerId = "devbox-$machine-workflow-generator"
    }
}

function Get-Fingerprint {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$DeveloperSubject
    )
    $value = [ordered]@{
        image = $Config.WorkerImage
        environmentFile = $Config.EnvironmentFile
        environmentFileHash = (Get-FileHash -LiteralPath $Config.EnvironmentFile -Algorithm SHA256).Hash
        modelProvidersFile = $Config.ModelProvidersFile
        modelProvidersFileHash = (Get-FileHash -LiteralPath $Config.ModelProvidersFile -Algorithm SHA256).Hash
        credentialDirectory = $Config.CredentialDirectory
        stateDirectory = $Config.StateDirectory
        stampName = $Config.StampName
        developerSubject = $DeveloperSubject
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress))
    return ([Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($bytes)
    )).ToLowerInvariant()
}

function Get-ContainerState {
    param(
        [Parameter(Mandatory = $true)][string]$Docker,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $result = Invoke-Native $Docker @(
        'container', 'inspect', $Name,
        '--format', '{{.State.Running}}|{{index .Config.Labels "com.pilotswarm.devbox.fingerprint"}}'
    ) -AllowFailure
    if ($result.ExitCode -ne 0) {
        return $null
    }
    $parts = (($result.Output | Select-Object -First 1) -split '\|', 2)
    return [pscustomobject]@{
        Running = $parts[0] -eq 'true'
        Fingerprint = if ($parts.Count -gt 1) { $parts[1] } else { '' }
    }
}

function Get-DockerHostGateway {
    param([Parameter(Mandatory = $true)][string]$Docker)

    $result = Invoke-Native $Docker @(
        'network', 'inspect', 'nat',
        '--format', '{{(index .IPAM.Config 0).Gateway}}'
    )
    $gateway = (($result.Output | Select-Object -First 1) | Out-String).Trim()
    if ($gateway -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$') {
        throw "Could not resolve the Windows Docker host gateway from the nat network."
    }
    return $gateway
}

function Start-Controller {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$Docker,
        [Parameter(Mandatory = $true)][string]$DeveloperSubject
    )
    $identity = Get-ControllerIdentity $Config
    $fingerprint = Get-Fingerprint $Config $DeveloperSubject
    $existing = Get-ContainerState $Docker $identity.ContainerName
    if ($existing) {
        if ($existing.Running) {
            if ($existing.Fingerprint -ne $fingerprint) {
                throw "Container '$($identity.ContainerName)' is running with different configuration."
            }
            Write-Host "Workflow Generator controller is already running as $($identity.ContainerName)"
            return
        }
        Invoke-Native $Docker @('container', 'rm', $identity.ContainerName) | Out-Null
    }

    New-Item -ItemType Directory -Force $Config.StateDirectory | Out-Null
    Remove-Item -LiteralPath (Join-Path $Config.StateDirectory 'workflow-generator.ready') `
        -Force -ErrorAction SilentlyContinue
    $modelProvidersDirectory = Split-Path -Parent $Config.ModelProvidersFile
    $modelProvidersName = Split-Path -Leaf $Config.ModelProvidersFile
    $dockerHostGateway = Get-DockerHostGateway $Docker
    Invoke-Native $Docker @(
        'run', '--detach',
        '--name', $identity.ContainerName,
        '--add-host', "host.docker.internal:$dockerHostGateway",
        '--label', 'com.pilotswarm.devbox.managed=true',
        '--label', 'com.pilotswarm.devbox.service=workflow-generator',
        '--label', "com.pilotswarm.devbox.fingerprint=$fingerprint",
        '--env-file', $Config.EnvironmentFile,
        '--entrypoint', 'node',
        '-v', "$($Config.CredentialDirectory):C:\creds",
        '-v', "$($Config.StateDirectory):C:\controller-state",
        '-v', "${modelProvidersDirectory}:C:\controller-config:ro",
        '-e', 'AZURE_CONFIG_DIR=C:\creds',
        '-e', "PS_MODEL_PROVIDERS_PATH=C:\controller-config\$modelProvidersName",
        '-e', 'CALLER_AUTH_MODE=devbox',
        '-e', 'WORKFLOW_GENERATOR_COMPUTE=devbox',
        '-e', "WORKFLOW_GENERATOR_WORKER_ID=$($identity.WorkerId)",
        '-e', 'WORKFLOW_GENERATOR_READY_FILE=C:\controller-state\workflow-generator.ready',
        $Config.WorkerImage,
        'packages/workflow-generator/dist/cli.js'
    ) | Out-Null
    Write-Host "Started Workflow Generator controller as $($identity.ContainerName)"
}

function Wait-Controller {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$Docker
    )
    $identity = Get-ControllerIdentity $Config
    $readyFile = Join-Path $Config.StateDirectory 'workflow-generator.ready'
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSec)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $readyFile -PathType Leaf) {
            Write-Host "Workflow Generator controller is ready as $($identity.WorkerId)"
            return
        }
        $state = Get-ContainerState $Docker $identity.ContainerName
        if (-not $state -or -not $state.Running) {
            $logs = Invoke-Native $Docker @('logs', '--tail', '80', $identity.ContainerName) -AllowFailure
            throw "Workflow Generator controller stopped before becoming ready.`n$(($logs.Output | Out-String).Trim())"
        }
        Start-Sleep -Seconds 2
    }
    throw "Workflow Generator controller did not become ready within $ReadyTimeoutSec seconds."
}

$config = Read-ControllerConfig $ConfigPath
$developerSubject = $null
if ($Action -in @('Start', 'Validate')) {
    $developerSubject = Test-PrivateStamp $config
}
if ($Action -eq 'Validate') {
    Write-Host "Configuration is valid for private stamp '$($config.StampName)'."
    Write-Host "Controller image: $($config.WorkerImage)"
    Write-Host "Developer subject: $developerSubject"
    exit 0
}

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCommand) {
    throw "Docker CLI was not found on PATH."
}
$docker = $dockerCommand.Source
$identity = Get-ControllerIdentity $config

switch ($Action) {
    'Start' {
        $dockerVersion = Invoke-Native $docker @('version', '--format', '{{.Server.Os}}')
        $dockerServerOs = (($dockerVersion.Output | Select-Object -First 1) | Out-String).Trim()
        if ($dockerServerOs -ne 'windows') {
            throw "Docker must be running in Windows-container mode; the current server reports '$dockerServerOs'."
        }
        Invoke-Native $docker @('image', 'inspect', $config.WorkerImage) | Out-Null
        Start-Controller $config $docker $developerSubject
        Wait-Controller $config $docker
    }
    'Stop' {
        $state = Get-ContainerState $docker $identity.ContainerName
        if (-not $state) {
            Write-Host "Workflow Generator controller not found"
        } elseif ($state.Running) {
            Invoke-Native $docker @('container', 'stop', '--time', '30', $identity.ContainerName) | Out-Null
            Write-Host "Stopped $($identity.ContainerName)"
        } else {
            Write-Host "Workflow Generator controller already stopped"
        }
    }
    'Status' {
        $state = Get-ContainerState $docker $identity.ContainerName
        [pscustomobject]@{
            Stamp = $config.StampName
            Container = $identity.ContainerName
            Status = if (-not $state) { 'not-created' } elseif ($state.Running) { 'running' } else { 'stopped' }
            Ready = [bool](
                $state -and $state.Running -and
                (Test-Path -LiteralPath (Join-Path $config.StateDirectory 'workflow-generator.ready') -PathType Leaf)
            )
        } | Format-Table -AutoSize
    }
    'Logs' {
        $arguments = @('logs')
        if ($Follow) {
            $arguments += '--follow'
        }
        $arguments += $identity.ContainerName
        & $docker @arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Could not read Workflow Generator controller logs."
        }
    }
}

exit 0
