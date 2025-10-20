# Terraform Infrastructure Setup

This directory provisions the Google Cloud resources required to run the five HonoJS APIs on GKE.

## Prerequisites

- Terraform >= 1.5
- `gcloud` CLI authenticated with `gcloud auth application-default login`
- Project-level permissions to enable APIs and create GKE clusters

## Usage

```bash
cd deploy/gke/terraform

# Initialise providers
terraform init

# Review plan
terraform plan

# Apply changes
terraform apply
```

Edit `terraform.tfvars` with your project ID, region, and domain before running `terraform apply`.

The configuration uses the local backend by design, storing state in `terraform.tfstate` inside this folder. If you later need team collaboration or remote state, migrate to GCS or Terraform Cloud.

## Outputs

After applying, Terraform prints:

- Static IP for the ingress
- Deployment service-account email
- Location of the generated key file (`../gke-deployer-key.json`)
- Cluster names (primary/optional dev/prod)

Use the static IP to create an A record at your DNS provider before deploying workloads.
