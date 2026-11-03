#!/usr/bin/env bash
# ログインと保存（Firebase Authentication と Firestore）の Google Cloud の設定を入れる・確かめる。
# 何度実行しても同じ結果になる。手順の説明は docs/spec/account.md の「Google Cloud の設定」にある。
#
# 使い方:
#   bash scripts/setup-firestore.sh check   いまの設定を確かめる（足りなければ終了コード 1）
#   bash scripts/setup-firestore.sh apply   設定を入れる
#
# 値は環境変数で渡す（どれも秘密情報ではないが、リポジトリには書かない）:
#   GCP_PROJECT_ID            Google Cloud（Firebase）のプロジェクト ID
#   GCP_REGION                Cloud Run と Firestore のリージョン（例：asia-northeast1）
#   CLOUD_RUN_SERVICE         Cloud Run のサービス名
#   RUN_SERVICE_ACCOUNT       Cloud Run の実行用のサービスアカウントのメールアドレス
#   FIREBASE_WEB_API_KEY      Firebase のウェブアプリの apiKey（公開の値。apply で Cloud Run に渡す）
#   FIREBASE_AUTH_DOMAIN      Firebase のウェブアプリの authDomain（同上）
#
# 必要なもの：gcloud（プロジェクトのオーナー相当でログイン）、Firebase CLI（firebase）、curl、Node.js。
set -euo pipefail

mode="${1:-}"
if [[ "$mode" != "check" && "$mode" != "apply" ]]; then
  echo "使い方: bash scripts/setup-firestore.sh check|apply" >&2
  exit 2
fi

missing=()
for name in GCP_PROJECT_ID GCP_REGION CLOUD_RUN_SERVICE RUN_SERVICE_ACCOUNT; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if [[ "$mode" == "apply" ]]; then
  for name in FIREBASE_WEB_API_KEY FIREBASE_AUTH_DOMAIN; do
    [[ -n "${!name:-}" ]] || missing+=("$name")
  done
fi
if (( ${#missing[@]} > 0 )); then
  echo "環境変数が足りません：${missing[*]}" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$GCP_PROJECT_ID"
APIS=(firestore.googleapis.com identitytoolkit.googleapis.com securetoken.googleapis.com
  firebase.googleapis.com firebaserules.googleapis.com)
# expiresAt で消す集まり（コレクショングループ）。apps/server/src/storage/firestore.ts と同じにする
TTL_GROUPS=(itineraries versions shares sessions)
ROLE="roles/datastore.user"

failed=0

# 標準入力の JSON を data に入れて、式の値を出す（jq の代わり。Node.js はこのリポジトリの前提）
json() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const data=JSON.parse(s||"null");const out=('"$1"');if(out===false||out==null)process.exit(1);if(out!==true)console.log(typeof out==="string"?out:JSON.stringify(out))})'
}
ok() { echo "  ok    $1"; }
ng() {
  echo "  不足  $1"
  failed=1
}

check_apis() {
  local enabled
  enabled="$(gcloud services list --enabled --project "$PROJECT" --format='value(config.name)')"
  for api in "${APIS[@]}"; do
    if grep -qx "$api" <<<"$enabled"; then ok "API $api"; else ng "API $api"; fi
  done
}

database_location() {
  gcloud firestore databases describe --database='(default)' --project "$PROJECT" \
    --format='value(locationId)' 2>/dev/null || true
}

check_database() {
  local location
  location="$(database_location)"
  if [[ "$location" == "$GCP_REGION" ]]; then
    ok "Firestore（ネイティブモード、$location）"
  elif [[ -n "$location" ]]; then
    ng "Firestore のリージョンが $location（$GCP_REGION にしたい。作り直しが要る）"
  else
    ng "Firestore のデータベース"
  fi
}

check_ttl() {
  local ttls state
  # 名前は projects/…/collectionGroups/{グループ}/fields/expiresAt
  ttls="$(gcloud firestore fields ttls list --project "$PROJECT" \
    --format='value(name,ttlConfig.state)' 2>/dev/null || true)"
  for group in "${TTL_GROUPS[@]}"; do
    state="$(grep "/collectionGroups/${group}/fields/expiresAt" <<<"$ttls" | awk '{ print $2 }' || true)"
    if [[ "$state" == "ACTIVE" || "$state" == "CREATING" ]]; then
      ok "TTL $group.expiresAt（$state）"
    else
      ng "TTL $group.expiresAt"
    fi
  done
}

check_role() {
  local roles
  roles="$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --filter="bindings.members:serviceAccount:${RUN_SERVICE_ACCOUNT}" \
    --format='value(bindings.role)')"
  if grep -qx "$ROLE" <<<"$roles"; then ok "$RUN_SERVICE_ACCOUNT に $ROLE"; else ng "$RUN_SERVICE_ACCOUNT に $ROLE"; fi
}

run_env() {
  gcloud run services describe "$CLOUD_RUN_SERVICE" --project "$PROJECT" --region "$GCP_REGION" \
    --format=json | json 'data.spec.template.spec.containers[0].env?.map((e)=>`${e.name}=${e.value??""}`).join(String.fromCharCode(10))??""'
}

check_run_env() {
  local env
  env="$(run_env)"
  for name in MATSURI_STORAGE FIREBASE_PROJECT_ID FIREBASE_WEB_API_KEY FIREBASE_AUTH_DOMAIN; do
    if grep -q "^${name}=." <<<"$env"; then ok "Cloud Run の環境変数 $name"; else ng "Cloud Run の環境変数 $name"; fi
  done
}

auth_config() {
  curl -fsS -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "x-goog-user-project: $PROJECT" \
    "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config"
}

run_host() {
  gcloud run services describe "$CLOUD_RUN_SERVICE" --project "$PROJECT" --region "$GCP_REGION" \
    --format='value(status.url)' | sed 's#^https://##'
}

check_auth() {
  local config host
  if ! config="$(auth_config 2>/dev/null)"; then
    ng "Firebase Authentication（プロジェクトに Firebase を足し、認証を始める）"
    return
  fi
  ok "Firebase Authentication"
  host="$(run_host)"
  if HOST="$host" json '(data.authorizedDomains??[]).includes(process.env.HOST)' <<<"$config"; then
    ok "ログインを許すドメインに $host"
  else
    ng "ログインを許すドメインに $host"
  fi
  if curl -fsS -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "x-goog-user-project: $PROJECT" \
    "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/defaultSupportedIdpConfigs/google.com" \
    2>/dev/null | json 'data?.enabled===true'; then
    ok "Google でのログイン"
  else
    ng "Google でのログイン（Firebase のコンソールの Authentication で有効にする）"
  fi
}

check_all() {
  echo "プロジェクト $PROJECT"
  check_apis
  check_database
  check_ttl
  check_role
  check_run_env
  check_auth
}

apply_all() {
  echo "API を有効にする"
  gcloud services enable "${APIS[@]}" --project "$PROJECT"

  if [[ -z "$(database_location)" ]]; then
    echo "Firestore のデータベースを作る（ネイティブモード、$GCP_REGION、削除の保護つき）"
    gcloud firestore databases create --project "$PROJECT" --location="$GCP_REGION" \
      --type=firestore-native --delete-protection
  fi

  echo "TTL ポリシー（expiresAt）を入れる"
  for group in "${TTL_GROUPS[@]}"; do
    gcloud firestore fields ttls update expiresAt --collection-group="$group" \
      --enable-ttl --project "$PROJECT" --async --quiet
  done

  echo "プロジェクトに Firebase を足し、セキュリティルール（ブラウザからはすべて断る）を入れる"
  if ! firebase projects:list --json | P="$PROJECT" json 'data.result.some((p)=>p.projectId===process.env.P)'; then
    firebase projects:addfirebase "$PROJECT"
  fi
  (cd "$ROOT" && firebase deploy --only firestore:rules --project "$PROJECT" --non-interactive)

  echo "実行用のサービスアカウントに $ROLE を付ける"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${RUN_SERVICE_ACCOUNT}" --role="$ROLE" --condition=None --quiet >/dev/null

  echo "ログインを許すドメインに Cloud Run の URL を足す"
  local host domains
  host="$(run_host)"
  if domains="$(auth_config 2>/dev/null | HOST="$host" json '[...new Set([...(data.authorizedDomains??[]),process.env.HOST])]')"; then
    curl -fsS -X PATCH -H "Authorization: Bearer $(gcloud auth print-access-token)" \
      -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json" \
      -d "{\"authorizedDomains\": ${domains}}" \
      "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=authorizedDomains" \
      >/dev/null
  else
    echo "  Firebase Authentication をまだ始めていません。コンソールで始めてから、もう一度実行してください" >&2
  fi

  echo "Cloud Run に保存先とログインの設定を渡す（新しい版ができる）"
  gcloud run services update "$CLOUD_RUN_SERVICE" --project "$PROJECT" --region "$GCP_REGION" \
    --update-env-vars="MATSURI_STORAGE=firestore,FIREBASE_PROJECT_ID=${PROJECT},FIREBASE_WEB_API_KEY=${FIREBASE_WEB_API_KEY},FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN}" \
    --quiet
}

if [[ "$mode" == "apply" ]]; then
  apply_all
  echo
fi
check_all
exit "$failed"
