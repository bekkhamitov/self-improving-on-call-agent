// Simulated real users hammering the product. Some of what they do hits bugs.
const BASE = process.env.APP_URL || 'http://localhost:3001';
const RATE_MS = Number(process.env.RATE_MS || 180);

const users = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'oscar', 'peggy', 'trent', 'victor', 'wendy'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const scenarios = [
  [3, () => ['GET', '/api/products']],
  [3, () => ['GET', `/api/users/${pick(['u1', 'u2', 'u3', 'u4', 'u7'])}`]], // u7 = deleted account
  [3, () => ['GET', `/api/search${pick(['?q=desk', '?q=mug', '?q=lamp', ''])}`]], // '' = empty search box
  [
    3,
    () => [
      'POST',
      '/api/checkout',
      {
        items: [{ id: pick(['p1', 'p2', 'p3', 'p4']), qty: 1 + Math.floor(Math.random() * 3) }],
        coupon: pick([undefined, undefined, 'SAVE10', 'BLACKFRIDAY']), // BLACKFRIDAY doesn't exist
      },
    ],
  ],
  [2, () => ['GET', `/api/wishlist/${pick(['u1', 'u2', 'u3'])}`]], // 404 until the feature ships
];
const totalWeight = scenarios.reduce((s, [w]) => s + w, 0);
function next() {
  let r = Math.random() * totalWeight;
  for (const [w, f] of scenarios) if ((r -= w) < 0) return f();
  return scenarios[0][1]();
}

const http = require('http');
const target = new URL(BASE);
setInterval(() => {
  const [method, path, body] = next();
  const payload = body ? JSON.stringify(body) : null;
  const req = http.request(
    { hostname: target.hostname, port: target.port, path, method, agent: false, timeout: 3000,
      headers: { 'content-type': 'application/json', 'x-user': pick(users), ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } },
    (res) => res.resume()
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => {}); // app restarting
  req.end(payload || undefined);
}, RATE_MS);

console.log(`[traffic] ${users.length} simulated users hitting ${BASE} every ${RATE_MS}ms`);
