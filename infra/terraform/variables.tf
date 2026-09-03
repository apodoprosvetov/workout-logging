variable "monitoring_enabled" {
  description = <<-EOT
    CloudWatch Synthetics canary + its alarm and artifact bucket (research.md #8,
    T032-T035). Disabled by default: the canary runs every 5 minutes at
    ~$0.0012/run (~$10/month), disproportionate for a personal test project.
    The code stays in place behind this toggle — set to true and `terraform apply`
    to bring the health check back.
  EOT
  type        = bool
  default     = false
}
