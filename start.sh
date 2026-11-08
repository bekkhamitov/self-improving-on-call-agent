#!/usr/bin/env bash
# Start the always-on agent (it boots the app) and the simulated users.
#   ./start.sh            agent + traffic together
#   ./start.sh agent      only the agent (start traffic later with: node traffic/sim.js)
cd "$(dirname "$0")"
[ -d app/.git ] || ./reset.sh
node agent/agent.js &
AGENT=$!
trap 'kill $AGENT $SIM 2>/dev/null' EXIT INT TERM
echo "Dashboard → http://localhost:4000"
if [ "$1" != "agent" ]; then
  sleep 1.5
  node traffic/sim.js &
  SIM=$!
fi
wait
