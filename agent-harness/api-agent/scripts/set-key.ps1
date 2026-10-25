# api-agent の API キーを、この Windows のユーザーだけが戻せる形（DPAPI）で置く。
#   置き場：~/.sukusuku-api-agent/anthropic-key.dpapi（ConvertFrom-SecureString の出力。平文は書かない）
#
# 使い方（agent-harness\api-agent の中で。キーは自分で貼る。Claude に貼らない）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1
# キーを貼って Enter。画面には出ない。キーを画面・ファイル・記録に平文で出さない。
# 使うときは scripts\agent.ps1 を通す（このプロセスの中だけに ANTHROPIC_API_KEY を置いて npm run agent を回す）。
#
# ユーザー環境変数（setx）には置かない。ターミナルの Claude Code が、契約のログインよりそのキーを先に使い、
# 「Invalid API key」で止まる（2026-10-24 に起きた）。
#
# 終了コード：0 置いた・2 キーの形が違うので書かなかった

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$dir = Join-Path $HOME '.sukusuku-api-agent'
$file = Join-Path $dir 'anthropic-key.dpapi'

$secure = Read-Host -AsSecureString 'Anthropic の API キーを貼って Enter（画面には出ません）'

# 形を確かめるあいだだけ、平文をこのプロセスのメモリに戻す（表示も記録もしない）
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ($null -eq $key) { $key = '' }
$key = $key.Trim()

$problem = $null
if ($key.Length -eq 0) {
  $problem = 'キーが空でした。'
} elseif (-not $key.StartsWith('sk-ant-', [StringComparison]::Ordinal)) {
  $problem = 'キーの頭が sk-ant- ではありません。Claude Console（https://platform.claude.com/）の API Keys で作ったキーを貼ってください。'
} elseif ($key.StartsWith('sk-ant-sk-ant-', [StringComparison]::Ordinal) -or ([regex]::Matches($key, 'sk-ant-')).Count -gt 1) {
  $problem = 'sk-ant- が2回入っています（コピーが重なった）。キーを1回だけ貼ってください。'
} elseif ($key -match '\s') {
  $problem = 'キーの途中に空白か改行があります。キーを1行で貼ってください。'
}
if ($problem) {
  $key = $null
  Write-Host "書かずに止めた：$problem"
  exit 2
}

$clean = ConvertTo-SecureString -String $key -AsPlainText -Force
$key = $null
# DPAPI（いまの Windows のユーザーだけが戻せる）。出力は暗号化した16進の文字だけ
$encrypted = ConvertFrom-SecureString -SecureString $clean
New-Item -ItemType Directory -Force -Path $dir | Out-Null
[IO.File]::WriteAllText($file, $encrypted, [Text.Encoding]::ASCII)
Write-Host "置いた：$file（DPAPI。この Windows のユーザーだけが戻せる）"
Write-Host '使うときは：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent.ps1 <コマンド> [オプション]'

# 前に setx で置いたキーが残っていると、ターミナルの Claude Code がそれを先に使う（値は見ない・消さない。消すのは持ち主）
if ([Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')) {
  Write-Host ''
  Write-Host '注意：ユーザー環境変数に ANTHROPIC_API_KEY が残っています。ターミナルの Claude Code が契約のログインより先にそれを使います。'
  Write-Host "  消すとき：[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', `$null, 'User')  のあと、ターミナルを開き直す"
}
exit 0
