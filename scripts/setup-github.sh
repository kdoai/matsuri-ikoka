#!/usr/bin/env bash
# GitHub に公開したリポジトリに、安全と運用の設定を入れる。何度実行しても同じ結果になる。
#
# 使い方:
#   bash scripts/setup-github.sh check [owner/repo]   いまの設定を確かめる（足りなければ終了コード 1）
#   bash scripts/setup-github.sh apply [owner/repo]   設定を入れる
#
# owner/repo を省くと、いまのディレクトリの GitHub のリモートを使う。
# 必要なもの：GitHub CLI（gh）に、リポジトリの管理者でログインしていること。
set -euo pipefail

# main に必須にする検査。.github/workflows/ci.yml のジョブ名と同じにする
REQUIRED_CHECK="検査とビルド"
RULESET_NAME="protect-main"
TEMPLATES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/ISSUE_TEMPLATE"

mode="${1:-}"
if [[ "$mode" != "check" && "$mode" != "apply" ]]; then
  echo "使い方: bash scripts/setup-github.sh check|apply [owner/repo]" >&2
  exit 2
fi
repo="${2:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

# Issue テンプレートが付けるラベル（名前|説明）。説明はテンプレートの name を使う
labels() {
  local file label description
  for file in "$TEMPLATES_DIR"/*.yml; do
    label="$(sed -n 's/^labels: \["\([^"]*\)"\]$/\1/p' "$file")"
    [[ -z "$label" ]] && continue
    description="$(sed -n 's/^name: //p' "$file")"
    echo "$label|$description"
  done
}

label_color() {
  case "$1" in
    bug) echo "d73a4a" ;;
    data-correction) echo "fbca04" ;;
    opt-out) echo "5319e7" ;;
    listing-request) echo "0e8a16" ;;
    *) echo "ededed" ;;
  esac
}

ruleset_id() {
  gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id"
}

# main を守るルール：削除と強制 push を禁じ、PR と CI の通過を必須にする。
# 承認の数は 0（1人でも回せるように）。最新の main に追いつくことまでは求めない
ruleset_json() {
  cat <<JSON
{
  "name": "$RULESET_NAME",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "$REQUIRED_CHECK" }]
      }
    }
  ]
}
JSON
}

apply() {
  echo "== 秘密情報の検出と push の保護、マージは squash merge だけ（$repo）"
  gh api -X PATCH "repos/$repo" --silent --input - <<'JSON'
{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "delete_branch_on_merge": true,
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON

  echo "== 脆弱性の非公開の報告と、依存の脆弱性の通知"
  gh api -X PUT "repos/$repo/private-vulnerability-reporting" --silent
  gh api -X PUT "repos/$repo/vulnerability-alerts" --silent

  echo "== main の保護（ルールセット $RULESET_NAME）"
  local id
  id="$(ruleset_id)"
  if [[ -n "$id" ]]; then
    ruleset_json | gh api -X PUT "repos/$repo/rulesets/$id" --silent --input -
  else
    ruleset_json | gh api -X POST "repos/$repo/rulesets" --silent --input -
  fi

  echo "== Issue テンプレートのラベル"
  local name description
  while IFS='|' read -r name description; do
    gh label create "$name" --repo "$repo" --color "$(label_color "$name")" \
      --description "$description" --force >/dev/null
    echo "   $name"
  done < <(labels)
}

check() {
  local failed=0

  report() {
    if [[ "$2" == "$3" ]]; then
      printf '  OK  %s\n' "$1"
    else
      printf '  NG  %s（いま：%s）\n' "$1" "${2:-なし}"
      failed=1
    fi
  }

  echo "== $repo"
  local settings
  settings="$(gh api "repos/$repo" --jq '[
    .security_and_analysis.secret_scanning.status // "",
    .security_and_analysis.secret_scanning_push_protection.status // "",
    .allow_squash_merge, .allow_merge_commit, .allow_rebase_merge, .delete_branch_on_merge
  ] | map(tostring) | join(",")')"
  IFS=, read -r scanning push_protection squash merge rebase delete_branch <<<"$settings"
  report "秘密情報の検出" "$scanning" "enabled"
  report "push の保護" "$push_protection" "enabled"
  report "squash merge を許す" "$squash" "true"
  report "マージコミットを許さない" "$merge" "false"
  report "rebase merge を許さない" "$rebase" "false"
  report "マージしたブランチを消す" "$delete_branch" "true"

  report "脆弱性の非公開の報告" \
    "$(gh api "repos/$repo/private-vulnerability-reporting" --jq '.enabled | tostring')" "true"
  if gh api "repos/$repo/vulnerability-alerts" --silent 2>/dev/null; then
    report "依存の脆弱性の通知" "enabled" "enabled"
  else
    report "依存の脆弱性の通知" "disabled" "enabled"
  fi

  local id
  id="$(ruleset_id)"
  if [[ -z "$id" ]]; then
    report "main の保護（$RULESET_NAME）" "" "active"
  else
    report "main の保護（$RULESET_NAME）" \
      "$(gh api "repos/$repo/rulesets/$id" --jq .enforcement)" "active"
    report "main に必須の検査（$REQUIRED_CHECK）" \
      "$(gh api "repos/$repo/rulesets/$id" --jq '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | join(",")')" \
      "$REQUIRED_CHECK"
  fi

  local existing name description
  existing="$(gh label list --repo "$repo" --limit 200 --json name --jq '.[].name')"
  while IFS='|' read -r name description; do
    if grep -qxF "$name" <<<"$existing"; then
      report "ラベル $name" "$name" "$name"
    else
      report "ラベル $name" "" "$name"
    fi
  done < <(labels)

  return "$failed"
}

"$mode"
