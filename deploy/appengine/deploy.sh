#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
SERVICE_CONFIGS=(
  "${ROOT_DIR}/deploy/appengine/services/gateway.yaml"
  "${ROOT_DIR}/deploy/appengine/services/control-plane.yaml"
  "${ROOT_DIR}/deploy/appengine/services/event-collector.yaml"
  "${ROOT_DIR}/deploy/appengine/services/worker.yaml"
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
echo "[GAE] Building workspaces before deploy..."
npm run build >/dev/null
echo "[GAE] Build complete."
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

gcloud app deploy "${deploy_args[@]}"

echo "[GAE] Deployment complete."
