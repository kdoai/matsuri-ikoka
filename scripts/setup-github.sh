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

# main に必須にする検査。.github/workflows/ci.yml のジョブの name と同じにする。
# 「検査とビルド」はすべてのジョブの結果をまとめたもの
# （scripts/github-config.test.ts で突き合わせる）
REQUIRED_CHECKS=(lint typecheck test validate-data build docker secrets actionlint dependency-review 検査とビルド)
RULESET_NAME="protect-main"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABELS_FILE="$ROOT_DIR/.github/labels.json"

mode="${1:-}"
if [[ "$mode" != "check" && "$mode" != "apply" ]]; then
  echo "使い方: bash scripts/setup-github.sh check|apply [owner/repo]" >&2
  exit 2
fi
repo="${2:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

# ラベルの一覧（名前|色|説明）。.github/labels.json から読む。
# Issue テンプレートが付けるラベルは、すべてこの一覧にある（scripts/github-config.test.ts で確かめる）
labels() {
  node -e '
    for (const l of JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))) {
      console.log([l.name, l.color, l.description].join("|"));
    }
  ' "$LABELS_FILE"
}

required_checks_json() {
  local first=1 name
  printf '['
  for name in "${REQUIRED_CHECKS[@]}"; do
    ((first)) || printf ', '
    printf '{ "context": "%s" }' "$name"
    first=0
  done
  printf ']'
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
        "required_status_checks": $(required_checks_json)
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

  echo "== ラベル（.github/labels.json）。同じ名前があれば色と説明を合わせる"
  local name color description
  while IFS='|' read -r name color description; do
    gh label create "$name" --repo "$repo" --color "$color" \
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
    report "main に必須の検査" \
      "$(gh api "repos/$repo/rulesets/$id" --jq '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | join(",")')" \
      "$(IFS=,; echo "${REQUIRED_CHECKS[*]}")"
  fi

  # ラベルは、名前・色・説明がすべて一覧と同じなら OK
  local existing name color description
  existing="$(gh label list --repo "$repo" --limit 200 --json name,color,description \
    --jq '.[] | [.name, (.color | ascii_downcase), .description] | join("|")')"
  while IFS='|' read -r name color description; do
    report "ラベル $name" \
      "$(awk -F'|' -v n="$name" '$1 == n' <<<"$existing")" \
      "$name|$color|$description"
  done < <(labels)

  # Issue Types は組織のリポジトリでしか使えない。使えないときは type:* のラベルで種類を分ける
  local types
  types="$(gh api graphql -F owner="${repo%%/*}" -F name="${repo##*/}" \
    -f query='query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issueTypes(first: 20) { nodes { name } } } }' \
    --jq '.data.repository.issueTypes.nodes // [] | map(.name) | join(",")' 2>/dev/null || true)"
  printf '  --  Issue Types：%s\n' "${types:-使えない（type:* のラベルを使う）}"

  return "$failed"
}

"$mode"
