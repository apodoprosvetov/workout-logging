# T011: weekly AWS Backup snapshot of the EBS data volume (research.md #9,
# FR-015/SC-008) — Postgres/MongoDB/Redis/RabbitMQ all persist there.

resource "aws_backup_vault" "workout_logging_backup_vault" {
  name = "workout-logging-vault"
}

resource "aws_backup_plan" "workout_logging_backup_plan" {
  name = "workout-logging-backup-plan"

  rule {
    rule_name         = "weekly-backup"
    target_vault_name = aws_backup_vault.workout_logging_backup_vault.name
    schedule          = "cron(0 3 ? * SUN *)" # Weekly on Sundays at 03:00 UTC
    lifecycle {
      delete_after = 30 # Retain backups for 30 days
    }
  }
}

# IAM role that the AWS Backup service (not EC2) assumes to take snapshots
# on this account's behalf.
resource "aws_iam_role" "backup_role" {
  name = "workout-logging-backup-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "backup.amazonaws.com"
        }
      },
    ]
  })
}

# AWS-managed policy purpose-built for this role — grants exactly what AWS
# Backup needs (CreateSnapshot/DescribeVolumes/etc. on backup-eligible
# resources), no custom policy required.
resource "aws_iam_role_policy_attachment" "backup_service_role" {
  role       = aws_iam_role.backup_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "workout_logging_backup_selection" {
  name         = "workout-logging-backup-selection"
  plan_id      = aws_backup_plan.workout_logging_backup_plan.id
  iam_role_arn = aws_iam_role.backup_role.arn

  resources = [
    aws_ebs_volume.data.arn
  ]
}
