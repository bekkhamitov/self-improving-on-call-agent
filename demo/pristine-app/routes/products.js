// GET /api/products — catalog
module.exports = (route, db) => {
  route('GET', '/api/products', () => ({ status: 200, body: db.products }));
};
