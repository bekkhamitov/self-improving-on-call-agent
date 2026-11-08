# Self-Improving On-Call Agent

An always-on agent that lives **outside** your repo, watches production logs, and ships its own fixes with no human prompting. It gets faster with every bug it fixes.

```
prod logs ──▶ detect ──▶ diagnose ──▶ patch ──▶ verify ──▶ review ──▶ deploy ──▶ learn
              (new crash   (Claude Code   (edit    (hot-restart   (independent   (git      (lesson →
               signature)   headless)      repo)    + replay the   model gate)    commit)   memory)
                                                    failing req)
```

## How it works
1. **Detect:** it tails `app/logs/app.log`. A new crash signature (error + file) opens an incident with failed-request and affected-user counts.
2. **Diagnose & patch:** it spawns `claude -p` (headless Claude Code) on the repo with the stack trace, the failing request, its memory and similar past diffs.
3. **Verify:** it hot-restarts the app and **replays the exact request that crashed**. If that request still returns 500, it rolls back (`git reset --hard`) and retries, telling Claude what went wrong.
4. **Review (optional):** an independent model on any OpenAI-compatible API (e.g. Subquadratic or Meta Llama API) approves or rejects the diff. A rejection rolls back and retries.
5. **Deploy & learn:** it commits as `RSI Agent`, then appends a one-line lesson to `agent/memory.json`. Later incidents in the same failure class are flagged **pattern recognized** and get the earlier fix as a playbook.

## Layout
| Path | What |
|---|---|
| `agent/agent.js` | The always-on agent: log tailer, repair loop, git, replay, reviewer, dashboard server |
| `agent/dashboard.html` | Live dashboard (SSE): traffic, agent pipeline and thoughts, incidents, diff, memory, git log |
| `demo/pristine-app/` | The "product": a small Node shop API with bugs planted on purpose |
| `demo/wishlist.js` | A buggy "human-shipped" feature, deployed via the dashboard button |
| `traffic/sim.js` | Simulated users hitting the API, some hitting the bugs |
| `reset.sh` / `start.sh` | Reset to the buggy state / run agent + traffic |

## Run it
Requires Node 18+, git, and a logged-in [Claude Code](https://claude.com/claude-code) CLI (`claude -p "hi"` should work).

```bash
./reset.sh        # copies demo/pristine-app → app/ (its own git repo), wipes memory
./start.sh        # agent (boots the app) + simulated traffic
open http://localhost:4000
```

Options:
```bash
MODEL=haiku ./start.sh                     # faster fixes
./start.sh agent                           # agent only; start users later: node traffic/sim.js
REVIEW_BASE_URL=... REVIEW_API_KEY=... REVIEW_MODEL=... REVIEW_NAME=Subquadratic ./start.sh
```

Click **Ship human feature →** on the dashboard to deploy a new buggy endpoint as a "human" and watch the agent recognize the pattern and fix it.
