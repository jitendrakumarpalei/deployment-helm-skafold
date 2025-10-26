# GKE Deployment Guide

## Prerequisites

**Local tools required:**
- `gcloud` CLI (authenticated with your GCP account)
- `kubectl` (Kubernetes CLI)
- `skaffold` (for building and deploying)
- `helm` (Kubernetes package manager)
- `terraform` (for infrastructure provisioning)
- `jq` (JSON processor - for deployment scripts)

## Architecture

This deployment uses:
- **Helm** for Kubernetes manifests (NOT raw YAML)
- **Skaffold** for building Docker images via Google Cloud Build
- **Terraform** for GKE cluster provisioning
- **Direct deployment from laptop** (NOT GitOps)

## Step 1: Provision Infrastructure

### 1.1 Configure GCP Project

```bash
# Set your GCP project
gcloud config set project YOUR_PROJECT_ID
gcloud auth login
gcloud auth application-default login
```

### 1.2 Run Terraform

```bash
cd deploy/gke/terraform
terraform init
terraform apply
```

This creates:
- ✅ GKE cluster(s)
- ✅ Static IP address
- ✅ Service account (`gke-deployer`) with deployment permissions
- ✅ Service account key saved to `../gke-deployer-key.json`

**Important**: Treat `gke-deployer-key.json` as a secret - never commit it!

### 1.3 Configure DNS

After Terraform completes, it outputs a static IP address:

```bash
terraform output static_ip
```

Create an **A record** in your DNS provider:
```
yourdomain.com → <static-ip>
```

## Step 2: Create Kubernetes Secrets

The application requires a Kubernetes secret named `stringcost-config` with the following keys:

### 2.1 Generate Required Secrets

```bash
# Generate encryption keys
export DATABASE_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export URL_TOKEN_KEY1="$(openssl rand -base64 32)"
export URL_TOKEN_KEY2="$(openssl rand -base64 32)"

# Create URL token keys string (supports key rotation)
export URL_TOKEN_KEYS="primary:${URL_TOKEN_KEY1},secondary:${URL_TOKEN_KEY2}"
```

### 2.2 Create the Kubernetes Secret

```bash
# Get cluster credentials
REGION="${REGION:-us-central1}"
CLUSTER_NAME="my-cluster"  # Or from terraform output
gcloud container clusters get-credentials "${CLUSTER_NAME}" --region "${REGION}"

# Create secret (adjust values for your environment)
kubectl create secret generic stringcost-config \
  --from-literal=database_url="postgresql://user:password@host:5432/stringcost" \
  --from-literal=database_encryption_key="${DATABASE_ENCRYPTION_KEY}" \
  --from-literal=url_token_keys="${URL_TOKEN_KEYS}" \
  --from-literal=classifier_endpoint="https://your-classifier.com/v1/classify" \
  --from-literal=classifier_api_key="your-classifier-api-key"
```

**Secret Keys Reference:**

| Key | Purpose | Example |
|-----|---------|---------|
| `database_url` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `database_encryption_key` | Encrypts client-provided API keys | Base64 32-byte key |
| `url_token_keys` | HMAC keys for signing URLs | `primary:key1,secondary:key2` |
| `classifier_endpoint` | Meta classifier API endpoint | `https://api.classifier.com/v1/classify` |
| `classifier_api_key` | Classifier API key | `Bearer token or API key` |

### 2.3 Verify Secret

```bash
kubectl get secret stringcost-config -o yaml
kubectl describe secret stringcost-config
```

## Step 3: Update Helm Values

Edit `deploy/gke/helm/honojs-api/values.yaml`:

```yaml
domain: "yourdomain.com"  # Change to your actual domain

services:
  - name: gateway
    replicas: 2  # Adjust based on load
  - name: control-plane
    replicas: 1
  - name: event-collector
    replicas: 1
  - name: worker
    replicas: 1  # Increase for high classification load
```

## Step 4: Deploy from Your Laptop

### 4.1 Deploy to Default Cluster

```bash
cd deploy/gke
./deploy.sh
```

This script:
1. ✅ Activates service account (from `gke-deployer-key.json`)
2. ✅ Gets cluster credentials
3. ✅ Cleans old container images
4. ✅ Builds Docker images via Cloud Build
5. ✅ Deploys Helm chart via Skaffold
6. ✅ Revokes service account credentials

### 4.2 Deploy to Dev/Prod Clusters

If you have separate dev/prod clusters:

```bash
# Deploy to dev
./deploy.sh dev

# Deploy to prod
./deploy.sh prod
```

### 4.3 Monitor Deployment

```bash
# Watch pod status
kubectl get pods -w

# Check logs
kubectl logs -f deployment/gateway
kubectl logs -f deployment/control-plane
kubectl logs -f deployment/event-collector
kubectl logs -f deployment/worker

# Check ingress
kubectl get ingress
kubectl describe managedcertificate honojs-apis-cert
```

## Step 5: Database Migrations

### Automatic Migrations (Recommended)

By default, migrations run automatically as a **Kubernetes Job** before deployment:

```yaml
# In values.yaml (enabled by default)
runMigrations: true
```

The migration Job:
- ✅ Runs as a `pre-install` and `pre-upgrade` Helm hook
- ✅ Creates all tables including `classification_jobs` (required by worker)
- ✅ Executes both control-plane and ledger migrations
- ✅ **100% IDEMPOTENT** - Safe to run multiple times (Knex tracks applied migrations)
- ✅ Fails deployment if migrations fail (safe rollback)
- ✅ Auto-deletes after 5 minutes

### Migration Safety & Idempotency

**Q: What if I destroy my K8s cluster but keep the same database?**

✅ **Safe!** Knex tracks applied migrations in these tables:
- `control_plane_schema_migrations` - Tracks control-plane migrations
- `ledger_schema_migrations` - Tracks ledger migrations

When you redeploy:
1. Migration Job runs `npm run migrate:control-plane` and `npm run migrate:ledger`
2. Knex checks which migrations already ran
3. Only NEW migrations are applied
4. Already-applied migrations are skipped
5. Your data is preserved

**Q: What if I add new migrations locally and deploy?**

✅ **Automatic!** The migration Job will:
1. Detect new migration files (by timestamp in filename)
2. Apply only the new migrations
3. Skip migrations that already ran
4. Update tracking tables

**Example workflow:**
```bash
# 1. Add new migration locally
cd apps/control-plane
npx knex migrate:make add_new_feature

# 2. Write migration in knex/migrations/20251026000000_add_new_feature.js
# ...

# 3. Deploy to K8s (migration runs automatically)
npm run gke:deploy

# 4. Verify migration ran
kubectl logs job/honojs-apis-migrations-<revision>
# You'll see: "Batch 2 run: 1 migrations"
```

**To check migration status:**
```bash
# Watch migration Job
kubectl get jobs | grep migration
kubectl logs job/honojs-apis-migrations-<revision>

# Check which migrations have run
kubectl exec -it deployment/control-plane -- node -e "
  const knex = require('knex')({
    client: 'pg',
    connection: process.env.DATABASE_URL
  });
  knex('control_plane_schema_migrations').select('*').then(console.log).finally(() => knex.destroy());
"

# Verify tables exist
kubectl exec -it deployment/control-plane -- psql $DATABASE_URL -c "\dt"
```

### Manual Migrations (If Needed)

If you disabled automatic migrations (`runMigrations: false`), run them manually:

```bash
# Port-forward to control-plane
kubectl port-forward deployment/control-plane 8080:8080 &

# Run migrations
export DATABASE_URL="postgresql://user:pass@host:5432/stringcost"
npm run db:migrate
npm run db:seed  # Optional: load demo data

# Stop port-forward
kill %1
```

## Skaffold Profiles

Skaffold is configured with three profiles:

### Default Profile
```bash
skaffold run --default-repo="gcr.io/YOUR_PROJECT_ID"
```
Deploys to default namespace

### Dev Profile
```bash
skaffold run -p dev --default-repo="gcr.io/YOUR_PROJECT_ID"
```
Deploys to `dev` namespace

### Prod Profile
```bash
skaffold run -p prod --default-repo="gcr.io/YOUR_PROJECT_ID"
```
Deploys to `prod` namespace

## Helm Chart Structure

```
deploy/gke/helm/honojs-api/
├── Chart.yaml                    # Chart metadata
├── values.yaml                   # Configuration values
└── templates/
    ├── deployment.yaml           # Deployment for each service
    ├── service.yaml              # Kubernetes services
    ├── ingress.yaml              # GCE ingress + path routing
    └── managed-certificate.yaml  # Google-managed TLS certificate
```

## Environment Variables

All services receive these environment variables from Helm values and Kubernetes secrets:

### Gateway
- `PORT` - Container port (8787)
- `CONTROL_PLANE_URL` - Internal control plane URL
- `URL_TOKEN_KEYS` - HMAC signing keys
- `SIGNED_URL_DATABASE_URL` - PostgreSQL for replay protection
- `DISABLE_RATE_LIMITING` - Set to "false" in production

### Control Plane
- `PORT` - Container port (8080)
- `DATABASE_URL` - PostgreSQL connection
- `DATABASE_ENCRYPTION_KEY` - For encrypting client API keys
- `URL_TOKEN_KEYS` - HMAC signing keys
- `GATEWAY_BASE_URL` - Public gateway URL
- `DISABLE_RATE_LIMITING` - Set to "false" in production

### Event Collector
- `PORT` - Container port (8080)
- `DATABASE_URL` - PostgreSQL connection
- `DISABLE_RATE_LIMITING` - Set to "false" in production

### Worker
- `PORT` - Container port (8080)
- `DATABASE_URL` - PostgreSQL connection
- `META_LLM_CLASSIFIER_ENDPOINT` - Classifier API URL
- `META_LLM_API_KEY` - Classifier API key

## Troubleshooting

### Worker: "relation classification_jobs does not exist"

**Cause:** Migrations didn't run or failed

**Solution:**
```bash
# 1. Check if migration Job ran
kubectl get jobs | grep migration
kubectl logs job/honojs-apis-migrations-<revision>

# 2. If Job failed, check the error
kubectl describe job honojs-apis-migrations-<revision>

# 3. If migrations never ran, check values.yaml
# Ensure: runMigrations: true

# 4. Manually trigger migrations if needed
kubectl exec -it deployment/control-plane -- npm run db:migrate

# 5. Verify table exists
kubectl exec -it deployment/control-plane -- psql $DATABASE_URL -c "\d classification_jobs"
```

### Pods not starting
```bash
kubectl describe pod <pod-name>
kubectl logs <pod-name>
```

### Secret missing
```bash
kubectl get secret stringcost-config
# If missing, recreate using Step 2.2
```

### Certificate not provisioning
```bash
kubectl describe managedcertificate honojs-apis-cert
```
Google-managed certificates can take up to 60 minutes to provision.

### Service account key expired
```bash
cd deploy/gke/terraform
terraform apply  # Regenerates key
```

### Image build failing
```bash
# Check Cloud Build logs
gcloud builds list --limit 5
gcloud builds log <build-id>
```

### Helm release issues
```bash
# List releases
helm list

# Rollback
helm rollback honojs-apis

# Uninstall and redeploy
helm uninstall honojs-apis
./deploy.sh
```

## Updating the Deployment

### Code Changes
```bash
# Just run deploy again - Skaffold rebuilds changed images
./deploy.sh
```

### Configuration Changes
```bash
# Edit values.yaml
vim deploy/gke/helm/honojs-api/values.yaml

# Redeploy
./deploy.sh
```

### Secret Changes
```bash
# Delete old secret
kubectl delete secret stringcost-config

# Create new secret (see Step 2.2)
kubectl create secret generic stringcost-config ...

# Restart pods
kubectl rollout restart deployment/gateway
kubectl rollout restart deployment/control-plane
kubectl rollout restart deployment/event-collector
kubectl rollout restart deployment/worker
```

## Security Checklist

Before production deployment:

- [ ] `gke-deployer-key.json` is NOT committed to git
- [ ] Strong `DATABASE_ENCRYPTION_KEY` generated (32 bytes)
- [ ] Unique `URL_TOKEN_KEYS` generated (32 bytes each)
- [ ] `DISABLE_RATE_LIMITING` set to `"false"` in production
- [ ] Database has strong password
- [ ] Kubernetes secret created with all required keys
- [ ] DNS A record points to static IP
- [ ] TLS certificate provisioned (check `managedcertificate`)
- [ ] Firewall rules allow only necessary traffic
- [ ] Database migrations run successfully

## Cost Optimization

- Adjust `replicas` based on actual load
- Use preemptible nodes for dev environments
- Set appropriate resource `requests` and `limits`
- Enable cluster autoscaling in Terraform

## Support

For issues:
1. Check pod logs: `kubectl logs -f deployment/<service>`
2. Check events: `kubectl get events --sort-by='.lastTimestamp'`
3. Verify secret: `kubectl describe secret stringcost-config`
4. Review ingress: `kubectl describe ingress honojs-apis-ingress`
