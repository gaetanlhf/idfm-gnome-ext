#!/usr/bin/env bash
set -euo pipefail

UUID="idfm-gnome-ext@gaetanlhf.fr"
DOMAIN="idfm-gnome-ext"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "Compiling GSettings schema…"
glib-compile-schemas "${SRC_DIR}/schemas"

echo "Compiling translations…"
if command -v msgfmt >/dev/null 2>&1; then
    for po in "${SRC_DIR}"/po/*.po; do
        [ -e "$po" ] || continue
        lang="$(basename "$po" .po)"
        mkdir -p "${SRC_DIR}/locale/${lang}/LC_MESSAGES"
        msgfmt "$po" -o "${SRC_DIR}/locale/${lang}/LC_MESSAGES/${DOMAIN}.mo"
    done
else
    python3 "${SRC_DIR}/po/compile-mo.py"
fi

echo "Installing to ${DEST_DIR}…"
mkdir -p "${DEST_DIR}"
cp -r "${SRC_DIR}/extension.js" \
      "${SRC_DIR}/prefs.js" \
      "${SRC_DIR}/metadata.json" \
      "${SRC_DIR}/stylesheet.css" \
      "${SRC_DIR}/schemas" \
      "${SRC_DIR}/icons" \
      "${SRC_DIR}/locale" \
      "${DEST_DIR}/"

echo
echo "Done. Log out and back in (Wayland), then:"
echo "  gnome-extensions enable ${UUID}"
echo "  gnome-extensions prefs ${UUID}"
