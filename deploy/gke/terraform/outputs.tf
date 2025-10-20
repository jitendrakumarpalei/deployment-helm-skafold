output "project_id" {
  description = "GCP project ID"
  value       = var.project_id
}

output "region" {
  description = "Primary region for deployments"
  value       = var.region
}

output "cluster_name" {
  description = "Primary GKE cluster name"
  value       = google_container_cluster.primary.name
}

output "dev_cluster_name" {
  description = "Development cluster name (if created)"
  value       = var.create_dev_cluster ? google_container_cluster.dev[0].name : "not created"
}

output "prod_cluster_name" {
  description = "Production cluster name (if created)"
  value       = var.create_prod_cluster ? google_container_cluster.prod[0].name : "not created"
}

output "service_account_email" {
  description = "Service account used for deployments"
  value       = google_service_account.gke_deployer.email
}

output "static_ip_address" {
  description = "Static IP address backing the ingress"
  value       = google_compute_global_address.ingress_ip.address
}

output "service_account_key_location" {
  description = "Path to the generated deployment key"
  value       = "${path.module}/../gke-deployer-key.json"
}

output "dns_instructions" {
  description = "Helper text for configuring DNS"
  value = <<EOT
Add an A record for ${var.domain} pointing to ${google_compute_global_address.ingress_ip.address} (TTL 300).
EOT
}
