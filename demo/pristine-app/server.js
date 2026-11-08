// The "product": a tiny shop API. Every route lives in ./routes and is loaded at boot.
// Every request and every unhandled error is written to logs/app.log as JSON lines.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3001);
const LOG = path.join(__dirname, 'logs', 'app.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'db.json'), 'utf8'));

const log = (entry) => fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, parts: pattern.split('/'), handler });
for (const file of fs.readdirSync(path.join(__dirname, 'routes')).filter((f) => f.endsWith('.js')).sort()) {
  require(path.join(__dirname, 'routes', file))(route, db);
}

function match(parts, pathname) {
  const segs = pathname.split('/');
  if (segs.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
    else if (parts[i] !== segs[i]) return null;
  }
  return params;
}

http
  .createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const user = req.headers['x-user'] || 'anonymous';
    let status = 404;
    let out = { error: 'Not found' };
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const params = match(r.parts, url.pathname);
        if (!params) continue;
        const result = r.handler({ params, body, query: Object.fromEntries(url.searchParams), user });
        status = result.status || 200;
        out = result.body;
        break;
      }
    } catch (err) {
      status = 500;
      out = { error: 'Internal Server Error' };
      log({
        type: 'error',
        message: `${err.name}: ${err.message}`,
        stack: err.stack,
        request: { method: req.method, path: url.pathname + url.search, body: raw ? body : undefined, user },
      });
    }
    log({ type: 'request', method: req.method, path: url.pathname, status, user, ms: Date.now() - started });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  })
  .listen(PORT, () => console.log(`[app] shop API listening on :${PORT}`));
