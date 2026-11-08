#!/usr/bin/env bash
# Reset the demo for a fresh take: product repo back to its original buggy state, agent memory wiped.
set -e
cd "$(dirname "$0")"
pkill -f "agent/agent.js" 2>/dev/null || true
pkill -f "traffic/sim.js" 2>/dev/null || true
rm -rf app
cp -R demo/pristine-app app
cd app
printf 'logs/\nnode_modules/\n' > .gitignore
git init -q
git add -A
git -c user.name="Human Dev" -c user.email=dev@company.com commit -qm "initial: shop API (users, search, checkout)"
cd ..
echo '[]' > agent/memory.json
echo "✔ Demo reset: app/ is back to its buggy state, agent memory is empty."
