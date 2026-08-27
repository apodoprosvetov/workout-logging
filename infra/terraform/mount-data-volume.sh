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