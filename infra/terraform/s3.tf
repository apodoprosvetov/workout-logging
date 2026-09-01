# T009: private S3 bucket for apps/web's static export (research.md #1),
# readable only by CloudFront (cloudfront.tf).

resource "aws_s3_bucket" "web" {
  # Bucket name includes the account ID since S3 bucket names must be
  # globally unique across all of AWS, not just this account.
  bucket = "workout-logging-web-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "workout-logging-web"
  }
}

# Public access fully blocked at every level — the only intended reader is
# CloudFront via Origin Access Control (cloudfront.tf).
resource "aws_s3_bucket_public_access_block" "web" {
  bucket = aws_s3_bucket.web.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Completes the access model: the bucket stays fully private
# (aws_s3_bucket_public_access_block above) and is readable only by the one
# CloudFront distribution in cloudfront.tf, enforced via the AWS:SourceArn
# condition — not just "any CloudFront distribution in any account."
resource "aws_s3_bucket_policy" "allow_cloudfront_access" {
  bucket = aws_s3_bucket.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.web.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.web_distribution.arn
          }
        }
      }
    ]
  })
}

# Private S3 bucket for canary artifacts (research.md #8), readable only
# by the canary's IAM role (monitoring.tf).
resource "aws_s3_bucket" "canary_artifacts" {
  # Bucket name includes the account ID since S3 bucket names must be
  # globally unique across all of AWS, not just this account.
  bucket = "workout-logging-canary-artifacts-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "workout-logging-canary-artifacts"
  }
}

# Public access fully blocked at every level 
# — the only intended reader is the canary's IAM role (monitoring.tf).
resource "aws_s3_bucket_public_access_block" "canary_artifacts" {
  bucket = aws_s3_bucket.canary_artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "canary_artifacts" {
  bucket = aws_s3_bucket.canary_artifacts.id

  rule {
    id     = "expire-canary-artifacts"
    status = "Enabled"

    expiration {
      days = 7
    }
  }
}
