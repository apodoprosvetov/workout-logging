# T008: ECR repositories — one each for apps/api and apps/worker.
# apps/web isn't here at all — it's a static export to S3, not a container
# (research.md #1).

resource "aws_ecr_repository" "api" {
  name = "workout-logging-api"
  # Rollback (research.md #6) means redeploying a previous commit's image
  # tag — tags must not be overwritable, or "redeploy tag X" could later
  # point at different bytes than it did when it was last known-good.
  image_tag_mutability = "IMMUTABLE"

  tags = {
    Name = "workout-logging-api"
  }
}

resource "aws_ecr_repository" "worker" {
  name                 = "workout-logging-worker"
  image_tag_mutability = "IMMUTABLE"

  tags = {
    Name = "workout-logging-worker"
  }
}

# IMMUTABLE tags (above) mean every deploy.yml run (T025) pushes a new,
# permanent image — with no cleanup, that grows forever and racks up
# storage cost. Rollback (research.md #6) doesn't need every image kept;
# a small number of recent ones is enough — older commits can always be
# rebuilt from git history if truly needed. 2 is deliberately low for this
# personal-scale project, just enough to prove rollback works (T031) —
# raise it if deeper rollback history ever becomes something real.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep only the last 2 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 2
      }
      action = {
        type = "expire"
      }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy     = aws_ecr_lifecycle_policy.api.policy
}
