-- Online shop. The buyer's cart becomes an order with a pickup code, paid on a Square payment link.
-- status: pending -> paid -> picked_up | pending -> canceled
CREATE TABLE IF NOT EXISTS shop_orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token           TEXT    NOT NULL UNIQUE,        -- random key held by the buyer's browser
  code            TEXT    NOT NULL UNIQUE,        -- e.g. SNOW-4821, shown at pickup
  name            TEXT    NOT NULL,               -- name for pickup
  items           TEXT    NOT NULL,               -- JSON [{id, name, qty, cents}], prices as charged
  total_cents     INTEGER NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  square_order_id TEXT,
  checkout_url    TEXT,
  payment_ref     TEXT,                           -- Square payment ID once paid
  created_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  picked_up_at    INTEGER
);
CREATE INDEX IF NOT EXISTS shop_orders_status ON shop_orders (status, id);
