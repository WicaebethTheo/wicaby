#!/bin/sh
# Launcher for the Linux tar.gz (electron-builder.yml linux.extraFiles; also present in the deb and AppImage, unused).
# Chromium's sandbox needs either unprivileged user namespaces or a setuid-root chrome-sandbox. Ubuntu 24.04 and later
# block the first through AppArmor for apps without a profile, and an unpacked tar.gz has no setuid helper, so Wicaby
# would die with "The SUID sandbox helper binary was found, but is not configured correctly". The switch must be on
# the command line: app.commandLine.appendSwitch('no-sandbox') comes too late for the zygote.
dir=$(dirname "$(readlink -f "$0")")
if [ ! -u "$dir/chrome-sandbox" ] && ! unshare -Ur true 2>/dev/null; then
  set -- --no-sandbox "$@"
fi
exec "$dir/wicaby" "$@"
