resource "google_compute_global_address" "ingress_ip" {
  name = "honojs-apis-ip"

  depends_on = [google_project_service.compute]
}

resource "google_storage_bucket" "gcr_artifacts" {
  name          = "gcr-artifacts-stringcost-unique123"
  location      = "US"
  force_destroy = false

  lifecycle_rule {
    condition {
      num_newer_versions = 1
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age = 1
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.compute]
}
