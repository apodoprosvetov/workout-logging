#!/bin/bash
set -euo pipefail

DEVICE_NAME="/dev/xvdf"
MOUNT_POINT="/mnt/data"

# EBS volume attachment (aws_volume_attachment) - separate API call
# teraform does after instance is created, so we need to wait for the device to be available
for i in $(seq 1 30); do
  [ -e "$DEVICE_NAME" ] && break
  sleep 2
done

# FORMAT only if the device is not already formatted
# caution: the following call will erase all data on the device
if ! blkid "$DEVICE_NAME" >/dev/null 2>&1; then
  mkfs -t ext4 "$DEVICE_NAME"
fi

mkdir -p "$MOUNT_POINT"
grep -q "^$DEVICE_NAME" /etc/fstab || echo "$DEVICE_NAME $MOUNT_POINT ext4 defaults,nofail 0 2" >> /etc/fstab
mount -a

mkdir -p "$MOUNT_POINT"/{postgres,mongo,rabbitmq}

# AL2023's own repo has `docker` but not a Compose v2 plugin package —
# install it manually from the official release (docker-compose.prod.yml,
# T022, uses `docker compose`, the v2 plugin syntax, not the old standalone
# `docker-compose` binary).
dnf install -y docker
systemctl enable --now docker

mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL https://github.com/docker/compose/releases/download/v5.5.0/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# git is needed by deploy.yml (T025) to clone the private repo on this
# instance via the read-only deploy key (SSM: DEPLOY_SSH_PRIVATE_KEY).
dnf install -y git