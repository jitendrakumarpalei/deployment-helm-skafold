# agents.md - GKE Deployment Project

## 1. Timeline of Key Decisions

### Decision 1: App Engine Standard vs GKE
**When:** Initial architecture discussion  
**Context:** Need to connect to Valkey (Redis) via private IP  
**Options Considered:**
- App Engine Standard + Serverless VPC Access Connector ($$$)
- App Engine Flexible (always-on, higher cost)
- GKE (native VPC access)

**Decision:** GKE with Autopilot or Standard  
**Rationale:** 
- Native VPC access eliminates VPC connector costs
- More flexibility for microservices
- Better cost efficiency for multiple services
- Direct private IP connectivity to Valkey/Cloud SQL

**Impact:** Saved ~$50-100/month on VPC connector fees, gained Kubernetes flexibility

---

### Decision 2: GKE Autopilot vs Standard
**When:** During infrastructure design  
**Context:** Balance between ease-of-use and control  
**Options Considered:**
- GKE Autopilot (serverless-like, managed)
- GKE Standard (full control)

**Decision:** GKE Standard  
**Rationale:**
- More control over node configuration
- Better understanding of costs
- Ability to use preemptible nodes for dev
- Standard is more predictable for this use case

**Impact:** Full control over infrastructure, predictable costs

---

### Decision 3: Deployment Tooling - Skaffold vs Manual
**When:** Architecture finalization  
**Context:** Want "App Engine-like" experience: simple, one-command deploys  
**Options Considered:**
- Pure `gcloud builds submit` + manual kubectl
- Skaffold + Helm
- Argo CD / Flux (GitOps)

**Decision:** Skaffold + Helm  
**Rationale:**
- Skaffold abstracts away Cloud Build complexity
- Helm provides templating for multiple services
- No GitOps needed (user explicitly didn't want it)
- Single command deployment from laptop
- Built-in Cloud Build integration

**Impact:** Achieved `npm run gae:deploy` simplicity matching App Engine

---

### Decision 4: Infrastructure as Code - Terraform with Local State
**When:** Infrastructure automation discussion  
**Context:** User wants Terraform but insists on local laptop state  
**Options Considered:**
- Manual setup via gcloud commands
- Terraform with GCS backend (remote state)
- Terraform with local state

**Decision:** Terraform with local state  
**Rationale:**
- User explicitly requested local state
- Solo developer, no team conflicts
- Can optionally commit state to private repo
- Full IaC benefits with simpler setup
- No additional GCS costs

**Impact:** One-time infrastructure setup, reproducible environments

---

### Decision 5: Service Account Authentication
**When:** Security and automation planning  
**Context:** Need secure, repeatable deployments from laptop  
**Options Considered:**
- Personal gcloud credentials
- Service account with key file
- Workload Identity (overkill for laptop deploys)

**Decision:** Service account with JSON key  
**Rationale:**
- Scoped permissions (principle of least privilege)
- Works in CI/CD if needed later
- Can be rotated independently
- No personal credentials in scripts
- Terraform can generate and manage the key

**Impact:** Secure, automated authentication without personal credentials

---

### Decision 6: Load Balancing - Container-Native (NEG) vs NodePort
**When:** Ingress configuration  
**Context:** Need efficient routing and Google-managed SSL  
**Options Considered:**
- NodePort services (two-hop routing)
- LoadBalancer services (one per service, expensive)
- Container-native load balancing with NEGs

**Decision:** Container-native with NEGs  
**Rationale:**
- Direct pod routing (no double-hop)
- Lower latency and more reliable
- Single shared load balancer
- Required for Google-managed certificates
- Better performance and cost

**Impact:** Optimal performance, single global LB, free SSL certs

---

### Decision 7: Image Retention - Aggressive Cleanup
**When:** Cost optimization discussion  
**Context:** User doesn't want artifact persistence beyond latest  
**Options Considered:**
- Keep all images (standard practice)
- Keep last N images
- Keep only latest image

**Decision:** Keep only latest image, delete everything else  
**Rationale:**
- User prioritizes quick iteration over rollback capability
- Can always redeploy from source if needed
- Minimizes GCR storage costs
- Automatic cleanup in deployment scripts

**Impact:** Minimal storage costs, ~90% reduction in GCR usage

---

### Decision 8: Deployment Code Location - Separate deploy/ Directory
**When:** Project structure discussion  
**Context:** User wants deployment separate from source code  
**Options Considered:**
- Deployment files in each service directory
- Root-level deployment files
- Separate deploy/ directory outside source

**Decision:** `deploy/` directory with `terraform/` and `gke/` subdirectories  
**Rationale:**
- Clean separation of concerns
- Deployment logic isolated from application code
- Easy to share/version deployment configs separately
- Matches user's preference

**Impact:** Clean project structure, reusable deployment patterns

---

## 2. Pain Points / Lessons Learned

### Pain Point 1: Certificate Provisioning Time
**Issue:** Google-managed SSL certificates take 15-60 minutes to provision on first deploy  
**Impact:** Cannot test HTTPS immediately after first deployment  
**Mitigation:** 
- Document expected wait time upfront
- Provide `kubectl describe managedcertificate` command to check status
- Ensure DNS is configured correctly before deploying

**Lesson:** Set expectations early about certificate provisioning delays

---

### Pain Point 2: Skaffold Image Tagging Confusion
**Issue:** Initial confusion about how Skaffold tags and references images in Helm  
**Impact:** Unclear how image names in values.yaml get replaced  
**Solution:** 
- Use `--default-repo` flag to automatically construct image names
- Use `inputDigest` tag policy for content-based tagging
- Let Skaffold handle the magic of injecting image references into Helm

**Lesson:** Trust Skaffold's conventions rather than trying to manually specify everything

---

### Pain Point 3: Service Account Key Security
**Issue:** Risk of accidentally committing service account keys to Git  
**Impact:** Potential security breach  
**Solution:**
- Comprehensive `.gitignore` entries
- Terraform generates key directly to right location
- File permissions set to 0600
- Clear documentation about never committing keys

**Lesson:** Make secure defaults easy, insecure defaults impossible

---

### Pain Point 4: Local State Coordination
**Issue:** User wants local Terraform state but this can cause issues in teams  
**Impact:** Potential state conflicts if multiple people run Terraform  
**Solution:**
- Document clearly this is for solo development
- Provide migration path to remote state if needed
- Suggest committing state to private repo with coordination

**Lesson:** Honor user preferences while documenting tradeoffs

---

### Pain Point 5: GCR vs Artifact Registry
**Issue:** GCR is being replaced by Artifact Registry, but GCR still works and is simpler  
**Impact:** Future migration may be needed  
**Current Approach:** Use GCR with lifecycle policies  
**Future:** Should migrate to Artifact Registry for long-term support

**Lesson:** Use what works today, but be aware of deprecation timelines

---

### Pain Point 6: Multiple Context Switches
**Issue:** Original approach required editing multiple files with project IDs  
**Impact:** Error-prone, tedious setup  
**Solution:**
- Use `gcloud config get-value project` to auto-detect project
- Use Terraform variables and outputs
- Use environment variable expansion in scripts
- Single source of truth (terraform.tfvars)

**Lesson:** Automate away repetitive configuration

---

### Pain Point 7: Cleanup Script Compatibility
**Issue:** Date command differs between Linux and macOS  
**Impact:** `gcr-cleanup.sh` fails on some systems  
**Solution:**
- Use both date formats with fallback: `date -u -d '1 day ago' || date -u -v-1d`
- Document that cleanup is best-effort
- Rely primarily on GCS lifecycle policies

**Lesson:** Shell scripts need cross-platform considerations

---

## 3. What Went Well

### ✅ App Engine-Like Experience Achieved
Successfully replicated the simplicity of `gcloud app deploy` with `npm run gae:deploy`. Today’s refinements added explicit multi-stage Dockerfiles for each service, refreshed Skaffold/Helm wiring, and documented the exact secret/CLI steps so a laptop build + Cloud Build deployment works end-to-end without GitOps.

### ✅ Cost Optimization
Eliminated expensive VPC Access Connector ($50-100/month) by using GKE's native VPC access. Aggressive image cleanup reduces storage costs to near-zero.

### ✅ Infrastructure as Code
Complete Terraform setup means infrastructure is reproducible, versionable, and documented. One `terraform apply` creates everything.

### ✅ Security Best Practices
Service account with scoped permissions, never exposing personal credentials, proper `.gitignore` configuration, and file permissions all implemented correctly.

### ✅ Container-Native Load Balancing
Using NEGs for direct pod routing provides optimal performance and eliminates extra network hop. Single global load balancer for all services.

### ✅ Free SSL Certificates
Google-managed certificates with auto-renewal mean zero SSL management overhead and no certificate costs.

### ✅ Clean Separation of Concerns
Deployment code lives separately from application code, making it easy to reuse patterns across projects and keep concerns isolated.

### ✅ Helm Templating
Single Helm chart handles all 5 services through templating, eliminating duplication and making it easy to add more services.

### ✅ Multi-Environment Ready
Dev/prod profiles in Skaffold and conditional cluster creation in Terraform make it easy to add environments without duplicating configuration.

### ✅ Comprehensive Documentation
Everything from setup to troubleshooting to advanced topics is documented, making the setup maintainable and transferable.

---

## 4. Outstanding Work & Recommendations

### 🔲 Migrate to Artifact Registry
**Priority:** Medium  
**Effort:** Low  
**Why:** GCR is being deprecated in favor of Artifact Registry  
**Action:** Update Terraform and Skaffold configs to use Artifact Registry instead of GCR

---

### 🔲 Add Horizontal Pod Autoscaling
**Priority:** Medium  
**Effort:** Low  
**Why:** Currently using fixed replicas, HPA would optimize costs and handle traffic spikes  
**Action:** Add HPA resources to Helm templates with CPU-based scaling

---

### 🔲 Implement Health Checks
**Priority:** High  
**Effort:** Low  
**Why:** Kubernetes doesn't know when pods are actually ready to serve traffic  
**Action:** Add `livenessProbe` and `readinessProbe` to deployment templates

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

---

### 🔲 Add Resource Limits
**Priority:** High  
**Effort:** Low  
**Why:** Currently no resource constraints, pods could consume excessive resources  
**Action:** Already included in templates but should be tuned based on actual usage

```yaml
resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "256Mi"
    cpu: "200m"
```

---

### 🔲 Implement Monitoring
**Priority:** High  
**Effort:** Medium  
**Why:** No visibility into application performance or errors  
**Action:** 
- Enable Google Cloud Monitoring
- Add Prometheus metrics endpoint to apps
- Set up dashboards and alerts

---

### 🔲 Add Valkey/Redis Connection
**Priority:** High (if Valkey is being used)  
**Effort:** Medium  
**Why:** User mentioned Valkey as the reason for choosing GKE  
**Action:** Add Memorystore for Redis to Terraform, inject connection details into pods

---

### 🔲 Implement CI/CD Pipeline
**Priority:** Low  
**Effort:** Medium  
**Why:** Currently manual deploys from laptop, could automate with GitHub Actions  
**Action:** Add `.github/workflows/deploy.yml` for automated deployments on push

---

### 🔲 Add Network Policies
**Priority:** Medium  
**Effort:** Medium  
**Why:** Currently no network segmentation between pods  
**Action:** Implement NetworkPolicy resources to restrict pod-to-pod communication

---

### 🔲 Implement Secrets Management
**Priority:** High  
**Effort:** Medium  
**Why:** No secure way to inject API keys, database passwords, etc.  
**Action:** 
- Use Google Secret Manager
- Integrate with Kubernetes secrets
- Use Workload Identity for secret access

---

### 🔲 Add Backup and Disaster Recovery
**Priority:** Medium  
**Effort:** Low  
**Why:** No automated backup of Kubernetes resources  
**Action:** 
- Set up automated `kubectl` backups
- Document recovery procedures
- Consider Velero for comprehensive backup solution

---

### 🔲 Cost Monitoring and Alerts
**Priority:** Medium  
**Effort:** Low  
**Why:** No visibility into actual costs  
**Action:** Set up budget alerts in GCP, monitor GKE and Cloud Build costs

---

### 🔲 Multi-Region Deployment
**Priority:** Low  
**Effort:** High  
**Why:** Single region means potential downtime during regional outages  
**Action:** Deploy to multiple regions with global load balancing (complex, only if needed)

---

## 5. Documentation

### External Documentation Links
- [GKE Documentation](https://cloud.google.com/kubernetes-engine/docs)
- [Skaffold Documentation](https://skaffold.dev/docs/)
- [Helm Documentation](https://helm.sh/docs/)
- [Terraform GCP Provider](https://registry.terraform.io/providers/hashicorp/google/latest/docs)
- [Google Managed Certificates](https://cloud.google.com/kubernetes-engine/docs/how-to/managed-certs)
- [Container-Native Load Balancing](https://cloud.google.com/kubernetes-engine/docs/how-to/container-native-load-balancing)

### Internal Documentation Files

| File | Purpose |
|------|---------|
| `deploy/gke/terraform/README.md` | Terraform setup and usage guide |
| `deploy/gke/package.json` | npm scripts documentation via script names |
| This `agents.md` | Project decisions, lessons, and recommendations |
| Main artifact from this conversation | Complete setup with all configurations |

---

## 6. Source Files Worth Knowing

### Infrastructure Files

| Path | Role / Highlights |
|------|-------------------|
| `deploy/gke/terraform/main.tf` | Terraform entry point, provider config, API enablement |
| `deploy/gke/terraform/variables.tf` | All configurable parameters (project ID, region, cluster settings) |
| `deploy/gke/terraform/terraform.tfvars` | **EDIT THIS**: Your actual values (project ID, domain, etc.) |
| `deploy/gke/terraform/gke.tf` | GKE cluster definitions (main, dev, prod), node pools, config |
| `deploy/gke/terraform/iam.tf` | Service account creation, IAM roles, key generation |
| `deploy/gke/terraform/networking.tf` | Static IP reservation, GCR lifecycle policies |
| `deploy/gke/terraform/outputs.tf` | Important values output after apply (IP, service account, etc.) |
| `deploy/gke/terraform/.gitignore` | Protects sensitive files from Git commits |

### Deployment Files

| Path | Role / Highlights |
|------|-------------------|
| `deploy/gke/skaffold.yaml` | **CORE**: Defines build (Cloud Build) and deploy (Helm) process |
| `deploy/gke/deploy.sh` | **MAIN SCRIPT**: Authenticates, gets credentials, cleans up, deploys |
| `deploy/gke/gcr-cleanup.sh` | Deletes old Docker images to minimize storage costs |
| `deploy/gke/package.json` | npm scripts: `gae:deploy`, `gae:deploy:dev`, `gae:deploy:prod` |
| `deploy/gke/.gitignore` | Prevents committing service account keys |

### Helm Chart Files

| Path | Role / Highlights |
|------|-------------------|
| `deploy/gke/helm/honojs-api/Chart.yaml` | Helm chart metadata |
| `deploy/gke/helm/honojs-api/values.yaml` | **EDIT THIS**: Domain, per-service replicas, ports, and env/secret wiring |
| `deploy/gke/helm/honojs-api/templates/deployment.yaml` | Deployments for gateway/control-plane/event-collector/worker |
| `deploy/gke/helm/honojs-api/templates/service.yaml` | Services (NEG-enabled where appropriate) feeding ingress |
| `deploy/gke/helm/honojs-api/templates/ingress.yaml` | Ingress with static IP and Google-managed certificate references |
| `deploy/gke/helm/honojs-api/templates/managed-certificate.yaml` | Google-managed SSL certificate definition |

> **Secrets:** The Helm chart expects a `stringcost-config` secret with `database_url`, `classifier_endpoint`, and `classifier_api_key` keys. See `deploy/gke/README.md` for the exact `kubectl create secret` command.

### Application Files (Example Structure)

| Path | Role / Highlights |
|------|-------------------|
| `api-1/Dockerfile` | Container image definition for api-1 service |
| `api-1/package.json` | Node.js dependencies and scripts for api-1 |
| `api-1/src/` | Application source code for api-1 |
| _(Same structure for api-2 through api-5)_ | |

### Key Configuration Points

#### Must Edit Before First Use
1. `deploy/gke/terraform/terraform.tfvars` - Your GCP project ID and domain
2. `deploy/gke/helm/honojs-api/values.yaml` - Your domain name
3. `deploy/gke/deploy.sh` - Cluster name and region (if different from defaults)

#### Auto-Generated (Don't Edit Manually)
1. `deploy/gke/gke-deployer-key.json` - Created by Terraform
2. `deploy/gke/terraform/terraform.tfstate` - Managed by Terraform
3. `deploy/gke/terraform/.terraform/` - Terraform plugins and cache

#### Networking Flow
```
Ingress (ingress.yaml) 
  ↓ references
ManagedCertificate (managed-certificate.yaml)
  ↓ uses domain from
values.yaml
  ↓ routes to
Service (service.yaml) with NEG annotation
  ↓ load balances to
Deployment (deployment.yaml) pods
  ↓ running images from
Skaffold build (skaffold.yaml)
  ↓ using source from
api-*/Dockerfile
```

#### Deployment Flow
```
npm run gae:deploy
  ↓ runs
deploy.sh
  ↓ authenticates with
gke-deployer-key.json (from Terraform)
  ↓ executes
skaffold run
  ↓ reads
skaffold.yaml
  ↓ uploads code to
Google Cloud Build
  ↓ builds images, pushes to GCR
  ↓ deploys with
Helm (using templates)
  ↓ applies to
GKE cluster
```

---

## Quick Start Checklist

- [ ] Install: `terraform`, `gcloud`, `kubectl`, `skaffold`, `helm`
- [ ] Authenticate: `gcloud auth application-default login`
- [ ] Edit: `deploy/gke/terraform/terraform.tfvars` (project ID, domain)
- [ ] Run: `cd deploy/gke/terraform && terraform init && terraform apply`
- [ ] Note static IP from output
- [ ] Add DNS A record at your domain registrar
- [ ] Create `stringcost-config` secret (`database_url`, `classifier_endpoint`, `classifier_api_key`)
- [ ] Edit: `deploy/gke/helm/honojs-api/values.yaml` (domain, env overrides)
- [ ] Run: `cd deploy/gke && chmod +x *.sh && npm run gae:deploy`
- [ ] Wait 15-60 min for SSL certificate
- [ ] Check: `npm run check-cert`
- [ ] Done! Your services are live at `https://yourdomain.com/llm`, `/control`, and `/events` (the worker remains internal).

---

## Contact & Support

For issues or questions:
1. Check the troubleshooting section in the main artifact
2. Review GKE/Skaffold/Helm documentation
3. Check `kubectl get events` for Kubernetes issues
4. Review `gcloud builds list` for build failures
5. Use `kubectl logs` to debug application issues

---

*Last Updated: 2025-10-19*  
*Project: GKE Deployment Setup for 5 HonoJS APIs*  
*Architecture: GKE Standard + Skaffold + Helm + Terraform (local state)*
