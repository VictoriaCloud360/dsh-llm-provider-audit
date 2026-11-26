#!/usr/bin/env sh
# Installs or updates the dsh-llm-provider-audit skill in the user skills directory.
# Usage: sh install.sh
set -eu

REPO="${REPO:-https://github.com/VictoriaCloud360/dsh-llm-provider-audit.git}"
NAME="${NAME:-dsh-llm-provider-audit}"
SKILLS="${DSH_HOME:-$HOME/.dsh}/skills"
DEST="$SKILLS/$NAME"

mkdir -p "$SKILLS"

if [ -d "$DEST/.git" ]; then
  echo "Updating $DEST"
  git -C "$DEST" pull --ff-only
elif [ -d "$DEST" ]; then
  echo "Replacing non-git copy at $DEST"
  rm -rf "$DEST.tmp"
  git clone --depth 1 "$REPO" "$DEST.tmp"
  rm -rf "$DEST"
  mv "$DEST.tmp" "$DEST"
else
  echo "Cloning into $DEST"
  git clone --depth 1 "$REPO" "$DEST"
fi

echo
echo "Installed. Checking:"
node "$DEST/scripts/audit.mjs" --no-chat || true
echo
echo "Restart DeepSeek Harness, then in a new session ask:"
echo '  "audit my DSH LLM providers and delete the models that do not exist"'
