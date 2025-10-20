variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Primary GCP region for resources"
  type        = string
  default     = "us-central1"
}

variable "domain" {
  description = "Public domain that will front the ingress"
  type        = string
}

variable "cluster_name" {
  description = "Name of the primary GKE cluster"
  type        = string
  default     = "my-cluster"
}

variable "node_count" {
  description = "Number of nodes per node pool"
  type        = number
  default     = 2
}

variable "machine_type" {
  description = "Machine type for GKE nodes"
  type        = string
  default     = "e2-medium"
}

variable "create_dev_cluster" {
  description = "Whether to create a separate dev cluster"
  type        = bool
  default     = false
}

variable "create_prod_cluster" {
  description = "Whether to create a separate prod cluster"
  type        = bool
  default     = false
}

variable "dev_cluster_name" {
  description = "Cluster name for the dev environment"
  type        = string
  default     = "dev-cluster"
}

variable "prod_cluster_name" {
  description = "Cluster name for the prod environment"
  type        = string
  default     = "prod-cluster"
}
