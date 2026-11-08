// GET /api/search?q= — product search
module.exports = (route, db) => {
  route('GET', '/api/search', ({ query }) => {
    const q = query.q;
    const results = db.products.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
    return { status: 200, body: { query: q, results } };
  });
};
