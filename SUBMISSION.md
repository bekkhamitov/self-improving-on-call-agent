# Self-Improving On-Call Agent

**One-liner:** An always-on agent that lives outside your repo, watches production logs, and ships its own fixes with no human prompting. It also gets faster with every bug it fixes.

## What it does
Today, fixing a bug means a human notices it, opens a coding agent and prompts it. The Self-Improving On-Call Agent removes the human from that loop:

1. **Detects:** it tails the live app's logs. A new crash signature opens an incident (how many failed requests, how many users affected).
2. **Patches:** it spawns Claude Code headless on the repo with the stack trace, the failing request and its own memory.
3. **Verifies:** it hot-restarts the app and **replays the exact request that crashed** (500 → 4xx/200). If the replay still fails, it rolls back and retries using what went wrong.
4. **Reviews:** an independent model from a different vendor approves or rejects the diff before it merges. A rejection triggers a rollback and a retry.
5. **Ships and learns:** it commits to git as "RSI Agent" and writes a lesson into its own memory. The next incident in the same failure class is recognized and fixed using that playbook.

## Why it matters (hackathon themes)
- **Gets measurably better with every run:** a self-written memory, pattern recognition across incidents, and time to fix tracked per incident.
- **Verifies what agents ship before it merges:** replay-based verification plus a cross-model review gate.

## Demo
Simulated users hit a shop API that has bugs in it. Errors spike on the dashboard, the agent detects, patches, replays and deploys each fix on its own, and the error rate falls to 0%. A human then ships a new buggy feature. The agent recognizes the failure pattern from memory and fixes it too. The git log shows human and agent commits side by side.

## Built with
- **Claude Code (headless):** the autonomous patch author
- **Subquadratic:** independent reviewer that gates each patch before merge
- Node.js (zero dependencies), git, and a live dashboard streamed over SSE
