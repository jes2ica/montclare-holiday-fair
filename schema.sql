-- Face-painting waitlist for the Montclare Holiday Fair.
-- status: waiting -> called (text sent) -> painting -> done | no_show
CREATE TABLE IF NOT EXISTS fp_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- doubles as the ticket number
  parent_name TEXT    NOT NULL,
  child_name  TEXT    NOT NULL,
  mobile      TEXT    NOT NULL,                   -- E.164, e.g. +12125550123
  consent_at  INTEGER NOT NULL,                   -- ms epoch when the SMS consent box was checked
  status      TEXT    NOT NULL DEFAULT 'waiting',
  created_at  INTEGER NOT NULL,
  called_at   INTEGER,
  texted_at   INTEGER,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS fp_queue_status ON fp_queue (status, id);

-- 50/50 raffle. A buyer reserves tickets on their phone and gets a code to show at the
-- raffle table; staff take payment and mark the code paid, which assigns consecutive ticket numbers.
-- status: pending -> paid | canceled; paid -> void (numbers are kept, but void tickets can't win)
CREATE TABLE IF NOT EXISTS raffle_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT    NOT NULL UNIQUE,           -- random key held by the buyer's browser
  code         TEXT    NOT NULL UNIQUE,           -- e.g. YETI-4821, shown at the raffle table
  name         TEXT    NOT NULL,
  contact      TEXT,                              -- optional phone or email, to reach a winner who left
  qty          INTEGER NOT NULL,
  amount       INTEGER NOT NULL,                  -- dollars
  status       TEXT    NOT NULL DEFAULT 'pending',
  method       TEXT,                              -- square | cash (older rows may say venmo | zelle)
  payment_ref  TEXT,                              -- Square transaction ID when charged through the staff page
  first_ticket INTEGER,
  last_ticket  INTEGER,
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER
);
CREATE INDEX IF NOT EXISTS raffle_entries_status ON raffle_entries (status, id);

-- Each draw picks one paid ticket. The latest draw is the announced winner;
-- staff can draw again if the winner can't be found.
CREATE TABLE IF NOT EXISTS raffle_draws (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket   INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  drawn_at INTEGER NOT NULL
);

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
