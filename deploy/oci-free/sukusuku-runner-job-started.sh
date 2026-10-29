#!/usr/bin/env bash
# 専用 runner `sukusuku-prod` が、ジョブを走らせる前に呼ぶ台本（ACTIONS_RUNNER_HOOK_JOB_STARTED）。
# 本線（mockup-go-react）への push で動いた deploy-oci.yml のジョブだけを通す。
# ワークフローは本線に入っていなくても、ブランチへの push で動く。runs-on が合えば、そのジョブもこの VM に届く。
# ここで止めれば、ジョブのステップは一つも走らない。
#
# 典拠（GitHub Docs）
# - 「Running scripts before or after a job」：0 以外で終わると、ジョブは走らず失敗になる。台本は既定の変数を読める。
# - 「Variables reference」：既定の変数 GITHUB_* は、ワークフローから上書きできない。
#
# 置き方・確かめ方・戻し方は README.md の「ジョブの出どころを確かめるフック」にある。
# 判定は sukusuku-runner-job-started.test.sh で確かめる。
set -euo pipefail

repository='issei0423/sukusuku_system'
branch_ref='refs/heads/mockup-go-react'

reasons=()

# 名前で渡した変数が、期待する値とそのまま同じかを見る。違えば、わけを reasons に足す。
expect() {
  local name=$1 expected=$2
  local actual=${!name-}
  if [[ $actual != "$expected" ]]; then
    reasons+=("$name が「${actual:-（空）}」です。通すのは「$expected」だけです。")
  fi
}

expect GITHUB_REPOSITORY "$repository"
expect GITHUB_EVENT_NAME push
expect GITHUB_REF "$branch_ref"
expect GITHUB_WORKFLOW_REF "$repository/.github/workflows/deploy-oci.yml@$branch_ref"

if (( ${#reasons[@]} > 0 )); then
  echo 'この runner は、本線への push で動いた自動デプロイのジョブだけを走らせます。このジョブは走らせません。' >&2
  printf -- '- %s\n' "${reasons[@]}" >&2
  exit 1
fi

echo '本線への push で動いた自動デプロイのジョブです。続けます。'
