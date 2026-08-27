# research.md #8: one SNS topic + email subscription, the single alert
# channel for both a failed deploy (T033) and a failing CloudWatch
# Synthetics health check (T032, added later in Phase 7/US5) — created here
# in Phase 2 rather than alongside T032 so it exists by the time T012
# applies (T013 confirms the subscription email right after) and its ARN is
# available for the GitHub Actions secret in T015.
resource "aws_sns_topic" "alerts" {
  name = "workout-logging-alerts"
}

# AWS requires the subscriber to click a confirmation link before the
# subscription actually delivers anything (T013) — Terraform can create the
# subscription request, but only a human with inbox access can confirm it.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = "a.podoprosvetov@gmail.com"
}

output "sns_alerts_topic_arn" {
  value       = aws_sns_topic.alerts.arn
  description = "SNS topic ARN for deploy/health-check alerts (T015, T032, T033)."
}
