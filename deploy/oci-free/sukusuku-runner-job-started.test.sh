#!/usr/bin/env bash
# sukusuku-runner-job-started.sh の判定を、環境変数を変えて確かめる。VM ではなく手元で回す。
#   bash deploy/oci-free/sukusuku-runner-job-started.test.sh
# runner と同じく `bash -e 台本` で呼ぶ。環境は env -i で空にし、各場合の GITHUB_* だけを渡す。
set -euo pipefail

hook="$(dirname -- "${BASH_SOURCE[0]}")/sukusuku-runner-job-started.sh"
repo='issei0423/sukusuku_system'
main='refs/heads/mockup-go-react'
deploy_main="$repo/.github/workflows/deploy-oci.yml@$main"

passed=0
failed=0

# check 名前 期待（通る／止まる） 出力に含まれるはずの文字列 [変数=値 ...]
check() {
  local title=$1 want=$2 needle=$3
  shift 3
  local status=0 output got
  output=$(env -i PATH="$PATH" "$@" bash -e "$hook" 2>&1) || status=$?
  if (( status == 0 )); then got=通る; else got=止まる; fi
  if [[ $got == "$want" && $output == *"$needle"* ]]; then
    passed=$((passed + 1))
    printf '通過：%s（%s、終了コード %d）\n' "$title" "$got" "$status"
  else
    failed=$((failed + 1))
    printf '失敗：%s（期待 %s、実際 %s、終了コード %d、出力に「%s」が要る）\n%s\n' \
      "$title" "$want" "$got" "$status" "$needle" "$output"
  fi
}

# 通る形：本線への push で動いた deploy-oci.yml
check '本線への push の deploy-oci.yml' 通る '続けます' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF="$main" GITHUB_WORKFLOW_REF="$deploy_main"

# 止まる形：リポジトリが違う
check '別のリポジトリ' 止まる 'GITHUB_REPOSITORY' \
  GITHUB_REPOSITORY=someone/sukusuku_system GITHUB_EVENT_NAME=push GITHUB_REF="$main" \
  GITHUB_WORKFLOW_REF="someone/sukusuku_system/.github/workflows/deploy-oci.yml@$main"
check 'リポジトリ名の大文字違い' 止まる 'GITHUB_REPOSITORY' \
  GITHUB_REPOSITORY=Issei0423/sukusuku_system GITHUB_EVENT_NAME=push GITHUB_REF="$main" GITHUB_WORKFLOW_REF="$deploy_main"

# 止まる形：イベントが push でない
check 'pull_request' 止まる 'GITHUB_EVENT_NAME' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/pull/1/merge \
  GITHUB_WORKFLOW_REF="$repo/.github/workflows/deploy-oci.yml@refs/pull/1/merge"
check '本線の workflow_dispatch' 止まる 'GITHUB_EVENT_NAME' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF="$main" GITHUB_WORKFLOW_REF="$deploy_main"
check '本線の schedule' 止まる 'GITHUB_EVENT_NAME' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=schedule GITHUB_REF="$main" GITHUB_WORKFLOW_REF="$deploy_main"
check '本線の workflow_run' 止まる 'GITHUB_EVENT_NAME' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=workflow_run GITHUB_REF="$main" GITHUB_WORKFLOW_REF="$deploy_main"

# 止まる形：ブランチ・タグが本線でない
check '作業ブランチへの push（同じ deploy-oci.yml）' 止まる 'GITHUB_REF' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/feature \
  GITHUB_WORKFLOW_REF="$repo/.github/workflows/deploy-oci.yml@refs/heads/feature"
check '本線の名前で始まる別のブランチ' 止まる 'GITHUB_REF' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF="$main-x" \
  GITHUB_WORKFLOW_REF="$repo/.github/workflows/deploy-oci.yml@$main-x"
check 'タグへの push' 止まる 'GITHUB_REF' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/v1 \
  GITHUB_WORKFLOW_REF="$repo/.github/workflows/deploy-oci.yml@refs/tags/v1"
check 'ref にパターンの文字' 止まる 'GITHUB_REF' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF='refs/heads/*' GITHUB_WORKFLOW_REF="$deploy_main"

# 止まる形：ワークフローが deploy-oci.yml でない、または本線のものでない
check '本線への push の別のワークフロー' 止まる 'GITHUB_WORKFLOW_REF' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF="$main" \
  GITHUB_WORKFLOW_REF="$repo/.github/workflows/ci.yml@$main"
check 'ワークフローの ref だけが本線でない' 止まる 'GITHUB_WORKFLOW_REF' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF="$main" \
  GITHUB_WORKFLOW_REF="$repo/.github/workflows/deploy-oci.yml@refs/heads/feature"

# 止まる形：変数が無い・空・余計な文字がある
check 'GITHUB_WORKFLOW_REF が無い' 止まる 'GITHUB_WORKFLOW_REF が「（空）」' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF="$main"
check '変数が一つも無い' 止まる 'GITHUB_REPOSITORY が「（空）」'
check '変数がすべて空' 止まる 'GITHUB_EVENT_NAME が「（空）」' \
  GITHUB_REPOSITORY= GITHUB_EVENT_NAME= GITHUB_REF= GITHUB_WORKFLOW_REF=
check '値の末尾に改行' 止まる 'GITHUB_REF' \
  GITHUB_REPOSITORY="$repo" GITHUB_EVENT_NAME=push GITHUB_REF="$main"$'\n' GITHUB_WORKFLOW_REF="$deploy_main"

printf '通った %d 件、落ちた %d 件\n' "$passed" "$failed"
(( failed == 0 ))
