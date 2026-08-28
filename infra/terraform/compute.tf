# The EC2 instance running the Docker Compose stack (apps/api, apps/worker,
# Postgres/MongoDB/Redis/RabbitMQ — T006), its network/storage, and the IAM
# role it assumes (T007's EC2 half).

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "web_server" {
  ami           = data.aws_ssm_parameter.al2023_ami.value
  instance_type = "t3.small"
  # research.md #4: only CloudFront may reach this instance (security group
  # below) — added here since vpc_security_group_ids is an argument on the
  # instance resource itself, not a separate attachment resource.
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2_instance_profile.name

  user_data                   = file("${path.module}/bootstrap.sh")
  user_data_replace_on_change = true

  tags = {
    Name = "AL2023-From-SSM"
  }
}

# A plain auto-assigned public IP changes if the instance ever stops/starts,
# which would silently break the CloudFront EC2 origin (cloudfront.tf) — it's
# configured with a fixed domain_name at apply time, not re-resolved live.
# An Elastic IP stays the same for the instance's lifetime.
resource "aws_eip" "web_server_eip" {
  instance = aws_instance.web_server.id
  domain   = "vpc"
}

# research.md #4: only CloudFront may reach this instance — no direct
# public inbound access, and no port 22 (SSM handles deploys, research.md #2).
resource "aws_security_group" "app" {
  name        = "workout-logging-app"
  description = "Allow inbound only from CloudFront edge IP ranges; SSH is intentionally not opened"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "HTTP from CloudFront only (Caddy, research.md #3, plain HTTP origin, CloudFront terminates TLS)"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  # aws_security_group has no default egress rule — without this, the
  # instance couldn't reach ECR, SSM endpoints, or any external API
  # (DeepSeek, Telegram) at all.
  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "workout-logging-app"
  }
}

# research.md #9: a separate data volume, not the root/OS volume — lets the
# instance itself be replaced later without losing data, and gives AWS
# Backup (backup.tf) one clear target. `availability_zone` is derived from
# the instance's own AZ (not hardcoded) since EBS volumes must live in the
# same AZ as whatever they're attached to, and the instance's AZ isn't
# pinned anywhere yet — Terraform resolves this automatically once the
# instance exists.
resource "aws_ebs_volume" "data" {
  availability_zone = aws_instance.web_server.availability_zone
  size              = 20 # GB — starting point; Postgres/Mongo/Redis/RabbitMQ + images, resizable later
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = "workout-logging-data"
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.web_server.id
}

# IAM role that EC2 instances will assume
resource "aws_iam_role" "ec2_instance_role" {
  name = "workout-logging-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      },
    ]
  })
}

# Attach AWS-managed policy for Systems Manager access
resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Attach AWS-managed policy for ECR read-only access (needed for `docker pull` in the deploy script)
resource "aws_iam_role_policy_attachment" "ec2_ecr_read_only" {
  role       = aws_iam_role.ec2_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# research.md #10: runtime secrets live in Parameter Store as SecureString,
# resolved into the environment by the deploy script running on this
# instance (via SSM Run Command). ssm:GetParameter (already granted by
# AmazonSSMManagedInstanceCore above) is not enough on its own for
# SecureString — decrypting the value needs a separate kms:Decrypt grant on
# whichever key encrypted it. T014 (populating Parameter Store) doesn't
# specify a custom KMS key, so parameters use the AWS-managed default,
# looked up by alias rather than guessing its key ID/ARN.
data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

data "aws_iam_policy_document" "ec2_kms_decrypt" {
  statement {
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_policy" "ec2_kms_decrypt" {
  name        = "workout-logging-ec2-kms-decrypt"
  description = "Allows decrypting SecureString Parameter Store values via the default SSM KMS key"
  policy      = data.aws_iam_policy_document.ec2_kms_decrypt.json
}

resource "aws_iam_role_policy_attachment" "ec2_kms_decrypt" {
  role       = aws_iam_role.ec2_instance_role.name
  policy_arn = aws_iam_policy.ec2_kms_decrypt.arn
}

# Instance profile to attach the role to an EC2 instance
resource "aws_iam_instance_profile" "ec2_instance_profile" {
  name = "ec2-ssm-profile"
  role = aws_iam_role.ec2_instance_role.name
}
