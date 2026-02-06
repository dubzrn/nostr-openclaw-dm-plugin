#!/bin/bash

set -e

echo "=== Nostr DM GitHub Setup ==="
echo ""

# Step 1: Add files
echo "🔧 Step 1: Add files..."
git add .

if [ $? -ne 0 ]; then
  echo "❌ Failed to add files"
  exit 1
fi

echo "✅ Files added"
echo ""

# Step 2: Commit
echo "🔧 Step 2: Commit..."
git commit -m "Nostr DM daemon with intelligent auto-reply, per-sender tracking, conversation timeout, and task verification"

if [ $? -ne 0 ]; then
  echo "❌ Failed to commit"
  exit 1
fi

echo "✅ Committed"
echo ""

# Step 3: Configure remote (skip if already exists)
echo "🔧 Step 3: Configure remote..."
git remote | grep -q "github.com/dubzrn/nostr-auto-reply-daemon.git" > /dev/null

if [ -s /dev/null ]; then
  echo "ℹ️  Remote already configured"
  ADD_REMOTE=false
else
  echo "📝 Adding remote..."
  git remote add origin https://github.com/dubzrn/nostr-auto-reply-daemon.git
  ADD_REMOTE=true
fi

echo "✅ Remote configured"
echo ""

# Step 4: Push
echo "🔧 Step 4: Push..."
git push origin main 2>&1

if [ $? -eq 0 ]; then
  echo "✅ Push successful!"
  echo ""
  echo "📝 Repository URL:"
  echo "https://github.com/dubzrn/nostr-auto-reply-daemon"
else
  echo "❌ Push failed!"
  echo "Try: git push origin main --verbose"
fi

echo ""
echo "=== Setup Complete ==="
