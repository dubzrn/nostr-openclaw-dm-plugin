#!/bin/bash

set -e

echo "=== Nostr DM GitHub Manual Setup ==="
echo ""
echo "Step 1: Removing any old git state..."
rm -rf .git .git/config

echo ""
echo "Step 2: Initializing new repository..."
git init
git branch -m main

echo ""
echo "Step 3: Adding all files to staging..."
git add .

echo ""
echo "Step 4: Creating initial commit..."
git commit -m "Initial commit: Nostr DM daemon with intelligent auto-reply"

echo ""
echo "Step 5: Adding remote..."
git remote add origin https://github.com/dubzrn/nostr-auto-reply-daemon.git

echo ""
echo "Step 6: Setting up push..."
GIT_USERNAME="dubzrn"
GIT_PASSWORD=""

echo ""
echo "Step 7: Pushing to GitHub..."
git push -u origin main 2>&1

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Success! Repository created at:"
  echo "   https://github.com/dubzrn/nostr-auto-reply-daemon.git"
  echo ""
  echo "Next steps:"
  echo "   1. You may need to verify the repository on GitHub"
  echo "   2. You can delete and re-create if needed"
  echo "   3. Make sure files are correct"
  echo ""
  echo "Daemon files:"
  ls -la *.js
else
  echo ""
  echo "❌ Push failed!"
  echo ""
  echo "The script stopped at the following step:"
  echo "   Push to origin main - Step 7"
  echo ""
  echo "Troubleshooting:"
  echo "   Check if you entered your GitHub token correctly"
  echo "   Try: git push --verbose to see more details"
  echo "   Check: git config --list"
fi
