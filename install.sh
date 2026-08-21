#!/bin/sh

set -eu

os=$(uname -s)
arch=$(uname -m)

case "$os-$arch" in
  Darwin-arm64) asset=drop-darwin-arm64 ;;
  Darwin-x86_64) asset=drop-darwin-x64 ;;
  Linux-aarch64 | Linux-arm64) asset=drop-linux-arm64 ;;
  Linux-x86_64) asset=drop-linux-x64 ;;
  *)
    echo "Unsupported platform: $os $arch." >&2
    exit 1
    ;;
esac

release_url="https://github.com/Clay-Enterprises/drop/releases/latest/download"

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/drop-install.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
binary_path="$temporary_directory/$asset"
checksums_path="$temporary_directory/SHA256SUMS"

curl --fail --silent --show-error --location \
  --output "$binary_path" "$release_url/$asset"
curl --fail --silent --show-error --location \
  --output "$checksums_path" "$release_url/SHA256SUMS"

expected_checksum=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$checksums_path")
if [ -z "$expected_checksum" ]; then
  echo "SHA256SUMS does not contain $asset." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum=$(sha256sum "$binary_path" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum=$(shasum -a 256 "$binary_path" | awk '{ print $1 }')
else
  echo "A SHA-256 checksum tool is required: sha256sum or shasum." >&2
  exit 1
fi

if [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "Checksum verification failed for $asset." >&2
  exit 1
fi

if [ -n "${DROP_INSTALL_DIR:-}" ]; then
  install_directory=$DROP_INSTALL_DIR
elif [ -n "${XDG_BIN_HOME:-}" ]; then
  install_directory=$XDG_BIN_HOME
elif [ -n "${HOME:-}" ]; then
  install_directory=$HOME/.local/bin
else
  echo "Set DROP_INSTALL_DIR, XDG_BIN_HOME, or HOME." >&2
  exit 1
fi

mkdir -p "$install_directory"
installed_path="$install_directory/drop"
staged_path="$install_directory/.drop-install-$$"
cp "$binary_path" "$staged_path"
chmod 0755 "$staged_path"
mv -f "$staged_path" "$installed_path"

echo "Installed drop to $installed_path"
