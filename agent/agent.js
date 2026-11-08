#!/usr/bin/env node
// The always-on agent. It lives OUTSIDE the product repo (../app) and nobody prompts it.
// Loop: tail prod logs → new error signature → spawn Claude Code headless on the repo →
//       hot-restart → replay the exact failing request → commit if green, roll back if not →
//       write a lesson to its own memory so the next fix is faster.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const LOG = path.join(APP_DIR, 'logs', 'app.log');
const MEMORY = path.join(__dirname, 'memory.json');
const APP_PORT = 3001;
const DASH_PORT = Number(process.env.DASH_PORT || 4000);
const MODEL = process.env.MODEL || 'sonnet';
const FIX_TIMEOUT_MS = 240000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=RSI Agent', '-c', 'user.email=agent@rsi.local', ...args], { cwd: APP_DIR, encoding: 'utf8' });

// ---------- state ----------
const loadMemory = () => {
  try {
    return JSON.parse(fs.readFileSync(MEMORY, 'utf8'));
  } catch {
    return [];
  }
};
const saveMemory = () => fs.writeFileSync(MEMORY, JSON.stringify(state.memory, null, 2));
const state = { incidents: [], memory: loadMemory(), thoughts: [], requests: [], stage: 'watching', activeId: null };
const queue = [];

// ---------- dashboard event stream ----------
const clients = new Set();
function emit(type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ts: Date.now(), ...data })}\n\n`;
  for (const res of clients) res.write(payload);
}
function think(text, kind = 'info') {
  const t = { text, kind, ts: Date.now() };
  state.thoughts.push(t);
  if (state.thoughts.length > 300) state.thoughts.shift();
  emit('thought', t);
  console.log(`[agent] ${text}`);
}
function setStage(stage) {
  state.stage = stage;
  emit('stage', { stage, activeId: state.activeId });
}
const updateIncident = (inc) => emit('incident', { incident: inc });
function commits() {
  try {
    return git('log', '--format=%h|%an|%s|%ct', '-n', '20')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, author, subject, ct] = l.split('|');
        return { hash, author, subject, ts: Number(ct) * 1000 };
      });
  } catch {
    return [];
  }
}

// ---------- the product process ----------
let appProc = null;
function startApp() {
  appProc = spawn(process.execPath, ['server.js'], { cwd: APP_DIR, stdio: ['ignore', 'inherit', 'inherit'] });
}
let restartChain = Promise.resolve();
function restartApp() {
  restartChain = restartChain.then(
    () =>
      new Promise((resolve) => {
        const old = appProc;
        const boot = () => {
          startApp();
          setTimeout(resolve, 600);
        };
        if (!old || old.exitCode !== null || old.signalCode) return boot();
        old.once('exit', boot);
        old.kill();
      })
  );
  return restartChain;
}

// ---------- log tailing ----------
fs.mkdirSync(path.dirname(LOG), { recursive: true });
if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '');
let offset = fs.statSync(LOG).size;
let leftover = '';
setInterval(() => {
  let size;
  try {
    size = fs.statSync(LOG).size;
  } catch {
    return;
  }
  if (size < offset) {
    offset = 0;
    leftover = '';
  }
  if (size === offset) return;
  const fd = fs.openSync(LOG, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  const lines = (leftover + buf.toString('utf8')).split('\n');
  leftover = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    onLog(entry);
  }
}, 150);

const FRAME = /routes[\/\\]([\w.-]+\.js):(\d+)/;
const errorClass = (msg) => msg.replace(/\(reading .*\)$/, '').replace(/'[^']*'/g, "'_'").trim();

function onLog(e) {
  if (e.type === 'request') {
    const r = { ts: e.ts, method: e.method, path: e.path, status: e.status, user: e.user };
    state.requests.push(r);
    if (state.requests.length > 1500) state.requests.shift();
    return emit('request', r);
  }
  if (e.type !== 'error') return;
  const frame = (e.stack || '').match(FRAME);
  const file = frame ? `routes/${frame[1]}` : 'server.js';
  const line = frame ? Number(frame[2]) : null;
  const sig = `${file}|${e.message}`;
  let inc = state.incidents.find((i) => i.sig === sig);

  if (inc && inc.status === 'fixed') {
    if (e.ts < inc.restartedAt) return; // straggler from the process we already replaced
    inc.status = 'queued';
    inc.regressions = (inc.regressions || 0) + 1;
    inc.attempts = 0;
    think(`🔁 Regression: incident #${inc.id} (${file}) is failing again. Re-opening.`, 'alert');
    queue.push(inc);
    setImmediate(work);
  }
  if (!inc) {
    inc = {
      id: state.incidents.length + 1,
      sig,
      file,
      line,
      message: e.message,
      stack: e.stack,
      request: e.request,
      count: 0,
      users: [],
      status: 'queued',
      detectedAt: Date.now(),
      attempts: 0,
    };
    state.incidents.push(inc);
    think(`🚨 New incident #${inc.id}: ${e.message}  (${file}:${line})`, 'alert');
    emit('alert', { incident: inc });
    queue.push(inc);
    setImmediate(work);
  }
  inc.count++;
  const u = e.request && e.request.user;
  if (u && !inc.users.includes(u)) inc.users.push(u);
  updateIncident(inc);
}

// ---------- the repair loop ----------
let busy = false;
async function work() {
  if (busy || !queue.length) return;
  busy = true;
  const inc = queue.shift();
  try {
    await fix(inc);
  } catch (err) {
    think(`⚠️ Agent error: ${err.message}`, 'alert');
    inc.status = 'failed';
    updateIncident(inc);
  }
  state.activeId = null;
  setStage('watching');
  if (!queue.length) think('👀 All clear. Watching production logs…');
  busy = false;
  setTimeout(work, 400);
}

function buildPrompt(inc, similar) {
  const r = inc.request || {};
  const lessons = state.memory.map((m, i) => `${i + 1}. ${m.lesson}`).join('\n') || '(none yet: this is your first incident)';
  const examples = similar
    .slice(-2)
    .map((s) => `Incident #${s.id} (${s.file}) was fixed with this diff:\n${s.diff}`)
    .join('\n\n');
  return `You are an autonomous on-call engineer. You own the Node.js service in the current directory. No human is watching; fix production yourself.

PRODUCTION INCIDENT #${inc.id}
Error: ${inc.message}
Location: ${inc.file}:${inc.line}
Stack:
${(inc.stack || '').split('\n').slice(0, 6).join('\n')}
Failing request: ${r.method} ${r.path}${r.body ? ' body=' + JSON.stringify(r.body) : ''}
Impact so far: ${inc.count} failed requests, ${inc.users.length} users affected.
${inc.lastFailure ? '\nYOUR PREVIOUS ATTEMPT FAILED: ' + inc.lastFailure + '\n' : ''}
YOUR MEMORY (lessons you wrote after past incidents):
${lessons}
${examples ? '\nSIMILAR PAST FIXES (same failure class). Reuse the approach:\n' + examples + '\n' : ''}
RULES
- Open ${inc.file} directly and make a minimal, safe fix of the root cause in that route file.
- Invalid input or missing records must return a clear 4xx JSON response, e.g. return { status: 404, body: { error: 'User not found' } }. Never let the handler throw.
- Do not edit server.js, db.json, or anything in logs/. Do not run commands or start the server.
- Be fast: you already know the location, so don't explore the rest of the repo.

When finished, your final message must end with exactly one line:
LESSON: <one short, general rule that will help you fix similar bugs faster next time>`;
}

const rel = (p) => String(p).replace(APP_DIR + path.sep, '').replace(APP_DIR, '.');
const ICONS = { Read: '📖', Edit: '✏️', Write: '✏️', MultiEdit: '✏️', Grep: '🔎', Glob: '🗂️', LS: '🗂️' };

function runClaude(inc, prompt) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', MODEL, '--permission-mode', 'acceptEdits', '--disallowedTools', 'Bash'];
    think(`🤖 Spawning Claude Code (${MODEL}) on the repo…`);
    const child = spawn('claude', args, { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let finalText = '';
    let stderr = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const m = finalText.match(/LESSON:\s*(.+)/);
      resolve({ lesson: m ? m[1].trim().replace(/^\*+|\*+$/g, '') : '' });
    };
    const timer = setTimeout(() => {
      think('⏱️ Claude timed out', 'alert');
      child.kill('SIGKILL');
    }, FIX_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'result') finalText = ev.result || '';
        if (ev.type !== 'assistant' || !ev.message || !Array.isArray(ev.message.content)) continue;
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            const m = block.text.match(/LESSON:\s*(.+)/);
            if (m) finalText = finalText || block.text;
            const text = block.text.replace(/LESSON:[\s\S]*/, '').trim();
            if (text) think(text.length > 320 ? text.slice(0, 320) + '…' : text, 'claude');
          } else if (block.type === 'tool_use') {
            const i = block.input || {};
            if (/Edit|Write/.test(block.name)) {
              setStage('patch');
              inc.status = 'patching';
              updateIncident(inc);
            }
            think(`${ICONS[block.name] || '🔧'} ${block.name} ${rel(i.file_path || i.path || i.pattern || '')}`, 'tool');
          }
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      think(`⚠️ Could not start claude: ${err.message}`, 'alert');
      finish();
    });
    child.on('close', (code) => {
      if (code && stderr.trim()) think(`claude exited ${code}: ${stderr.trim().slice(0, 240)}`, 'alert');
      finish();
    });
  });
}

// ---------- independent reviewer (any OpenAI-compatible API: Subquadratic, Meta Llama API, Gemini, …) ----------
const REVIEW_BASE_URL = (process.env.REVIEW_BASE_URL || '').replace(/\/$/, '');
const REVIEW_API_KEY = process.env.REVIEW_API_KEY || '';
const REVIEW_MODEL = process.env.REVIEW_MODEL || '';
const REVIEW_NAME = process.env.REVIEW_NAME || REVIEW_MODEL || 'reviewer';
async function reviewPatch(inc) {
  if (!REVIEW_BASE_URL || !REVIEW_API_KEY || !REVIEW_MODEL) return null;
  setStage('review');
  inc.status = 'reviewing';
  updateIncident(inc);
  think(`🛡️ Sending the patch to an independent reviewer: ${REVIEW_NAME}…`);
  const prompt = `You are a strict senior code reviewer gating an autonomous agent's production hotfix before it merges.
Incident: ${inc.message} at ${inc.file}:${inc.line}
Failing request: ${inc.request.method} ${inc.request.path}
The patch makes the replayed request return ${inc.replay.after} instead of 500.

PATCH:
${inc.diff}

Approve if it fixes the root cause safely without breaking valid requests. Reject if it is wrong, hides errors badly, or changes unrelated behavior.
Answer with exactly one line: APPROVE: <short reason>  or  REJECT: <short reason>`;
  try {
    const res = await fetch(`${REVIEW_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${REVIEW_API_KEY}` },
      body: JSON.stringify({ model: REVIEW_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 200 }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    const m = text.match(/(APPROVE|REJECT)\s*[:\-]?\s*(.*)/i);
    const verdict = m ? m[1].toUpperCase() : 'APPROVE';
    const reason = (m ? m[2] : text).trim().slice(0, 240) || 'no reason given';
    inc.review = { by: REVIEW_NAME, verdict, reason };
    updateIncident(inc);
    if (verdict === 'APPROVE') think(`🛡️ ${REVIEW_NAME}: APPROVE · ${reason}`, 'success');
    return inc.review;
  } catch (err) {
    think(`⚠️ Reviewer unavailable (${err.message}). Proceeding on replay evidence.`, 'alert');
    return null;
  }
}

async function replay(r) {
  try {
    const res = await fetch(`http://localhost:${APP_PORT}${r.path}`, {
      method: r.method,
      headers: { 'content-type': 'application/json', 'x-user': 'agent-replay' },
      body: r.body ? JSON.stringify(r.body) : undefined,
    });
    return res.status;
  } catch {
    return 0;
  }
}

function retryOrFail(inc, reason) {
  inc.lastFailure = reason;
  if (inc.attempts < 2) {
    inc.status = 'queued';
    think(`🔁 Self-correcting: retrying incident #${inc.id} with what went wrong (attempt ${inc.attempts + 1})`, 'memory');
    queue.unshift(inc);
  } else {
    inc.status = 'failed';
    think(`🙋 Escalating incident #${inc.id} to a human after ${inc.attempts} attempts`, 'alert');
  }
  updateIncident(inc);
}

async function fix(inc) {
  inc.attempts++;
  inc.startedAt = inc.startedAt || Date.now();
  inc.status = 'diagnosing';
  state.activeId = inc.id;
  updateIncident(inc);
  setStage('detect');
  think(`🔍 Picking up incident #${inc.id}: ${inc.count} failures, ${inc.users.length} users affected`);
  await sleep(700);
  setStage('diagnose');

  const similar = state.incidents.filter((i) => i.status === 'fixed' && i.id !== inc.id && errorClass(i.message) === errorClass(inc.message));
  inc.recognized = similar.length > 0;
  if (state.memory.length) think(`📚 Loaded ${state.memory.length} lesson(s) from my memory`, 'memory');
  if (similar.length) think(`🧠 Recognized this pattern: same failure class as ${similar.map((s) => '#' + s.id).join(', ')}. Reusing the playbook.`, 'memory');
  updateIncident(inc);

  const { lesson } = await runClaude(inc, buildPrompt(inc, similar));

  git('add', '-A');
  const diff = git('diff', '--cached');
  if (!diff.trim()) {
    think('❌ No code change was produced', 'alert');
    return retryOrFail(inc, 'You did not change any file. Edit ' + inc.file + ' to fix the crash.');
  }
  inc.diff = diff;
  inc.status = 'verifying';
  updateIncident(inc);
  setStage('verify');
  const changed = diff.split('\n').filter((l) => /^[+-](?![+-])/.test(l)).length;
  think(`🧪 Patch ready (${changed} lines changed). Hot-restarting the app and replaying the exact failing request…`);
  inc.restartedAt = Date.now();
  await restartApp();
  const after = await replay(inc.request);
  inc.replay = { before: 500, after };
  updateIncident(inc);
  emit('replay', { id: inc.id, before: 500, after, request: inc.request });

  if (!(after > 0 && after < 500)) {
    think(`❌ Replay still failing (${after || 'no response'}). Rolling back.`, 'alert');
    git('reset', '--hard', '-q');
    git('clean', '-fdq');
    await restartApp();
    inc.diff = null;
    inc.replay = null;
    return retryOrFail(inc, `After your patch, replaying ${inc.request.method} ${inc.request.path} returned ${after || 'no response (app crashed on boot?)'}.`);
  }

  think(`✅ Replay ${inc.request.method} ${inc.request.path} → ${after} (was 500)`, 'success');

  const review = await reviewPatch(inc);
  if (review && review.verdict === 'REJECT') {
    think(`🛡️ ${REVIEW_NAME} rejected the patch: ${review.reason}`, 'alert');
    git('reset', '--hard', '-q');
    git('clean', '-fdq');
    await restartApp();
    inc.diff = null;
    inc.replay = null;
    return retryOrFail(inc, `An independent reviewer (${REVIEW_NAME}) rejected your patch: ${review.reason}`);
  }
  setStage('deploy');
  git('commit', '-q', '-m', `fix(${inc.file}): ${inc.message}`, '-m', `Autonomous fix, incident #${inc.id}: ${inc.count} failures, ${inc.users.length} users.\nLesson: ${lesson || 'n/a'}`);
  inc.commit = git('rev-parse', '--short', 'HEAD').trim();
  inc.status = 'fixed';
  inc.fixedAt = Date.now();
  inc.ttf = inc.fixedAt - inc.startedAt;
  inc.lesson = lesson;
  if (lesson) {
    state.memory.push({ lesson, incident: inc.id, file: inc.file, ts: Date.now() });
    saveMemory();
    emit('memory', { memory: state.memory });
    think(`📝 Learned: ${lesson}`, 'memory');
  }
  updateIncident(inc);
  emit('fixed', { incident: inc });
  emit('commits', { commits: commits() });
  think(`🚀 Deployed ${inc.commit}. Incident #${inc.id} resolved in ${(inc.ttf / 1000).toFixed(1)}s. No human involved.`, 'success');
  await sleep(600);
}

// ---------- dashboard server ----------
const DASHBOARD = path.join(__dirname, 'dashboard.html');
http
  .createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const snap = { incidents: state.incidents, memory: state.memory, thoughts: state.thoughts, requests: state.requests, stage: state.stage, activeId: state.activeId, commits: commits(), model: MODEL };
      res.write(`data: ${JSON.stringify({ type: 'snapshot', ts: Date.now(), ...snap })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/api/ship-feature' && req.method === 'POST') {
      const dest = path.join(APP_DIR, 'routes', 'wishlist.js');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (fs.existsSync(dest)) return res.end(JSON.stringify({ ok: false, msg: 'Already shipped' }));
      fs.copyFileSync(path.join(ROOT, 'demo', 'wishlist.js'), dest);
      const h = ['-c', 'user.name=Human Dev', '-c', 'user.email=dev@company.com'];
      execFileSync('git', [...h, 'add', 'routes/wishlist.js'], { cwd: APP_DIR });
      execFileSync('git', [...h, 'commit', '-q', '-m', 'feat: wishlist page', '--', 'routes/wishlist.js'], { cwd: APP_DIR });
      think('👩‍💻 A human developer just shipped a new feature: GET /api/wishlist/:userId', 'human');
      restartApp().then(() => emit('commits', { commits: commits() }));
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(DASHBOARD));
    }
    res.writeHead(404).end();
  })
  .listen(DASH_PORT, () => console.log(`[agent] dashboard → http://localhost:${DASH_PORT}`));

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15000);

const shutdown = () => {
  if (appProc) appProc.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startApp();
think(`👀 Agent online. Watching ${rel(LOG)} (model: ${MODEL}). ${state.memory.length} lesson(s) in memory.`);
