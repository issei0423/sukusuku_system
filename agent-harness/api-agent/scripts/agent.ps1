# api-agent を回す入口（Windows の PowerShell）。
# scripts\set-key.ps1 で置いたキー（~/.sukusuku-api-agent/anthropic-key.dpapi）を戻し、このプロセスの中だけの
# $env:ANTHROPIC_API_KEY にして、npm run agent -- <引数> を回す。ユーザー環境変数には置かない。
# キーのファイルが無い（戻せない）ときは、キー無しで回す。queue はモデルを呼ばずに動き、ほかのコマンドは今のとおり止まる（終了コード 3）。
#
# 使い方（どこからでも。タスク スケジューラーもこの形）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\calif\sukusuku_system\agent-harness\api-agent\scripts\agent.ps1 queue
#   powershell -NoProfile -ExecutionPolicy Bypass -File …\scripts\agent.ps1 merge --dry-run
# 終了コードは npm run agent のもの（README「使い方」）。

$ErrorActionPreference = 'Stop'

$agentDir = Split-Path -Parent $PSScriptRoot
$file = Join-Path (Join-Path $HOME '.sukusuku-api-agent') 'anthropic-key.dpapi'

$haveKey = $false
if (Test-Path -LiteralPath $file) {
  try {
    $secure = ConvertTo-SecureString -String ([IO.File]::ReadAllText($file).Trim())
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $haveKey = $true
  } catch {
    # 別の Windows のユーザーで置いた・タスクを「パスワードを保存しない」で回している（DPAPI が使えない）・ファイルが壊れている
    Write-Host "キーのファイルを戻せなかったので、キー無しで回す：$file（置き直すときは scripts\set-key.ps1）"
  }
} else {
  Write-Host "キーのファイルが無いので、キー無しで回す：$file（置くときは scripts\set-key.ps1）"
}
if (-not $haveKey) {
  # ユーザー環境変数に古いキーが残っていても使わない（キーは set-key.ps1 のファイルからだけ）
  Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
  Write-Host 'queue はモデルを呼ばずに動く（ぶつかり・CI の落ちは「マージ止め」にする）。'
}

# npm.ps1 ではなく npm.cmd を呼び、引数は配列で渡す（-- や --dry-run を、そのまま npm へ渡すため）
$npmArgs = @('run', 'agent', '--') + $args
$code = 1
Push-Location -LiteralPath $agentDir
try {
  & npm.cmd @npmArgs
  $code = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
}
exit $code
