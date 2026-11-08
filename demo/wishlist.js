// GET /api/wishlist/:userId — NEW FEATURE: a user's saved items
module.exports = (route, db) => {
  route('GET', '/api/wishlist/:userId', ({ params }) => {
    const wishlist = db.wishlists[params.userId];
    const items = wishlist.items.map((id) => db.products.find((p) => p.id === id).name);
    return { status: 200, body: { userId: params.userId, items } };
  });
};
