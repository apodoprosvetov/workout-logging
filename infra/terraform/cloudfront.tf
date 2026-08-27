# T010: single CloudFront distribution in front of both origins
# (research.md #4) — S3 for the static export (apps/web), EC2/Caddy for API
# paths (/api/* — apps/api's global prefix, set to match this behavior).
# No custom domain (research.md #3) — the free *.cloudfront.net domain +
# AWS-managed default certificate is enough.

# origin_id is a free-form label scoped only to this distribution — it links
# a cache_behavior's target_origin_id to a specific origin block. Named
# locals instead of repeating the literal string in each place, so a typo in
# one spot becomes a refactor error everywhere rather than a silent mismatch
# terraform validate can't catch.
locals {
  s3_origin_id  = "workout-logging-web-s3"
  ec2_origin_id = "workout-logging-api-ec2"
}

# Origin Access Control — the modern replacement for the legacy OAI, lets
# CloudFront authenticate to the private S3 bucket (s3.tf) via SigV4 instead
# of the bucket being public or using a static website endpoint.
resource "aws_cloudfront_origin_access_control" "s3_web_oac" {
  name                              = "workout-logging-web-oac"
  description                       = "OAC for CloudFront to access S3 bucket workout-logging-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# AWS-managed policy, purpose-built for static origins (long TTL, gzip/brotli
# eligible, no query-string/header/cookie cache key). Looked up by name
# rather than hardcoding its UUID, consistent with the AMI/CloudFront-IP/KMS
# lookups elsewhere in this project — a custom cache policy isn't worth it
# unless a concrete need to deviate from these defaults shows up later.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# Excludes Host from what's forwarded to the EC2 origin: without this,
# Caddy/Nest would see the viewer's Host (xxxx.cloudfront.net) instead of
# the origin's own address, which is the AWS-recommended default for custom
# (non-S3) origins to avoid Host-based routing/validation surprises. Origin
# (CORS) is a separate header and is still forwarded either way.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# AWS-managed policy for dynamic content — TTLs forced to 0, no caching.
# Looked up by name for the same reason as caching_optimized above.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

resource "aws_cloudfront_distribution" "web_distribution" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.s3_web_oac.id
  }

  origin {
    domain_name = aws_eip.web_server_eip.public_dns
    origin_id   = local.ec2_origin_id

    # research.md #4: EC2 origin is plain HTTP (CloudFront terminates TLS) —
    # no ACM cert, no Route53, no custom domain, no TLS on the instance itself.
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Static export: GET/HEAD only, cached — this is the default (catch-all)
  # behavior, since the API's ordered_cache_behavior below takes priority
  # for /api/*.
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"

    cache_policy_id = data.aws_cloudfront_cache_policy.caching_optimized.id
  }

  # Cache disabled for API paths (research.md #4) — CloudFront forwards all
  # requests to the EC2 origin.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.ec2_origin_id
    viewer_protocol_policy = "redirect-to-https"

    cache_policy_id = data.aws_cloudfront_cache_policy.caching_disabled.id

    # Forward all headers (except Host), cookies, and query strings to the origin
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  # Required block even with no actual restriction — schema mandates it.
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # research.md #3: free *.cloudfront.net domain + AWS-managed default cert,
  # no ACM/Route53/custom domain.
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# The one public address for the whole app — apps/web and apps/api both live
# behind this same *.cloudfront.net domain (research.md #3, no custom
# domain). Used by quickstart.md to test the deployment, by T015 (GitHub
# Actions secrets, e.g. for a future Telegram webhook URL), and by anyone
# just wanting the live URL without digging through the AWS console.
output "cloudfront_domain_name" {
  value       = aws_cloudfront_distribution.web_distribution.domain_name
  description = "Public HTTPS domain for the deployed app (apps/web + apps/api, research.md #3/#4)."
}
