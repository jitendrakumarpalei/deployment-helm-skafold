#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "❌  No GCP project configured. Run 'gcloud config set project <project-id>' first." >&2
  exit 1
fi

for service in gateway control-plane event-collector worker; do
  echo "🗑️   Pruning images for ${service}..."

  # Delete untagged images
  gcloud container images list-tags "gcr.io/${PROJECT_ID}/${service}" \
    --filter="NOT tags:*" \
    --format="get(digest)" 2>/dev/null | while read -r digest; do
      [[ -z "${digest}" ]] && continue
      gcloud container images delete "gcr.io/${PROJECT_ID}/${service}@${digest}" --quiet || true
    done

  # Delete images older than a day (best-effort cross-platform date command)
  if date -u -d '1 day ago' +"%Y-%m-%dT%H:%M:%S" >/dev/null 2>&1; then
    cutoff="$(date -u -d '1 day ago' +"%Y-%m-%dT%H:%M:%S")"
  else
    cutoff="$(date -u -v-1d +"%Y-%m-%dT%H:%M:%S")"
  fi

  gcloud container images list-tags "gcr.io/${PROJECT_ID}/${service}" \
    --format="get(digest)" \
    --filter="timestamp.datetime < ${cutoff}" 2>/dev/null | while read -r digest; do
      [[ -z "${digest}" ]] && continue
      gcloud container images delete "gcr.io/${PROJECT_ID}/${service}@${digest}" --quiet || true
    done
done

echo "✅  Image cleanup complete."
