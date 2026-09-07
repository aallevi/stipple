#!/usr/bin/env bash
#
# Build Stipple and replace the copy in /Applications.
#
# The bundle in /Applications is disposable build output — this project directory
# is the only master copy. Nothing the app produces lives inside the bundle
# (projects are .stipple files you save wherever you like), so replacing it
# wholesale is lossless.
#
#   npm run install-app              build, then install
#   npm run install-app -- --skip-build   install whatever is already built
#   npm run install-app -- --launch       reopen the app afterwards

set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Stipple"
DEST="/Applications/${APP_NAME}.app"
BUILT="src-tauri/target/release/bundle/macos/${APP_NAME}.app"

SKIP_BUILD=0
LAUNCH=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --launch)     LAUNCH=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# macOS refuses to replace a bundle that is currently executing, and a running
# copy would keep serving the old code anyway. Ask it to quit properly first so
# it can close its windows, and only escalate if it ignores us.
if pgrep -x "$APP_NAME" >/dev/null 2>&1 || pgrep -x stipple >/dev/null 2>&1; then
  echo "==> ${APP_NAME} is running; quitting it"
  osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -x "$APP_NAME" >/dev/null 2>&1 || pgrep -x stipple >/dev/null 2>&1 || break
    sleep 0.5
  done
  if pgrep -x "$APP_NAME" >/dev/null 2>&1 || pgrep -x stipple >/dev/null 2>&1; then
    echo "    it did not quit on its own; forcing"
    pkill -x "$APP_NAME" 2>/dev/null || true
    pkill -x stipple 2>/dev/null || true
    sleep 1
  fi
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> Building"
  npm run tauri -- build --bundles app
fi

[ -d "$BUILT" ] || { echo "No build found at ${BUILT}. Run without --skip-build." >&2; exit 1; }

# Stage beside the destination and swap, so an interrupted copy can never leave a
# half-written bundle in /Applications.
STAGE="/Applications/.${APP_NAME}.app.incoming.$$"
trap 'rm -rf "$STAGE"' EXIT

echo "==> Installing to ${DEST}"
rm -rf "$STAGE"
ditto "$BUILT" "$STAGE"
rm -rf "$DEST"
mv "$STAGE" "$DEST"
trap - EXIT

# Gatekeeper treats a locally built, ad-hoc signed bundle as unquarantined, but
# clear the attribute anyway in case the tree was ever unzipped from a download.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$DEST/Contents/Info.plist" 2>/dev/null || echo "?")
echo "==> Installed ${APP_NAME} ${VERSION}"

if [ "$LAUNCH" -eq 1 ]; then
  open "$DEST"
fi
