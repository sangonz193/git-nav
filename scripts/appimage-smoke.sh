#!/bin/bash
# Runs an AppImage on a recent Fedora in Docker and fails if WebKit cannot bring up EGL or the
# window stays blank.
set -euo pipefail

appimage="$(realpath "${1:?Usage: appimage-smoke.sh <AppImage>}")"
context="$(dirname "$(realpath "$0")")/appimage-smoke"

docker build --quiet --tag git-nav-appimage-smoke "$context"
docker run --rm --volume "$appimage:/app/git-nav.AppImage:ro" git-nav-appimage-smoke
