#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
STAGING_DIR="${ROOT_DIR}/deploy/appengine/staging"
SERVICE_CONFIGS=(
  "${STAGING_DIR}/gateway/app.yaml"
  "${STAGING_DIR}/control-plane/app.yaml"
  "${STAGING_DIR}/event-collector/app.yaml"
  "${STAGING_DIR}/worker/app.yaml"
)
DISPATCH_CONFIG="${ROOT_DIR}/deploy/appengine/dispatch.yaml"

cd "${ROOT_DIR}"

KEY_PATH="${SERVICE_ACCOUNT_JSON:-${ROOT_DIR}/deploy/appengine/service-account.json}"
PROJECT_FROM_JSON=""

if [[ -f "${KEY_PATH}" ]]; then
  echo "[GAE] Activating service account from ${KEY_PATH}..."
  gcloud auth activate-service-account --key-file="${KEY_PATH}" >/dev/null
  PROJECT_FROM_JSON="$(node -e "const fs=require('fs'); try { const data=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (data.project_id) { console.log(data.project_id); } } catch (_) {}" "${KEY_PATH}")"
else
  echo "[GAE] No service account JSON found at ${KEY_PATH}."
  echo "      Set SERVICE_ACCOUNT_JSON or create deploy/appengine/service-account.json before deploying."
fi
CONFIG_RENDERER="${ROOT_DIR}/scripts/render-appengine-configs.mjs"
ENV_FILE="${APPENGINE_ENV_FILE:-${ROOT_DIR}/deploy/appengine/.env}"

if grep -E 'YOUR_|REPLACE_' "${ENV_FILE}" >/dev/null 2>&1; then
  echo "[GAE] Environment file ${ENV_FILE} still contains placeholder values."
  echo "      Please update it before deploying."
  exit 1
fi

echo "[GAE] Rendering service configs using ${ENV_FILE}..."
node "${CONFIG_RENDERER}" "${ENV_FILE}"
echo "[GAE] Service configs generated."

echo "[GAE] Building workspaces before deploy..."
npm run build >/dev/null
echo "[GAE] Build complete."

echo "[GAE] Staging service directories..."
node "${ROOT_DIR}/scripts/stage-appengine-services.mjs"
echo "[GAE] Services staged."
echo "[GAE] Deploying via gcloud app deploy..."

deploy_args=("${SERVICE_CONFIGS[@]}")
if [[ -f "${DISPATCH_CONFIG}" ]]; then
  deploy_args+=("${DISPATCH_CONFIG}")
fi
if [[ "${PROJECT_FROM_JSON}" != "" ]]; then
  has_project_flag=false
  for arg in "$@"; do
    if [[ "${arg}" == "--project" || "${arg}" == --project=* ]]; then
      has_project_flag=true
      break
    fi
  done
  if [[ "${has_project_flag}" == false ]]; then
    echo "[GAE] Using project ${PROJECT_FROM_JSON} from service account JSON."
    deploy_args+=("--project" "${PROJECT_FROM_JSON}")
  fi
fi
deploy_args+=("$@")

gcloud --verbosity=debug app deploy "${deploy_args[@]}" --promote --stop-previous-version

KEEP_VERSIONS=${KEEP_VERSIONS:-1}
SERVICES=(default control-plane event-collector worker)

for service in "${SERVICES[@]}"; do
  echo "[GAE] Pruning old versions for service ${service} (keeping ${KEEP_VERSIONS})..."
  mapfile -t versions < <(gcloud app versions list --service="${service}" --sort-by=~version.createTime --format='value(id)')
  if ((${#versions[@]} > KEEP_VERSIONS)); then
    to_delete=("${versions[@]:KEEP_VERSIONS}")
    gcloud app versions delete "${to_delete[@]}" --service="${service}" --quiet || true
  fi
done

echo "[GAE] Deployment complete."
