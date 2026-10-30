// Montclare Holiday Fair: fair pages, face-painting waitlist API, and 50/50 raffle API.
// Static pages come from ./public. jz-foundation.org forwards /montclareholidayfair/*,
// /api/fp/* and /api/raffle/* here through a service binding.

const ACTIVE = ['painting', 'called', 'waiting'];
const STAFF_STATUSES = ['waiting', 'called', 'painting', 'done', 'no_show'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/fp/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
      }
    }
    if (url.pathname.startsWith('/api/raffle/')) {
      try {
        return await handleRaffle(request, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/fp/queue' && method === 'GET') {
    return json(await publicQueue(env));
  }
  if (path === '/api/fp/join' && method === 'POST') {
    return join(request, env);
  }

  if (path.startsWith('/api/fp/staff/')) {
    if (!env.STAFF_PIN) return json({ error: 'Staff PIN is not set up. Run: npx wrangler secret put STAFF_PIN' }, 503);
    if (request.headers.get('x-staff-pin') !== env.STAFF_PIN) return json({ error: 'Wrong PIN.' }, 401);

    if (path === '/api/fp/staff/queue' && method === 'GET') return json(await staffQueue(env));
    if (path === '/api/fp/staff/status' && method === 'POST') return setStatus(request, env);
    if (path === '/api/fp/staff/text' && method === 'POST') return textAgain(request, env);
    if (path === '/api/fp/staff/clear' && method === 'POST') {
      await env.DB.prepare('DELETE FROM fp_queue').run();
      return json(await staffQueue(env));
    }
  }
  return json({ error: 'Not found' }, 404);
}

// ---------- estimates ----------

function config(env) {
  const painters = Math.max(1, parseInt(env.PAINTERS, 10) || 1);
  const minutes = Math.max(1, parseInt(env.MINUTES_PER_CHILD, 10) || 10);
  return { painters, minutes };
}

// Simulates the line: each painter frees up when their current child finishes,
// then each waiting child (in order) takes the next free painter for `minutes`.
function withEstimates(rows, env, now) {
  const { painters, minutes } = config(env);
  const per = minutes * 60000;
  const slots = rows
    .filter((r) => r.status === 'painting')
    .map((r) => Math.max(0, per - (now - (r.started_at || now))));
  while (slots.length < painters) slots.push(0);
  slots.sort((a, b) => a - b);

  let ahead = 0;
  const items = rows.map((r) => {
    if (r.status === 'painting') {
      return { ...r, est_min: Math.ceil(Math.max(0, per - (now - (r.started_at || now))) / 60000), ahead: null };
    }
    let i = 0;
    for (let k = 1; k < slots.length; k++) if (slots[k] < slots[i]) i = k;
    const est = Math.ceil(slots[i] / 60000);
    slots[i] += per;
    return { ...r, est_min: est, ahead: ahead++ };
  });
  const joinNow = Math.ceil(Math.min(...slots) / 60000);
  return { items, join_now_min: joinNow, painters, minutes };
}

async function activeRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM fp_queue WHERE status IN ('painting','called','waiting')
     ORDER BY CASE status WHEN 'painting' THEN 0 WHEN 'called' THEN 1 ELSE 2 END,
              COALESCE(called_at, 0), id`
  ).all();
  return results || [];
}

async function publicQueue(env) {
  const now = Date.now();
  const est = withEstimates(await activeRows(env), env, now);
  return {
    now,
    painters: est.painters,
    minutes_per_child: est.minutes,
    join_now_min: est.join_now_min,
    // Public board shows only ticket number and the child's first initial.
    items: est.items.map((r) => ({
      ticket: r.id,
      child: initial(r.child_name),
      status: r.status,
      est_min: r.est_min,
      ahead: r.ahead,
    })),
  };
}

async function staffQueue(env) {
  const now = Date.now();
  const est = withEstimates(await activeRows(env), env, now);
  const { results: finished } = await env.DB.prepare(
    `SELECT * FROM fp_queue WHERE status IN ('done','no_show') ORDER BY finished_at DESC LIMIT 50`
  ).all();
  const shape = (r) => ({
    ticket: r.id,
    parent: r.parent_name,
    child: r.child_name,
    phone_last4: r.mobile.slice(-4),
    status: r.status,
    est_min: r.est_min ?? null,
    texted: !!r.texted_at,
    created_at: r.created_at,
    started_at: r.started_at,
  });
  const { results: [{ n }] } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM fp_queue WHERE status = 'done'`).all();
  return {
    now,
    painters: est.painters,
    minutes_per_child: est.minutes,
    join_now_min: est.join_now_min,
    texting_ready: textingReady(env),
    done_count: n,
    active: est.items.map(shape),
    finished: (finished || []).map(shape),
  };
}

function initial(name) {
  const c = (name || '').trim().charAt(0).toUpperCase();
  return c ? c + '.' : '';
}

// ---------- join ----------

async function join(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Could not read the form. Please try again.' }, 400); }

  const parent = clean(body.parent_name, 80);
  const child = clean(body.child_first_name, 40);
  const mobile = normalizePhone(body.mobile);
  if (!parent) return json({ error: 'Enter your name.' }, 400);
  if (!child) return json({ error: "Enter your child's first name." }, 400);
  if (!mobile) return json({ error: 'Enter a 10-digit US mobile number.' }, 400);
  if (body.sms_consent !== true) return json({ error: 'Check the box to agree to receive the text alert.' }, 400);

  // Same phone + same child already in line: return that ticket instead of a duplicate.
  const existing = await env.DB.prepare(
    `SELECT id FROM fp_queue WHERE mobile = ? AND lower(child_name) = lower(?) AND status IN ('waiting','called','painting')`
  ).bind(mobile, child).first();

  let ticket = existing && existing.id;
  if (!ticket) {
    const now = Date.now();
    const row = await env.DB.prepare(
      `INSERT INTO fp_queue (parent_name, child_name, mobile, consent_at, status, created_at)
       VALUES (?, ?, ?, ?, 'waiting', ?) RETURNING id`
    ).bind(parent, child, mobile, now, now).first();
    ticket = row.id;
  }
  const queue = await publicQueue(env);
  const mine = queue.items.find((i) => i.ticket === ticket);
  return json({ ticket, child, already: !!existing, est_min: mine ? mine.est_min : 0, ahead: mine ? mine.ahead : 0, queue });
}

function clean(v, max) {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return /^[2-9]\d{9}$/.test(d) ? '+1' + d : null;
}

// ---------- staff actions ----------

async function setStatus(request, env) {
  const { ticket, status } = await request.json().catch(() => ({}));
  if (!Number.isInteger(ticket) || !STAFF_STATUSES.includes(status)) return json({ error: 'Bad request.' }, 400);
  const row = await env.DB.prepare('SELECT * FROM fp_queue WHERE id = ?').bind(ticket).first();
  if (!row) return json({ error: `Ticket ${ticket} not found.` }, 404);

  const now = Date.now();
  const sets = { status };
  if (status === 'called') sets.called_at = now;
  if (status === 'painting') sets.started_at = now;
  if (status === 'done' || status === 'no_show') sets.finished_at = now;
  if (status === 'waiting') { sets.called_at = null; sets.started_at = null; sets.finished_at = null; }

  const keys = Object.keys(sets);
  await env.DB.prepare(`UPDATE fp_queue SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => sets[k]), ticket).run();

  let text = null;
  if (status === 'called') text = await sendTurnText(env, row);
  return json({ ...(await staffQueue(env)), text });
}

async function textAgain(request, env) {
  const { ticket } = await request.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT * FROM fp_queue WHERE id = ?').bind(ticket).first();
  if (!row) return json({ error: 'Ticket not found.' }, 404);
  const text = await sendTurnText(env, row);
  return json({ ...(await staffQueue(env)), text });
}

// ---------- texting (Twilio, optional) ----------

function textingReady(env) {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM));
}

async function sendTurnText(env, row) {
  if (!textingReady(env)) return { sent: false, reason: 'Texting is not set up yet, so no text was sent. Call the ticket number out loud.' };
  const body = `Montclare Holiday Fair: ${row.child_name}'s face-painting turn at the Montclare Holiday Fair is ready! Please come to the station within 5 min. Reply STOP to opt out.`;
  const params = new URLSearchParams({ To: row.mobile, Body: body });
  if (env.TWILIO_MESSAGING_SERVICE_SID) params.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
  else params.set('From', env.TWILIO_FROM);

  const sid = env.TWILIO_ACCOUNT_SID;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${sid}:${env.TWILIO_AUTH_TOKEN}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    return { sent: false, reason: `Text failed (${detail.message || 'Twilio error ' + res.status}).` };
  }
  await env.DB.prepare('UPDATE fp_queue SET texted_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return { sent: true };
}

// ---------- 50/50 raffle ----------

// Paid at the raffle table: card through the school's Square, or cash.
const RAFFLE_METHODS = ['square', 'cash'];

// RAFFLE_PRICES is "qty:dollars" pairs, e.g. "1:5,5:20" = 1 ticket for $5, 5 tickets for $20.
function raffleConfig(env) {
  const prices = String(env.RAFFLE_PRICES || '1:5,5:20').split(',')
    .map((p) => p.split(':').map((n) => parseInt(n, 10)))
    .filter(([q, d]) => q > 0 && d > 0)
    .map(([qty, amount]) => ({ qty, amount }));
  return { prices };
}

async function handleRaffle(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/raffle/info' && method === 'GET') return json(await raffleInfo(env));
  if (path === '/api/raffle/buy' && method === 'POST') return raffleBuy(request, env);
  if (path === '/api/raffle/entry' && method === 'GET') return raffleEntry(env, url.searchParams.get('token'));

  if (path.startsWith('/api/raffle/staff/')) {
    if (!env.STAFF_PIN) return json({ error: 'Staff PIN is not set up. Run: npx wrangler secret put STAFF_PIN' }, 503);
    if (request.headers.get('x-staff-pin') !== env.STAFF_PIN) return json({ error: 'Wrong PIN.' }, 401);
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (path === '/api/raffle/staff/list' && method === 'GET') return json(await raffleStaff(env));
    if (path === '/api/raffle/staff/paid' && method === 'POST') return raffleMarkPaid(env, body.id, body.method, clean(body.payment_ref, 120));
    if (path === '/api/raffle/staff/reserve' && method === 'POST') return raffleReserve(env, body);
    if (path === '/api/raffle/staff/cash' && method === 'POST') return raffleCash(env, body);
    if (path === '/api/raffle/staff/cancel' && method === 'POST') return raffleSetStatus(env, body.id, 'pending', 'canceled');
    if (path === '/api/raffle/staff/void' && method === 'POST') return raffleSetStatus(env, body.id, 'paid', 'void');
    if (path === '/api/raffle/staff/draw' && method === 'POST') return raffleDraw(env);
    if (path === '/api/raffle/staff/undraw' && method === 'POST') {
      await env.DB.prepare('DELETE FROM raffle_draws').run();
      return json(await raffleStaff(env));
    }
    if (path === '/api/raffle/staff/clear' && method === 'POST') {
      await env.DB.batch([env.DB.prepare('DELETE FROM raffle_draws'), env.DB.prepare('DELETE FROM raffle_entries')]);
      return json(await raffleStaff(env));
    }
  }
  return json({ error: 'Not found' }, 404);
}

async function raffleTotals(env) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS pot, COALESCE(SUM(qty), 0) AS tickets FROM raffle_entries WHERE status = 'paid'`
  ).first();
  const winner = await env.DB.prepare('SELECT ticket, entry_id, drawn_at FROM raffle_draws ORDER BY id DESC LIMIT 1').first();
  return { pot: row.pot, prize: row.pot / 2, tickets: row.tickets, winner };
}

async function raffleInfo(env) {
  const cfg = raffleConfig(env);
  const t = await raffleTotals(env);
  return {
    ...cfg,
    pot: t.pot, prize: t.prize, tickets_sold: t.tickets,
    // Sales close once a winner is drawn. Public view shows only the ticket number.
    open: !t.winner,
    winner: t.winner ? { ticket: t.winner.ticket, drawn_at: t.winner.drawn_at } : null,
  };
}

// Short code that is easy to type into a payment note. Not secret: the buyer's token is.
function raffleCode() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return 'YETI-' + String(1000 + (n[0] % 9000));
}

async function raffleCreate(env, { name, contact, qty }) {
  const price = raffleConfig(env).prices.find((p) => p.qty === qty);
  if (!name) return { error: 'Enter your name.' };
  if (!price) return { error: 'Choose how many tickets.' };
  const token = crypto.randomUUID();
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const code = raffleCode();
    const row = await env.DB.prepare(
      `INSERT INTO raffle_entries (token, code, name, contact, qty, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`
    ).bind(token, code, name, contact || null, price.qty, price.amount, now).first();
    if (row) return { row };
  }
  return { error: 'Could not make a code. Please try again.' };
}

async function raffleBuy(request, env) {
  const body = await request.json().catch(() => ({}));
  const t = await raffleTotals(env);
  if (t.winner) return json({ error: 'Ticket sales are closed: the winner has been drawn.' }, 409);
  const res = await raffleCreate(env, { name: clean(body.name, 80), contact: clean(body.contact, 80), qty: body.qty });
  if (res.error) return json({ error: res.error }, 400);
  return json(raffleBuyerView(res.row, t.winner));
}

function raffleBuyerView(r, winner) {
  return {
    token: r.token, code: r.code, name: r.name, qty: r.qty, amount: r.amount, status: r.status,
    first_ticket: r.first_ticket, last_ticket: r.last_ticket,
    won: !!(winner && r.status === 'paid' && winner.entry_id === r.id),
  };
}

async function raffleEntry(env, token) {
  if (!token) return json({ error: 'Missing token.' }, 400);
  const row = await env.DB.prepare('SELECT * FROM raffle_entries WHERE token = ?').bind(token).first();
  if (!row) return json({ error: 'Not found.' }, 404);
  const t = await raffleTotals(env);
  return json(raffleBuyerView(row, t.winner));
}

async function raffleStaff(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, code, name, contact, qty, amount, status, method, payment_ref, first_ticket, last_ticket, created_at, paid_at
     FROM raffle_entries ORDER BY id DESC`
  ).all();
  const t = await raffleTotals(env);
  let winner = null;
  if (t.winner) {
    const e = (results || []).find((r) => r.id === t.winner.entry_id);
    winner = { ticket: t.winner.ticket, drawn_at: t.winner.drawn_at, name: e ? e.name : '', contact: e ? e.contact : '', code: e ? e.code : '' };
  }
  const { results: [{ n }] } = await env.DB.prepare('SELECT COUNT(*) AS n FROM raffle_draws').all();
  // Square Point of Sale API settings for the staff page's "Charge on Square" button (both are public values).
  const square = env.SQUARE_APP_ID ? { app_id: env.SQUARE_APP_ID, callback_url: env.SQUARE_CALLBACK_URL } : null;
  return { ...raffleConfig(env), square, pot: t.pot, prize: t.prize, tickets_sold: t.tickets, winner, draws: n, entries: results || [] };
}

// Assigns the next block of ticket numbers in the same statement that marks the entry paid,
// so two volunteers marking at once can't get overlapping numbers.
async function raffleMarkPaid(env, id, method, paymentRef) {
  if (!Number.isInteger(id) || !RAFFLE_METHODS.includes(method)) return json({ error: 'Bad request.' }, 400);
  const res = await env.DB.prepare(
    `UPDATE raffle_entries SET status = 'paid', method = ?, payment_ref = ?, paid_at = ?,
       first_ticket = (SELECT COALESCE(MAX(last_ticket), 0) + 1 FROM raffle_entries),
       last_ticket  = (SELECT COALESCE(MAX(last_ticket), 0) FROM raffle_entries) + qty
     WHERE id = ? AND status = 'pending'`
  ).bind(method, paymentRef || null, Date.now(), id).run();
  if (!res.meta.changes) return json({ error: 'That code is not waiting for payment (already paid or canceled?).' }, 409);
  return json(await raffleStaff(env));
}

async function raffleCash(env, body) {
  const res = await raffleCreate(env, { name: clean(body.name, 80), contact: clean(body.contact, 80), qty: body.qty });
  if (res.error) return json({ error: res.error }, 400);
  return raffleMarkPaid(env, res.row.id, RAFFLE_METHODS.includes(body.method) ? body.method : 'cash');
}

// A sale at the table that will be charged on Square: create the order now, mark it paid when Square returns.
async function raffleReserve(env, body) {
  const res = await raffleCreate(env, { name: clean(body.name, 80), contact: clean(body.contact, 80), qty: body.qty });
  if (res.error) return json({ error: res.error }, 400);
  return json({ ...(await raffleStaff(env)), reserved: res.row.id });
}

async function raffleSetStatus(env, id, from, to) {
  if (!Number.isInteger(id)) return json({ error: 'Bad request.' }, 400);
  const res = await env.DB.prepare('UPDATE raffle_entries SET status = ? WHERE id = ? AND status = ?').bind(to, id, from).run();
  if (!res.meta.changes) return json({ error: 'That entry has changed. Refresh and try again.' }, 409);
  return json(await raffleStaff(env));
}

// Every paid ticket has the same chance. Void tickets keep their numbers but can't win.
async function raffleDraw(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, qty, first_ticket FROM raffle_entries WHERE status = 'paid' ORDER BY first_ticket`
  ).all();
  const total = (results || []).reduce((s, r) => s + r.qty, 0);
  if (!total) return json({ error: 'No paid tickets yet.' }, 400);
  const buf = new Uint32Array(1);
  let pick;
  do { crypto.getRandomValues(buf); pick = buf[0]; } while (pick >= 2 ** 32 - (2 ** 32 % total)); // avoid modulo bias
  pick %= total;
  for (const r of results) {
    if (pick < r.qty) {
      await env.DB.prepare('INSERT INTO raffle_draws (ticket, entry_id, drawn_at) VALUES (?, ?, ?)')
        .bind(r.first_ticket + pick, r.id, Date.now()).run();
      break;
    }
    pick -= r.qty;
  }
  return json(await raffleStaff(env));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
