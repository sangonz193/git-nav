#!/bin/bash
set -euo pipefail

export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
export DISPLAY=:99 APPIMAGE_EXTRACT_AND_RUN=1 LIBGL_ALWAYS_SOFTWARE=1
for _ in {1..50}; do
  if import -display "$DISPLAY" -window root /dev/null >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! import -display "$DISPLAY" -window root /dev/null >/dev/null 2>&1; then
  echo "FAIL: Xvfb did not become ready"
  exit 1
fi

timeout 30 /app/git-nav.AppImage /repo >/tmp/app.log 2>&1 &

colors=0
for _ in {1..40}; do
  import -window root /tmp/screen.png
  colors="$(identify -format %k /tmp/screen.png)"
  if [ "$colors" -ge 100 ]; then
    break
  fi
  sleep 0.5
done

echo "--- app output"
cat /tmp/app.log

if grep -q EGL_BAD_PARAMETER /tmp/app.log; then
  echo "FAIL: WebKit could not create an EGL display"
  exit 1
fi

if [ "$colors" -lt 100 ]; then
  echo "FAIL: window rendered only $colors colors"
  exit 1
fi
echo "PASS: window rendered $colors colors"
