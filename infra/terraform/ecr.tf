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
