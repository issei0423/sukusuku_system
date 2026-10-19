#!/usr/bin/env bash
# マージ係（.github/workflows/merge.yml）の中身。gh と bash だけで動く（jq は使わず、gh の --jq だけ）。
# 手元の Git Bash でも、持ち主の gh で読むだけの試しを回せる（DRY_RUN=1）。
#
# 使い方:
#   merge-queue.sh check <PR番号>   … マージの条件を 1 つずつ出す（読むだけ）
#   merge-queue.sh pick             … 本線の先頭の CI と ci.yml の ref の付け忘れを見てから、
#                                     ラベル「マージ」の PR を付けた順に見て、入れられる 1 本を選ぶ。
#                                     決まった理由で入れられない PR は止める。選べなければ列の終わり
#   merge-queue.sh finish           … CI の結果を受けて、入れる／止める／列を止める。向け直しと次の dispatch
#   merge-queue.sh reject <PR番号>  … 持ち主でない人が付けたラベル「マージ」を外す
#
# 環境変数:
#   GH_TOKEN           … gh が使うトークン（ワークフローでは GITHUB_TOKEN、手元では gh auth のもの）
#   GITHUB_REPOSITORY  … owner/repo（無ければ gh repo view で取る）
#   DRY_RUN=1          … 書き込みのコマンド（ラベル・コメント・マージ・向け直し・dispatch）を実行せず、表示だけする
#   CANDIDATES="n …"   … DRY_RUN=1 のときだけ効く。ラベルの代わりに候補を直に渡す（並びは渡した順。pick と finish でラベルの条件は見ない）
#   finish だけ: PR・MERGE_SHA・BASE_SHA・HEAD_SHA（pick の出力）、CI_PR_RESULT・CI_MAIN_RESULT（needs.*.result）
#
# 条件の番号は、計画（マージ係の設計）の「マージの条件」の (1)〜(12) にそろえてある。

set -euo pipefail

MAIN=mockup-go-react
LABEL=マージ
STOP_LABEL=マージ止め

REPO=${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
OWNER=${GITHUB_REPOSITORY_OWNER:-${REPO%%/*}}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CI_FILE="$SCRIPT_DIR/../workflows/ci.yml"
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/$GITHUB_RUN_ID"
else
  RUN_URL="手元の試し。run は無い"
fi

# ---- 出力の道具 ----

# 画面と、Actions の Summary の両方に出す
say() {
  printf '%s\n' "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}

# ジョブの出力（手元では表示だけ）
out() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi
  printf '出力: %s=%s\n' "$1" "$2"
}

is_dry() { [ "${DRY_RUN:-}" = "1" ]; }

# コマンドを読める形にする（printf %q はロケールによって日本語を \343… にするので使わない）
showcmd() {
  local a s=""
  for a in "$@"; do
    case "$a" in
      "" | *[[:space:]\'\"\$\`\\\;\&\|\<\>\(\)\*\?]*) s+="'${a//\'/\'\\\'\'}' " ;;
      *) s+="$a " ;;
    esac
  done
  printf '%s' "${s% }"
}

# 書き込みのコマンド。DRY_RUN=1 なら実行せずに表示する
write() {
  if is_dry; then
    say "    - [DRY_RUN] $(showcmd "$@")"
  else
    "$@"
  fi
}

# PR へのコメント。DRY_RUN=1 なら本文を表示する
comment() {
  if is_dry; then
    say "    - [DRY_RUN] gh pr comment $1 の本文:"
    printf '%s\n' "$2" | while IFS= read -r l; do say "      | $l"; done
  else
    gh pr comment "$1" -R "$REPO" --body "$2" > /dev/null
  fi
}

# 日本時間の時刻（タイムゾーンのデータに頼らず、UTC に 9 時間足す）
jst() {
  local t=${1:-}
  if [ -z "$t" ]; then t=$(date -u +%Y-%m-%dT%H:%M:%SZ); fi
  date -u -d "@$(( $(date -u -d "$t" +%s) + 9 * 3600 ))" '+%Y-%m-%d %H:%M:%S JST'
}

# ---- GitHub から読む道具 ----

main_sha() { gh api "repos/$REPO/git/ref/heads/$MAIN" --jq .object.sha; }

# ci_run_of <commit の sha（40 桁）> <event の正規表現>
#   → ci.yml のいちばん新しい run の「conclusion status url」（conclusion が空なら -）。run が無ければ空
ci_run_of() {
  gh run list -R "$REPO" --workflow ci.yml --commit "$1" --limit 20 \
    --json event,status,conclusion,url,createdAt \
    --jq "[.[] | select(.event | test(\"$2\"))] | sort_by(.createdAt) | last | select(. != null)
          | \"\(if (.conclusion // \"\") == \"\" then \"-\" else .conclusion end) \(.status) \(.url)\""
}

is_red() { case "$1" in failure | timed_out | startup_failure) return 0 ;; *) return 1 ;; esac; }

# label_event <PR番号> → ラベル「マージ」を最後に付けた「login 時刻」。付けた記録が無ければ空
label_event() {
  gh api --paginate "repos/$REPO/issues/$1/events" \
    --jq ".[] | select(.event == \"labeled\" and .label.name == \"$LABEL\") | \"\(.actor.login) \(.created_at)\"" \
    | tail -n 1
}

# ---- 条件を見る ----

# evaluate <PR番号> <本線の先頭の sha> <待つ 1/0> [ラベルを見ない 1/0]
#   条件 (1)〜(9) を見て、V_VERDICT（ok／wait／stop／skip／retry）と理由、試しのマージ commit を決める。
#   条件ごとの行は V_LINES に溜める。待つ=1 なら、ぶつかりの計算と試しのマージ commit の作り直しを最大 1 分待つ
evaluate() {
  local n=$1 msha=$2 poll=$3 ignore_label=${4:-0}
  V_LINES="" V_VERDICT="" V_REASON="" V_FIX="" V_TITLE="" V_C1=0
  V_HEAD_SHA="" V_MERGE_SHA="" V_HEAD_REF="" V_BASE_REF=""

  local info state draft base head_ref fork has_label changers title
  info=$(gh pr view "$n" -R "$REPO" --json state,isDraft,baseRefName,headRefName,isCrossRepository,labels,latestReviews,title \
    --jq "[.state, .isDraft, .baseRefName, .headRefName, .isCrossRepository,
           any(.labels[]; .name == \"$LABEL\"),
           ([.latestReviews[] | select(.state == \"CHANGES_REQUESTED\") | .author.login] | join(\",\") | if . == \"\" then \"-\" else . end),
           .title] | map(tostring) | join(\" \")")
  read -r state draft base head_ref fork has_label changers title <<< "$info"
  V_TITLE=$title V_HEAD_REF=$head_ref V_BASE_REF=$base

  # (8)(9) ぶつかりと試しのマージ commit（GitHub が作る refs/pull/<n>/merge）
  local tries=1 i rest mergeable="" merge_sha="" head_sha="" p1="" p2=""
  if [ "$poll" = 1 ]; then tries=12; fi
  for ((i = 1; i <= tries; i++)); do
    rest=$(gh api "repos/$REPO/pulls/$n" --jq '"\(.mergeable) \(.merge_commit_sha) \(.head.sha)"')
    read -r mergeable merge_sha head_sha <<< "$rest"
    p1="" p2=""
    if [ "$mergeable" = "true" ] && [ "$base" = "$MAIN" ]; then
      read -r p1 p2 <<< "$(gh api "repos/$REPO/commits/$merge_sha" --jq '[.parents[].sha] | join(" ")')"
      if [ "$p1" = "$msha" ] && [ "$p2" = "$head_sha" ]; then break; fi
    elif [ "$mergeable" != "null" ]; then
      break
    fi
    if [ "$i" -lt "$tries" ]; then sleep 5; fi
  done
  V_HEAD_SHA=$head_sha V_MERGE_SHA=$merge_sha

  # (1) ラベル
  local ev actor="" at="" c1=0 l1
  ev=$(label_event "$n")
  if [ -n "$ev" ]; then actor=${ev%% *} at=${ev#* }; fi
  if [ "$has_label" = "true" ] && [ "$actor" = "$OWNER" ]; then
    c1=1 l1="○ 付いている。最後に付けたのは持ち主の $actor（$(jst "$at")）"
  elif [ "$has_label" = "true" ]; then
    l1="× 付いているが、最後に付けたのは ${actor:-（記録が無い）}（持ち主でない）"
  else
    l1="× 付いていない"
  fi
  if [ "$c1" = 0 ] && [ "$ignore_label" = 1 ]; then l1="－ ${l1#× }（試しなので、この条件は見ずに残りで決める）"; fi
  V_C1=$c1
  V_LINES+="(1) ラベル「$LABEL」を持ち主が付けた: $l1"$'\n'

  # (2) 下書き (3) base (4) フォーク
  if [ "$draft" = "false" ]; then V_LINES+="(2) 下書きでない: ○"$'\n'; else V_LINES+="(2) 下書きでない: × 下書き"$'\n'; fi
  if [ "$base" = "$MAIN" ]; then V_LINES+="(3) base が $MAIN: ○"$'\n'; else V_LINES+="(3) base が $MAIN: × base は $base（積み重ね）"$'\n'; fi
  if [ "$fork" = "false" ]; then V_LINES+="(4) フォークからでない: ○"$'\n'; else V_LINES+="(4) フォークからでない: × フォークからの PR"$'\n'; fi

  # (5) .github/ を変えていない（名前を変えたファイルは元の名前も見る）
  # 読めなかったときに「変えていない」としないよう、読むのと絞るのを分ける
  local files gh_files
  files=$(gh api --paginate "repos/$REPO/pulls/$n/files" --jq '.[] | .filename, (.previous_filename // empty)')
  gh_files=$(printf '%s\n' "$files" | grep '^\.github/' | sort -u | paste -sd ',' - || true)
  if [ -z "$gh_files" ]; then V_LINES+="(5) .github/ を変えていない: ○"$'\n'; else V_LINES+="(5) .github/ を変えていない: × $gh_files"$'\n'; fi

  # (6) 最新のレビューに「変更を求める」が無い
  if [ "$changers" = "-" ]; then V_LINES+="(6) 変更を求めるレビューが無い: ○"$'\n'; else V_LINES+="(6) 変更を求めるレビューが無い: × $changers が変更を求めている"$'\n'; fi

  # (7) head のいちばん新しい CI が赤でない
  local hrun hc="" hs="" hu="" head_red=0
  hrun=$(ci_run_of "$head_sha" '^pull_request$')
  if [ -n "$hrun" ]; then read -r hc hs hu <<< "$hrun"; fi
  if [ -z "$hrun" ]; then
    V_LINES+="(7) head（${head_sha:0:7}）の CI が赤でない: ○ run が無い（base が本線でない PR では CI が回らない）"$'\n'
  elif is_red "$hc"; then
    head_red=1
    V_LINES+="(7) head（${head_sha:0:7}）の CI が赤でない: × $hc（$hu）"$'\n'
  else
    V_LINES+="(7) head（${head_sha:0:7}）の CI が赤でない: ○ $hs/$hc（$hu）"$'\n'
  fi

  # (8) ぶつかり
  case "$mergeable" in
    true) V_LINES+="(8) ぶつかりが無い: ○（$base に対して）"$'\n' ;;
    false) V_LINES+="(8) ぶつかりが無い: × $base とぶつかる"$'\n' ;;
    *) V_LINES+="(8) ぶつかりが無い: × GitHub がまだ計算し終えていない（mergeable=$mergeable）"$'\n' ;;
  esac

  # (9) 試しのマージ commit の 1 つ目の親が本線の先頭
  local c9=0
  if [ "$base" != "$MAIN" ]; then
    V_LINES+="(9) 試しのマージ commit の 1 つ目の親が本線の先頭: － base が本線でないので見ない"$'\n'
  elif [ "$mergeable" = "false" ]; then
    V_LINES+="(9) 試しのマージ commit の 1 つ目の親が本線の先頭: － ぶつかるので見ない"$'\n'
  elif [ "$mergeable" != "true" ]; then
    V_LINES+="(9) 試しのマージ commit の 1 つ目の親が本線の先頭: － ぶつかりがまだ分からないので見ない"$'\n'
  elif [ "$p1" = "$msha" ] && [ "$p2" = "$head_sha" ]; then
    c9=1
    V_LINES+="(9) 試しのマージ commit の 1 つ目の親が本線の先頭: ○ ${merge_sha:0:7} の親は 本線 ${p1:0:7} ＋ head ${p2:0:7}"$'\n'
  else
    V_LINES+="(9) 試しのマージ commit の 1 つ目の親が本線の先頭: × ${merge_sha:0:7} の親は ${p1:0:7} ＋ ${p2:0:7}（本線の先頭は ${msha:0:7}）"$'\n'
  fi
  V_LINES+="(10)〜(12) 合わせた形の CI・入れる直前の本線と head・ラベル: pick のあとの CI と finish で見る"$'\n'

  # 入れられるか。止める理由が重なるときは、上のものを書く
  local relabel="直したら「$STOP_LABEL」を外し、「$LABEL」を付け直してください。"
  if [ "$state" != "OPEN" ]; then
    V_VERDICT=skip V_REASON="開いていない（$state）"
  elif [ "$c1" = 0 ] && [ "$ignore_label" != 1 ]; then
    V_VERDICT=skip V_REASON="持ち主が付けたラベルでない"
  elif [ "$fork" != "false" ]; then
    V_VERDICT=stop V_REASON="フォークからの PR です。" V_FIX="マージ係はフォークからの PR を入れません。持ち主が中身を見て、手で merge commit で押してください。"
  elif [ "$draft" != "false" ]; then
    V_VERDICT=stop V_REASON="下書きです。" V_FIX="Ready for review にしてから、「$STOP_LABEL」を外し、「$LABEL」を付け直してください。"
  elif [ "$base" != "$MAIN" ]; then
    V_VERDICT=wait V_REASON="base が $base（積み重ね）。土台が入って base が $MAIN へ向くまで待つ"
  elif [ -n "$gh_files" ]; then
    V_VERDICT=stop V_REASON="\`.github/\` を変えています（$gh_files）。" V_FIX="ワークフローを変える PR はマージ係が入れません。持ち主が中身を見て手で merge commit で押し、そのあと \`gh workflow run merge.yml --ref $MAIN\` で続きを回してください。"
  elif [ "$changers" != "-" ]; then
    V_VERDICT=stop V_REASON="変更を求めるレビューがあります（$changers）。" V_FIX="レビューに応えて直し、レビューした人に承認してもらうか、取り下げてもらってください。$relabel"
  elif [ "$head_red" = 1 ]; then
    V_VERDICT=stop V_REASON="head（${head_sha:0:7}）の CI が赤です（$hu）。" V_FIX="直して push し、CI が緑になってから、「$STOP_LABEL」を外し、「$LABEL」を付け直してください。"
  elif [ "$mergeable" = "false" ]; then
    V_VERDICT=stop V_REASON="本線（$MAIN）とぶつかります。" V_FIX="手元の Claude に「#$n のぶつかりを解いて」と頼んでください（#234 の解き方）。解いて CI が緑になってから、「$STOP_LABEL」を外し、「$LABEL」を付け直してください。"
  elif [ "$mergeable" != "true" ]; then
    V_VERDICT=retry V_REASON="GitHub がぶつかりの計算を 1 分で終えなかった"
  elif [ "$c9" != 1 ]; then
    V_VERDICT=retry V_REASON="試しのマージ commit が本線の先頭（${msha:0:7}）に 1 分で追いつかなかった"
  else
    V_VERDICT=ok V_REASON="入れられる。本線 ${msha:0:7} と合わせた試しのマージ commit ${merge_sha:0:7} で CI に進む"
  fi
}

verdict_word() {
  case "$1" in
    ok) echo "入れる候補" ;; wait) echo "待つ" ;; stop) echo "止める" ;; skip) echo "見ない" ;; retry) echo "列を止める" ;;
  esac
}

# stop_pr <PR番号> <理由> <直し方>
stop_pr() {
  write gh pr edit "$1" -R "$REPO" --remove-label "$LABEL" --add-label "$STOP_LABEL"
  comment "$1" "マージ係が、この PR を入れずに止めました。

- 理由：$2
- 直し方：$3

（マージ係の run：$RUN_URL）"
}

dispatch_next() {
  say "- 次の PR へ進む（merge.yml を dispatch する）"
  write gh workflow run merge.yml -R "$REPO" --ref "$MAIN"
}

# ---- サブコマンド ----

cmd_check() {
  local n=${1:?PR の番号を渡す}
  local msha
  msha=$(main_sha)
  # ラベルが付いていない PR でも、付けたらどうなるかを出す（(1) は行に出し、判定では見ない）
  evaluate "$n" "$msha" 1 1
  say "## #$n $V_TITLE"
  say "本線 $MAIN の先頭 ${msha:0:7}、$(jst)"
  say ""
  printf '%s' "$V_LINES" | while IFS= read -r l; do say "- $l"; done
  say ""
  if [ "$V_C1" = 1 ]; then
    say "→ $(verdict_word "$V_VERDICT")：$V_REASON"
  else
    say "→ いまは見ない（(1) を満たさない）。持ち主が「$LABEL」を付ければ：$(verdict_word "$V_VERDICT")：$V_REASON"
  fi
  if [ -n "$V_FIX" ]; then say "  直し方：$V_FIX"; fi
}

cmd_pick() {
  say "## マージ係：pick（$(jst)）"
  if is_dry; then say "- DRY_RUN：書き込みのコマンドは表示だけ"; fi

  local msha mrun mc="" ms="" mu=""
  msha=$(main_sha)
  mrun=$(ci_run_of "$msha" '^(push|workflow_dispatch)$')
  if [ -n "$mrun" ]; then read -r mc ms mu <<< "$mrun"; fi
  if [ -z "$mrun" ]; then
    say "- 本線 $MAIN の先頭 ${msha:0:7}：CI の run はまだ無い"
  else
    say "- 本線 $MAIN の先頭 ${msha:0:7}：CI は $ms/$mc（$mu）"
  fi
  if is_red "$mc"; then
    say "- **列を止める**：本線の先頭の CI が赤。本線を直してから \`gh workflow run merge.yml --ref $MAIN\` で続きを回す"
    out pr ""
    return 1
  fi

  # ci.yml の checkout の数と ref: ${{ inputs.ref }} の数（付け忘れたジョブは本線の形で回ってしまう）
  local nco nref
  nco=$(grep -cE '^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*actions/checkout@' "$CI_FILE" || true)
  nref=$(grep -cE '^[[:space:]]*ref:[[:space:]]*\$\{\{[[:space:]]*inputs\.ref[[:space:]]*\}\}' "$CI_FILE" || true)
  if [ "$nco" = 0 ] || [ "$nco" != "$nref" ]; then
    say "- **列を止める**：ci.yml の actions/checkout が $nco か所、ref: \${{ inputs.ref }} が $nref か所で合わない。付け忘れたジョブは本線と合わせた形を回さない"
    out pr ""
    return 1
  fi
  say "- ci.yml：actions/checkout $nco か所すべてに ref: \${{ inputs.ref }} がある"

  # 候補を、ラベルを付けた時刻の古い順（同じ時刻なら番号の小さい順）に並べる
  local order="" n ev ignore_label=0
  if is_dry && [ -n "${CANDIDATES:-}" ]; then
    for n in $CANDIDATES; do
      case "$n" in *[!0-9]*) say "- CANDIDATES に番号でないもの（$n）がある"; return 1 ;; esac
    done
    order=$CANDIDATES ignore_label=1
    say "- 候補（CANDIDATES で直に渡した。渡した順に見る。ラベルの条件は見ない）：$order"
  else
    if [ -n "${CANDIDATES:-}" ]; then say "- CANDIDATES は DRY_RUN=1 のときだけ効くので使わない"; fi
    local nums lines=""
    nums=$(gh pr list -R "$REPO" --label "$LABEL" --state open --limit 200 --json number --jq '.[].number')
    for n in $nums; do
      ev=$(label_event "$n")
      if [ "${ev%% *}" = "$OWNER" ]; then
        lines+="${ev#* } $n"$'\n'
      else
        say "- #$n：ラベル「$LABEL」を最後に付けたのが持ち主でない（${ev%% *}）ので見ない"
      fi
    done
    order=$(printf '%s' "$lines" | sort -k1,1 -k2,2n | awk 'NF { print $2 }' | paste -sd ' ' -)
    say "- 候補（ラベル「$LABEL」を持ち主が付けた順）：${order:-（無い）}"
  fi

  local picked="" halted=0
  for n in $order; do
    if [ -n "$picked" ] || [ "$halted" = 1 ]; then
      # 本番はここで終わる。試しのときは、後ろの候補で何をするはずかも出す
      if ! is_dry; then break; fi
      evaluate "$n" "$msha" 0 "$ignore_label"
      say "- #$n $V_TITLE → この run では見ない（いま見れば：$(verdict_word "$V_VERDICT")。$V_REASON）"
      continue
    fi
    evaluate "$n" "$msha" 1 "$ignore_label"
    say "- #$n $V_TITLE → **$(verdict_word "$V_VERDICT")**：$V_REASON"
    printf '%s' "$V_LINES" | while IFS= read -r l; do say "    - $l"; done
    case "$V_VERDICT" in
      ok) picked=$n
        out pr "$n"
        out ref "$V_MERGE_SHA"
        out base_sha "$msha"
        out head_sha "$V_HEAD_SHA" ;;
      stop) stop_pr "$n" "$V_REASON" "$V_FIX" ;;
      retry) halted=1
        say "- **列を止める**：#$n で $V_REASON。少し待って \`gh workflow run merge.yml --ref $MAIN\` で回し直す" ;;
    esac
  done

  if [ "$halted" = 1 ]; then
    if [ -z "$picked" ]; then out pr ""; fi
    return 1
  fi
  if [ -n "$picked" ]; then
    say "- → #$picked を、本線と合わせた試しのマージ commit で CI に回す"
    return 0
  fi

  # 列の終わり。GITHUB_TOKEN で入れた本線には push の CI が走らないので、無ければここで回す
  out pr ""
  if [ -z "$mrun" ]; then
    say "- 列の終わり：本線の先頭に CI の run が無いので、ci.yml を回す"
    write gh workflow run ci.yml -R "$REPO" --ref "$MAIN"
  else
    say "- 列の終わり：入れられる PR は無い"
  fi
}

cmd_finish() {
  local n=${PR:?} merge_sha=${MERGE_SHA:?} base_sha=${BASE_SHA:?} head_sha=${HEAD_SHA:?}
  local ci_pr=${CI_PR_RESULT:-} ci_main=${CI_MAIN_RESULT:-}
  say "## マージ係：finish #$n（$(jst)）"
  if is_dry; then say "- DRY_RUN：書き込みのコマンドは表示だけ"; fi
  say "- 試しのマージ commit ${merge_sha:0:7}（本線 ${base_sha:0:7} ＋ head ${head_sha:0:7}）"
  say "- CI：本線と合わせた形 = ${ci_pr:-（無い）}、本線の先頭 = ${ci_main:-（回していない）}"

  # (11)(12) 試したときから、本線・head・ラベル・PR の形が変わっていないか
  local msha info state draft base head_ref has_label changers now_head
  msha=$(main_sha)
  info=$(gh pr view "$n" -R "$REPO" --json state,isDraft,baseRefName,headRefName,headRefOid,labels,latestReviews \
    --jq "[.state, .isDraft, .baseRefName, .headRefName, .headRefOid,
           any(.labels[]; .name == \"$LABEL\"),
           ([.latestReviews[] | select(.state == \"CHANGES_REQUESTED\") | .author.login] | join(\",\") | if . == \"\" then \"-\" else . end)]
          | map(tostring) | join(\" \")")
  read -r state draft base head_ref now_head has_label changers <<< "$info"
  if [ "$state" != "OPEN" ]; then
    say "- #$n はもう開いていない（$state）。何もしない"; dispatch_next; return 0
  fi
  if [ "$has_label" != "true" ]; then
    if is_dry && [ -n "${CANDIDATES:-}" ]; then
      say "- ラベル「$LABEL」は付いていないが、CANDIDATES で渡した試しなので、この条件は見ずに進む"
    else
      say "- ラベル「$LABEL」が外された。入れない"; dispatch_next; return 0
    fi
  else
    # (1) 入れる直前にも、いま付いているラベルを最後に付けたのが持ち主かを見る（CI のあいだに別の人が付け直したとき）
    local ev2
    ev2=$(label_event "$n")
    if [ "${ev2%% *}" != "$OWNER" ]; then
      say "- ラベル「$LABEL」を最後に付けたのが持ち主でなくなった（${ev2%% *}）。入れない"; dispatch_next; return 0
    fi
  fi
  if [ "$msha" != "$base_sha" ] || [ "$now_head" != "$head_sha" ] || [ "$base" != "$MAIN" ]; then
    say "- 試したあとに本線（いま ${msha:0:7}）か head（いま ${now_head:0:7}）か base（いま $base）が動いた。入れずに、次の run で試し直す"
    dispatch_next; return 0
  fi
  if [ "$draft" != "false" ] || [ "$changers" != "-" ]; then
    say "- 試しているあいだに、下書きになったか、変更を求めるレビューが付いた。入れずに、次の run の pick で止める"
    dispatch_next; return 0
  fi

  case "$ci_pr" in
    success)
      # (10) 全ジョブが緑。merge commit で入れる（head が変わっていたら GitHub が断る）
      if ! write gh pr merge "$n" -R "$REPO" --merge --match-head-commit "$head_sha"; then
        say "- **列を止める**：gh pr merge が失敗した。理由を見て、直してから \`gh workflow run merge.yml --ref $MAIN\` で続きを回す"
        return 1
      fi
      if is_dry; then say "- （DRY_RUN なので入れていない）"; else say "- #$n を merge commit で入れた"; fi

      # 入れたあとの片付けは、1 つ失敗しても残りを続ける（run は赤で終えて知らせる）
      local post_fail=0 kids m
      comment "$n" "マージ係が merge commit で入れました。本線 ${base_sha:0:7} と合わせた試しのマージ commit ${merge_sha:0:7} で ci.yml を回し、ジョブが全部緑でした（$RUN_URL）。" \
        || { post_fail=1; say "- #$n にコメントを書けなかった"; }

      # 上に積んだ PR の base を本線へ向け直す（向け直しの edited では CI が走らないので、CI はマージ係が回す）
      kids=$(gh pr list -R "$REPO" --base "$head_ref" --state open --limit 100 --json number --jq '.[].number') \
        || { post_fail=1; kids=""; say "- 上に積んだ PR を読めなかった。手で向け直す（gh pr edit <番号> --base $MAIN）"; }
      for m in $kids; do
        if write gh pr edit "$m" -R "$REPO" --base "$MAIN"; then
          say "- #$m の base を $head_ref から $MAIN へ向け直す"
        else
          post_fail=1; say "- #$m の base を向け直せなかった。手で gh pr edit $m --base $MAIN"
        fi
      done
      dispatch_next
      return "$post_fail"
      ;;
    failure)
      case "$ci_main" in
        success)
          say "- 本線と合わせた形で CI が赤、本線の先頭では緑。#$n を止める"
          stop_pr "$n" "本線 ${base_sha:0:7} と合わせた試しのマージ commit ${merge_sha:0:7} で CI が赤でした（$RUN_URL）。本線の先頭だけなら緑なので、この PR と本線の組み合わせで落ちています。" \
            "本線を取り込んで手元でテストを回し、直して push してください。CI が緑になってから、「$STOP_LABEL」を外し、「$LABEL」を付け直してください。"
          dispatch_next
          ;;
        failure)
          say "- **列を止める**：本線の先頭（${base_sha:0:7}）でも CI が赤。#$n は止めない（ラベルはそのまま）"
          comment "$n" "本線の先頭（${base_sha:0:7}）でも CI が赤だったので、マージ係は列を止めました。この PR は止めていません（ラベル「$LABEL」はそのまま）。本線を直したあと、\`gh workflow run merge.yml --ref $MAIN\` で続きを回してください（$RUN_URL）。"
          return 1
          ;;
        *)
          say "- **列を止める**：本線の先頭の CI が終わらなかった（${ci_main:-（結果が無い）}）。\`gh workflow run merge.yml --ref $MAIN\` で回し直す"
          return 1
          ;;
      esac
      ;;
    *)
      say "- **列を止める**：本線と合わせた形の CI が終わらなかった（${ci_pr:-（結果が無い）}）。\`gh workflow run merge.yml --ref $MAIN\` で回し直す"
      return 1
      ;;
  esac
}

cmd_reject() {
  local n=${1:?PR の番号を渡す}
  local ev actor has_label
  ev=$(label_event "$n")
  actor=${ev%% *}
  if [ "$actor" = "$OWNER" ]; then
    say "- #$n：ラベル「$LABEL」を最後に付けたのは持ち主。何もしない"
    return 0
  fi
  has_label=$(gh pr view "$n" -R "$REPO" --json labels --jq "any(.labels[]; .name == \"$LABEL\")")
  if [ "$has_label" != "true" ]; then
    say "- #$n：ラベル「$LABEL」はもう付いていない。何もしない"
    return 0
  fi
  say "- #$n：ラベル「$LABEL」を付けたのが持ち主でない（${actor:-（記録が無い）}）ので外す"
  write gh pr edit "$n" -R "$REPO" --remove-label "$LABEL"
  comment "$n" "ラベル「$LABEL」は、持ち主（$OWNER）が付けたものだけを受け付けます。${actor:-持ち主でない人} が付けたので外しました。マージしてほしいときは、持ち主に頼んでください。"
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  pick) cmd_pick ;;
  finish) cmd_finish ;;
  reject) shift; cmd_reject "$@" ;;
  *)
    echo "使い方: $0 check <PR番号> | pick | finish | reject <PR番号>" >&2
    exit 2
    ;;
esac
