// Montclare Holiday Fair: fair pages, and face-painting waitlist API.
// Runs as the Cloudflare Pages advanced-mode worker; static pages come from ./public.

const ACTIVE = ['painting', 'called', 'waiting'];
const STAFF_STATUSES = ['waiting', 'called', 'painting', 'done', 'no_show'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Links from when the fair lived at jz-foundation.org/montclareholidayfair/.
    if (url.pathname === '/montclareholidayfair' || url.pathname.startsWith('/montclareholidayfair/')) {
      url.pathname = url.pathname.slice('/montclareholidayfair'.length) || '/';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith('/api/fp/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
      }
    }
    // The online shop and online raffle are off; send old /shop/ and /raffle/ links to the fair page.
    if (/^\/(shop|raffle)(\/|$)/.test(url.pathname)) {
      return Response.redirect(new URL('/', url).toString(), 302);
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
    if (!env.STAFF_PIN) return json({ error: 'Staff PIN is not set up. Run: npx wrangler pages secret put STAFF_PIN' }, 503);
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
  const child = clean(body.child_name ?? body.child_first_name, 80);
  const mobile = normalizePhone(body.mobile);
  if (!parent) return json({ error: 'Enter your name.' }, 400);
  if (!child) return json({ error: "Enter your child's full name." }, 400);
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
