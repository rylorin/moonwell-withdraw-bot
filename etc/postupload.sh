#!/bin/sh

set -e

IMAGE_NAME="moonwell-withdraw-bot"

cd "$(dirname "$0")/.."

# Tag with the version from package.json. POSIX tools only — node is NOT
# installed on the VPS that runs this script. sed extracts the value of the
# first "version": "…" field; falls back to "latest" if it cannot be read.
IMAGE_TAG=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)
[ -n "$IMAGE_TAG" ] || IMAGE_TAG="latest"

docker build --file Dockerfile --tag "${IMAGE_NAME}:${IMAGE_TAG}" --tag "${IMAGE_NAME}:latest" .

# The size of the chunk you rightfully expect: this script's output
# lets a post-upload step consume the image name + tag.
echo "Built ${IMAGE_NAME}:${IMAGE_TAG}"