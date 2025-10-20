# GKE Deployment Toolkit

This directory contains the Skaffold, Helm, and helper scripts used to deploy the five HonoJS API services to the GKE infrastructure created by Terraform.

## Prerequisites

- Terraform has been applied (creates the cluster, static IP, and service-account key).
- `gcloud`, `kubectl`, `helm`, and `skaffold` are installed locally.
- The DNS A record for your domain points to the static IP output by Terraform.

## Usage

```bash
cd deploy/gke

# (optional) export cluster names/region from Terraform outputs
export CLUSTER_NAME="$(terraform -chdir=terraform output -raw cluster_name)"
export DEV_CLUSTER_NAME="$(terraform -chdir=terraform output -raw dev_cluster_name 2>/dev/null || printf 'dev-cluster')"
export PROD_CLUSTER_NAME="$(terraform -chdir=terraform output -raw prod_cluster_name 2>/dev/null || printf 'prod-cluster')"
export REGION="${REGION:-us-central1}"

# Deploy to the primary cluster
npm run gae:deploy

# Deploy to the dev cluster (if created)
npm run gae:deploy:dev

# Deploy to the prod cluster (if created)
npm run gae:deploy:prod
```

> **Note:** When optional dev/prod clusters are disabled, Terraform outputs the literal string `not created`. In that case you can skip the corresponding `export` or leave the default value—it simply means `npm run gae:deploy:dev` / `npm run gae:deploy:prod` will no-op unless you later enable those clusters.

The `deploy.sh` script:

1. Authenticates with the generated `gke-deployer-key.json`.
2. Fetches cluster credentials.
3. Performs a best-effort container registry cleanup.
4. Runs `skaffold run` (Cloud Build + Helm) with the correct default repository.

## Skaffold

- Builds `@stringcost/gateway`, `@stringcost/control-plane`, `@stringcost/event-collector`, and `@stringcost/worker` using Google Cloud Build (the multi-stage Dockerfiles pull in vendored Portkey assets automatically).
- Uses the `inputDigest` tag policy so the latest digest always deploys.
- Applies the shared Helm chart stored in `helm/honojs-api`.

## Helm Chart

- `values.yaml` defines the domain, replicas, paths, and service ports.
- Deployments include readiness/liveness probes and baseline resource requests/limits.
- Services use Network Endpoint Groups (NEGs) for container-native load balancing.
- Ingress references the reserved static IP and Google-managed certificate.
- Environment variables can be specified per service via `env` (supports `value` or `valueFrom`) and `envFrom` blocks—by default the example expects a `stringcost-config` secret providing database and classifier credentials.

Create that secret before your first deploy (adjust keys/values as needed):

```bash
kubectl create secret generic stringcost-config \
  --from-literal=database_url="postgres://user:pass@host:5432/dbname" \
  --from-literal=classifier_endpoint="https://classifier.internal/v1/classify" \
  --from-literal=classifier_api_key="replace-me"
```

## Helpful Commands

```bash
# Describe the managed certificate (provisioning can take 15–60 minutes)
npm run check-cert

# Retrieve the reserved static IP address
npm run get-ip

# Trigger manual image pruning
npm run cleanup
```

Certificates typically take 15–60 minutes to provision on the first deploy. Use the `check-cert` script to inspect progress. Once provisioned, requests to `https://<your-domain>/llm/*`, `/control/*`, and `/events/*` will route to the StringCost gateway, control plane, and event collector respectively; the worker remains internal but exposes `/healthz` for probes.
