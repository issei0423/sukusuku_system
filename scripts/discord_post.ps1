<#
.SYNOPSIS
    進捗を Discord のチャンネルへ Webhook で投稿する。

.DESCRIPTION
    投稿先は Webhook URL が保持しているため、サーバID・チャンネルIDの指定は不要。
    （参考：チーム Discord のサーバID = 1493171485559361566）

    Webhook URL は次の順に解決する。リポジトリにはコミットしないこと。
      1. -WebhookUrl 引数
      2. 環境変数 DISCORD_WEBHOOK_URL
      3. .claude\discord_webhook.txt の1行目（.claude\ は .gitignore 済み）

.EXAMPLE
    # 任意のメッセージを送る
    .\scripts\discord_post.ps1 "要件定義書 第2.2版をコミットしました"

.EXAMPLE
    # 進捗ログ.md の最新エントリをそのまま送る（まず内容を確認）
    .\scripts\discord_post.ps1 -FromLog -DryRun
    .\scripts\discord_post.ps1 -FromLog
#>
[CmdletBinding(DefaultParameterSetName = 'Message')]
param(
    [Parameter(ParameterSetName = 'Message', Mandatory = $true, Position = 0)]
    [string]$Message,

    [Parameter(ParameterSetName = 'FromLog', Mandatory = $true)]
    [switch]$FromLog,

    [Parameter(ParameterSetName = 'FromLog')]
    [string]$LogPath,

    [string]$WebhookUrl,
    [string]$Username = 'すくすく進捗',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Discord のメッセージ上限は2000文字。分割の余白を見て 1900 で切る
$ChunkLimit = 1900

$repoRoot = Split-Path -Parent $PSScriptRoot

function Resolve-WebhookUrl {
    param([string]$Explicit)

    if ($Explicit) { return $Explicit.Trim() }
    if ($env:DISCORD_WEBHOOK_URL) { return $env:DISCORD_WEBHOOK_URL.Trim() }

    $file = Join-Path $repoRoot '.claude\discord_webhook.txt'
    if (Test-Path $file) {
        $line = (Get-Content $file -Encoding UTF8 | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
        if ($line) { return $line.Trim() }
    }

    throw @"
Webhook URL が見つかりません。次のいずれかで設定してください。
  A) ファイルに置く（推奨・.gitignore 済み）
       "https://discord.com/api/webhooks/..." | Out-File -Encoding utf8 "$file"
  B) 環境変数に入れる（そのセッション限り）
       `$env:DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/..."
  C) 引数で渡す
       .\scripts\discord_post.ps1 "本文" -WebhookUrl "https://discord.com/api/webhooks/..."
"@
}

function Get-LatestLogEntry {
    param([string]$Path)

    if (-not $Path) { $Path = Join-Path $repoRoot '進捗ログ.md' }
    if (-not (Test-Path $Path)) { throw "進捗ログが見つかりません: $Path" }

    $lines = Get-Content $Path -Encoding UTF8

    # 見出し「## 」で始まる行のうち最初の1件が最新エントリ（新しい順に追記する運用）
    $starts = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^##\s') { $starts += $i }
    }
    if ($starts.Count -eq 0) { throw "進捗ログにエントリ見出し（## ...）が見つかりません: $Path" }

    $from = $starts[0]
    $to = if ($starts.Count -ge 2) { $starts[1] - 1 } else { $lines.Count - 1 }

    $body = $lines[$from..$to]

    # 末尾の区切り線と空行を落とす
    while ($body.Count -gt 0 -and ($body[-1].Trim() -eq '' -or $body[-1].Trim() -eq '---')) {
        $body = $body[0..($body.Count - 2)]
    }

    return ($body -join "`n")
}

function Split-ForDiscord {
    param([string]$Text, [int]$Limit)

    $chunks = @()
    $buf = New-Object System.Text.StringBuilder

    foreach ($line in ($Text -split "`r?`n")) {
        # 1行が単体で上限を超える場合は、その行だけを強制分割する
        if ($line.Length -ge $Limit) {
            if ($buf.Length -gt 0) { $chunks += $buf.ToString().TrimEnd(); $buf.Clear() | Out-Null }
            for ($p = 0; $p -lt $line.Length; $p += $Limit) {
                $len = [Math]::Min($Limit, $line.Length - $p)
                $chunks += $line.Substring($p, $len)
            }
            continue
        }

        if ($buf.Length + $line.Length + 1 -gt $Limit) {
            $chunks += $buf.ToString().TrimEnd()
            $buf.Clear() | Out-Null
        }
        $buf.AppendLine($line) | Out-Null
    }

    if ($buf.Length -gt 0) { $chunks += $buf.ToString().TrimEnd() }
    return @($chunks | Where-Object { $_ -ne '' })
}

# --- 本文を決める ---------------------------------------------------------
$content = if ($FromLog) { Get-LatestLogEntry -Path $LogPath } else { $Message }
if (-not $content -or $content.Trim() -eq '') { throw '送信する本文が空です。' }

$chunks = @(Split-ForDiscord -Text $content -Limit $ChunkLimit)

if ($DryRun) {
    Write-Output "[DryRun] 送信せず内容のみ表示します（$($chunks.Count) 通、合計 $($content.Length) 文字）"
    for ($i = 0; $i -lt $chunks.Count; $i++) {
        Write-Output ("--- {0}/{1} ({2} 文字) ---" -f ($i + 1), $chunks.Count, $chunks[$i].Length)
        Write-Output $chunks[$i]
    }
    return
}

# --- 送信 -----------------------------------------------------------------
$url = Resolve-WebhookUrl -Explicit $WebhookUrl
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

for ($i = 0; $i -lt $chunks.Count; $i++) {
    $payload = @{
        content    = $chunks[$i]
        username   = $Username
        # @everyone / @here / ロール・ユーザーメンションを一切発火させない
        allowed_mentions = @{ parse = @() }
    } | ConvertTo-Json -Depth 5 -Compress

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)

    try {
        Invoke-RestMethod -Uri $url -Method Post `
            -ContentType 'application/json; charset=utf-8' -Body $bytes | Out-Null
    }
    catch {
        throw ("Discord への送信に失敗しました（{0}/{1} 通目）: {2}" -f ($i + 1), $chunks.Count, $_.Exception.Message)
    }

    # レート制限よけ（連投時のみ）
    if ($i -lt $chunks.Count - 1) { Start-Sleep -Milliseconds 700 }
}

Write-Output ("Discord へ送信しました（{0} 通、{1} 文字）" -f $chunks.Count, $content.Length)
