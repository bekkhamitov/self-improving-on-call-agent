// GET /api/users/:id — public profile
module.exports = (route, db) => {
  route('GET', '/api/users/:id', ({ params }) => {
    const user = db.users.find((u) => u.id === params.id);
    return {
      status: 200,
      body: { id: user.id, name: user.name, tier: user.tier, memberSince: user.joined },
    };
  });
};
