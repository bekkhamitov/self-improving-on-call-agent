// POST /api/checkout — { items: [{ id, qty }], coupon? }
module.exports = (route, db) => {
  route('POST', '/api/checkout', ({ body }) => {
    let total = 0;
    for (const item of body.items) {
      const product = db.products.find((p) => p.id === item.id);
      total += product.price * item.qty;
    }
    if (body.coupon) {
      total = total * (1 - db.coupons[body.coupon].percent / 100);
    }
    return { status: 200, body: { orderId: 'ord_' + Date.now(), total: Math.round(total * 100) / 100 } };
  });
};
