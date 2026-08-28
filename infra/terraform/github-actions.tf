# T007's GitHub Actions half: OIDC federation so deploy.yml can assume an
# AWS role without any long-lived access key, scoped to exactly what it
# needs (SSM Run Command on the one instance, push to the two ECR repos,
# sync the S3 bucket).

# Create the OIDC Identity Provider in AWS
resource "aws_iam_openid_connect_provider" "oidc_provider" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"] # Not actually used, needed as a cover, common meaning
}

# Create a secure trust policy document restricted to your repository
data "aws_iam_policy_document" "github_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.oidc_provider.arn]
    }

    # Restrict the token audience to AWS Security Token Service
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # CRITICAL SECURITY: Restrict execution to your GitHub organization and repo
    #
    # Real failure found running deploy.yml for the first time: repos
    # created after 2026-07-15 get GitHub's newer "immutable subject
    # claims" by default — sub is
    # "repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/main" (confirmed by
    # decoding the actual OIDC token in a live run), not the classic
    # "repo:OWNER/REPO:ref:..." this was originally written for. The `@*`
    # wildcards match any owner/repo ID while still requiring the literal
    # names to match exactly.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:apodoprosvetov@*/workout-logging@*:ref:refs/heads/main"]
    }
  }
}

# Create the IAM Role
resource "aws_iam_role" "github_actions_role" {
  name               = "github-actions-oidc-role"
  assume_role_policy = data.aws_iam_policy_document.github_assume_role.json
}

# Output the Role ARN to use in your workflow
output "github_actions_role_arn" {
  value       = aws_iam_role.github_actions_role.arn
  description = "The ARN of the IAM role for GitHub Actions to assume."
}

# Create the IAM policy for SSM execution
data "aws_iam_policy_document" "github_ssm_execution" {
  # ssm:SendCommand authorizes against two resource types in the same call
  # (the target instance AND the document being run) — AWS's own SendCommand
  # IAM examples list both ARN patterns in one statement's resources, not
  # two separate statements. Scoped to this specific instance, not "*".
  #
  # Real failure on deploy.yml's first live run: AWS-RunShellScript is an
  # AWS-owned public document, not one of ours — its real ARN has an EMPTY
  # account-id segment (arn:aws:ssm:REGION::document/NAME), confirmed from
  # the live AccessDenied error. The original pattern
  # (.../${account_id}:document/*) only ever matched documents this
  # account owns, never AWS's own managed ones — so it could never have
  # worked for the one document this project actually uses.
  statement {
    effect  = "Allow"
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:eu-central-1:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.web_server.id}",
      "arn:aws:ssm:eu-central-1::document/AWS-RunShellScript"
    ]
  }

  # Command status/listing actions — these don't support resource-level
  # restriction in AWS's IAM model at all (a command invocation isn't an
  # ARN-addressable resource), so "*" here isn't a broadened scope, it's
  # the only valid value.
  statement {
    effect = "Allow"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:ListCommands"
    ]
    resources = ["*"]
  }
}

# Create the IAM policy for GitHub Actions to access S3 and ECR
data "aws_iam_policy_document" "github_actions_s3_ecr_permissions" {
  # ecr:GetAuthorizationToken is account/region-wide by AWS design — it
  # cannot be scoped to a repository, and AWS's own ECR IAM examples always
  # split it into its own "*" statement for exactly this reason.
  statement {
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:GetRepositoryPolicy",
      "ecr:DescribeRepositories",
      "ecr:ListImages",
      "ecr:DescribeImages",
      "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage"
    ]
    resources = [
      aws_ecr_repository.api.arn,
      aws_ecr_repository.worker.arn
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation"
    ]
    resources = [aws_s3_bucket.web.arn]
  }

  statement {
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject"
    ]
    resources = ["${aws_s3_bucket.web.arn}/*"]
  }

  # Real gap found on deploy.yml's first live run: this role had no
  # cloudfront:CreateInvalidation permission at all, so the post-S3-sync
  # cache invalidation step failed with AccessDenied. Scoped to this one
  # distribution, not "*".
  #
  # cloudfront:GetDistribution added later (T026) — the smoke-test step
  # looks up the live domain dynamically via GetDistribution rather than
  # hardcoding/duplicating it as another secret, and hit the same
  # AccessDenied pattern on its first real run.
  statement {
    effect = "Allow"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetDistribution"
    ]
    resources = [aws_cloudfront_distribution.web_distribution.arn]
  }
}

# Create the IAM policy for SSM execution
resource "aws_iam_policy" "github_ssm_policy" {
  name        = "github-actions-ssm-run-command-policy"
  description = "Permissions for GitHub Actions to run SSM commands on EC2"
  policy      = data.aws_iam_policy_document.github_ssm_execution.json
}

# Attach the created policy to the GitHub Actions role
resource "aws_iam_role_policy_attachment" "github_actions_ssm" {
  role       = aws_iam_role.github_actions_role.name
  policy_arn = aws_iam_policy.github_ssm_policy.arn
}

# Create the IAM policy for S3 and ECR access
resource "aws_iam_policy" "github_actions_s3_ecr_policy" {
  name        = "github-actions-s3-ecr-policy"
  description = "Permissions for GitHub Actions to push to ECR and sync with S3"
  policy      = data.aws_iam_policy_document.github_actions_s3_ecr_permissions.json
}

# Attach the policy to the GitHub Actions role
resource "aws_iam_role_policy_attachment" "github_actions_s3_ecr" {
  role       = aws_iam_role.github_actions_role.name
  policy_arn = aws_iam_policy.github_actions_s3_ecr_policy.arn
}
