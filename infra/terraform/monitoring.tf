data "archive_file" "canary" {
  type        = "zip"
  output_path = "${path.module}/canary/health-canary.zip"
  source {
    content  = file("${path.module}/canary/health-canary.js")
    filename = "nodejs/node_modules/health-canary.js"
  }
}

resource "aws_iam_role" "canary" {
  name = "workout-logging-canary-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "canary" {
  name = "canary-exec"
  role = aws_iam_role.canary.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetBucketLocation"]
        Resource = [aws_s3_bucket.canary_artifacts.arn, "${aws_s3_bucket.canary_artifacts.arn}/*"]
      },
      { Effect = "Allow", Action = ["s3:ListAllMyBuckets"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:eu-central-1:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/cwsyn-*"
      },
      {
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "CloudWatchSynthetics" } }
      }
    ]
  })
}

resource "aws_synthetics_canary" "health" {
  name                 = "wl-health-canary"
  artifact_s3_location = "s3://${aws_s3_bucket.canary_artifacts.id}/"
  execution_role_arn   = aws_iam_role.canary.arn
  runtime_version      = "syn-nodejs-puppeteer-16.0"
  handler              = "health-canary.handler"
  zip_file             = data.archive_file.canary.output_path
  start_canary         = true

  schedule {
    expression = "rate(5 minutes)"
  }

  run_config {
    timeout_in_seconds = 60
    environment_variables = {
      HEALTH_URL = "https://${aws_cloudfront_distribution.web_distribution.domain_name}/api/health"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "health" {
  alarm_name  = "wl-health-canary"
  namespace   = "CloudWatchSynthetics"
  metric_name = "SuccessPercent"
  dimensions = {
    CanaryName = aws_synthetics_canary.health.name
  }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  threshold           = 100
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  # ok_actions          = [aws_sns_topic.alerts.arn]
}
