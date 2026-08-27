# Shared data sources used across multiple files below — nothing here
# belongs to just one feature area.

# Used to build account-specific ARNs (compute.tf, github-actions.tf) and to
# make the S3 bucket name globally unique (s3.tf).
data "aws_caller_identity" "current" {}

# Default VPC — no custom VPC/subnets/routing needed for a single EC2
# instance (matches the cost-conscious "no ALB/NAT Gateway" decision in
# plan.md); every AWS account has one unless explicitly deleted.
data "aws_vpc" "default" {
  default = true
}

# research.md #4: AWS-managed prefix list of CloudFront's edge IP ranges —
# stays correct as AWS adds/changes edge locations, with no hand-copied
# list. Deliberately NOT the `aws_ip_ranges` data source: that returns 211
# individual CIDRs, and AWS counts each CIDR in a security-group rule
# against the account's "rules per security group" quota (default 60) —
# real `terraform apply` failure this project hit. A managed prefix list
# reference counts as exactly one rule no matter how many CIDRs it holds
# internally, which is the whole reason this prefix list exists.
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}
