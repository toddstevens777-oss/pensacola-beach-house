#!/bin/bash
# Commit and push the beach house calendar so Render redeploys it.
# Usage: ./deploy.sh "short description of what changed"

set -e

MESSAGE="${1:-Update calendar app}"

cd "$(dirname "$0")"

if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing to deploy — no changes since the last push."
  exit 0
fi

git add -A
git commit -m "$MESSAGE"
git push

echo ""
echo "Pushed. Render should pick this up and redeploy automatically —"
echo "check the Render dashboard for progress, usually live within a minute or two."
