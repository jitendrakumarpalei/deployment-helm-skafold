resource "google_service_account" "gke_deployer" {
  account_id   = "gke-deployer"
  display_name = "GKE Deployer Service Account"
  description  = "Used for Skaffold/Helm deployments from local environment"

  depends_on = [google_project_service.iam]
}

resource "google_project_iam_member" "gke_deployer_container_developer" {
  project = var.project_id
  role    = "roles/container.developer"
  member  = "serviceAccount:${google_service_account.gke_deployer.email}"
}

resource "google_project_iam_member" "gke_deployer_storage_admin" {
  project = var.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:${google_service_account.gke_deployer.email}"
}

resource "google_project_iam_member" "gke_deployer_cloudbuild_editor" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.gke_deployer.email}"
}

resource "google_project_iam_member" "gke_deployer_artifact_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.gke_deployer.email}"
}

resource "google_project_iam_member" "gke_deployer_compute_viewer" {
  project = var.project_id
  role    = "roles/compute.viewer"
  member  = "serviceAccount:${google_service_account.gke_deployer.email}"
}

resource "google_service_account_key" "gke_deployer_key" {
  service_account_id = google_service_account.gke_deployer.name
}

resource "local_file" "gke_deployer_key_file" {
  content         = base64decode(google_service_account_key.gke_deployer_key.private_key)
  filename        = "${path.module}/../gke-deployer-key.json"
  file_permission = "0600"
}
