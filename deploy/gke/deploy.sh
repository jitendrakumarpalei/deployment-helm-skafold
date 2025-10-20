#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="${1:-default}"
PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
REGION="${REGION:-us-central1}"
KEY_FILE="$(dirname "$0")/gke-deployer-key.json"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "❌  No GCP project configured. Run 'gcloud config set project <project-id>' first." >&2
  exit 1
fi

if [[ ! -f "${KEY_FILE}" ]]; then
  echo "❌  Service account key not found at ${KEY_FILE}. Run Terraform first." >&2
  exit 1
fi

case "${ENVIRONMENT}" in
  dev)
    CLUSTER="${DEV_CLUSTER_NAME:-dev-cluster}"
    PROFILE="-p dev"
    ;;
  prod)
    CLUSTER="${PROD_CLUSTER_NAME:-prod-cluster}"
    PROFILE="-p prod"
    ;;
  *)
    CLUSTER="${CLUSTER_NAME:-my-cluster}"
    PROFILE=""
    ;;
esac

echo "🚀  Deploying to cluster '${CLUSTER}' in project '${PROJECT_ID}'"

gcloud auth activate-service-account --key-file="${KEY_FILE}" --project="${PROJECT_ID}"
gcloud container clusters get-credentials "${CLUSTER}" --region "${REGION}" --project "${PROJECT_ID}"

echo "🧹  Cleaning old container images..."
"$(dirname "$0")/gcr-cleanup.sh"

echo "🚢  Building and deploying via Skaffold..."
skaffold run ${PROFILE} --default-repo="gcr.io/${PROJECT_ID}"

SA_EMAIL="$(jq -r '.client_email' "${KEY_FILE}")"
gcloud auth revoke "${SA_EMAIL}" >/dev/null 2>&1 || true

echo
echo "✅  Deployment complete."
echo "🔍  Checking managed certificate status..."
kubectl describe managedcertificate honojs-apis-cert 2>/dev/null || echo "Certificate provisioning in progress (may take up to 60 minutes)."
