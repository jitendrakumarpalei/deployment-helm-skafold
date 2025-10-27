# Edit these values for your environment
project_id     = "stringcost"
region         = "us-central1"
domain         = "test.local"

# GKE cluster settings
cluster_name   = "my-cluster"
node_count     = 2
machine_type   = "e2-medium"

# Optional clusters
create_dev_cluster  = false
create_prod_cluster = false
dev_cluster_name    = "dev-cluster"
prod_cluster_name   = "prod-cluster"
