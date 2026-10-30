# Montclare Holiday Fair

Website and volunteer tools for the Montclare Children's School Holiday Fair (*Yeti, Set, Snow!*), served at `jz-foundation.org/montclareholidayfair/` by the Cloudflare Worker `montclare-holiday-fair`.

| Page | URL |
|---|---|
| Fair page | https://jz-foundation.org/montclareholidayfair/ |
| Face-painting waitlist (parents) | https://jz-foundation.org/montclareholidayfair/facepainting/ |
| Face-painting staff console (PIN) | https://jz-foundation.org/montclareholidayfair/facepainting/staff/ |
| 50/50 raffle (buyers) | https://jz-foundation.org/montclareholidayfair/raffle/ |
| Raffle staff console (PIN) | https://jz-foundation.org/montclareholidayfair/raffle/staff/ |

## How it is wired

- `jz-foundation.org` is served by the J&Z Foundation Worker (`curly-math-cec3`, a separate project). It forwards `/montclareholidayfair/*`, `/api/fp/*` and `/api/raffle/*` to this Worker through a service binding, so every URL above stays on `jz-foundation.org`. This Worker has no public URL of its own (`workers_dev` is off).
- The Terms and Privacy pages linked from the fair pages (`/terms/`, `/privacy/`) live on the foundation site.
- Both Workers share the Cloudflare D1 database `jz-foundation`. This project owns the `fp_queue`, `raffle_entries` and `raffle_draws` tables.

## Files

- `public/montclareholidayfair/` – fair page, banner and booth art, waitlist and raffle pages, staff consoles
- `src/index.js` – API under `/api/fp/*` (join, live queue, staff actions, wait estimates, optional Twilio texts) and `/api/raffle/*` (orders, staff payments, drawing)
- `schema.sql` – waitlist and raffle tables (safe to re-run)
- `migrations/` – one-off changes for databases created before a table changed
- `wrangler.jsonc` – Worker config: painters, minutes per child, raffle bundles, Square app settings

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 execute jz-foundation --remote --file=schema.sql   # tables, safe to re-run
npx wrangler secret put STAFF_PIN                                  # PIN for both staff consoles
npx wrangler deploy
```

Deploy this Worker before the foundation Worker that binds to it.

## Face-painting waitlist

Parents join on their phone and get a ticket number; staff text them when it's their turn.

Turn on texting after the Twilio A2P campaign is approved:

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_MESSAGING_SERVICE_SID   # the Messaging Service tied to the approved campaign
```

No redeploy needed. Until these are set, "Text: turn ready" only marks the child as called, and the staff console shows a reminder to call the number out loud.

On the day:

- Station tablet: open the staff console, enter the PIN.
- Post a QR code to the waitlist URL at the station.
- Flow per child: **Text: turn ready** → **Start** (child sits down) → **Done**.
- More than one painter? Change `PAINTERS` in `wrangler.jsonc` and run `npx wrangler deploy`.

## 50/50 raffle

Buyers pick a bundle on their phone and get a code like `YETI-4821`. At the raffle table a volunteer finds the code on the staff console (opened on the phone or iPad with the Square Point of Sale app) and taps **Charge on Square**: the Square app opens with the amount, the buyer taps their card, and Square returns to the staff console, which marks the order paid and saves the Square transaction ID. **Cash** marks it paid by hand. Paying assigns consecutive ticket numbers that appear on the buyer's phone. Buyers who didn't order on a phone can be recorded directly with **Record a sale**. **Draw winner** picks one paid ticket at random (voided tickets can't win) and closes sales. Buyers never get texts: the Twilio campaign covers the face-painting waitlist only.

Square uses the Point of Sale API of the school's app at developer.squareup.com. `SQUARE_APP_ID` (the production Application ID, a public value) and `SQUARE_CALLBACK_URL` live under `vars` in `wrangler.jsonc`; the callback must match the Web callback URL saved in that app's Point of Sale API settings exactly.

Ticket bundles: `RAFFLE_PRICES` under `vars`, as `qty:dollars` pairs, e.g. `1:5,5:20,15:50` (then `npx wrangler deploy`).

A database created before raffle orders stored Square transaction IDs needs this once:

```bash
npx wrangler d1 execute jz-foundation --remote --file=migrations/0001_raffle_payment_ref.sql
```

## After the fair

- Face-painting staff console → **Delete all entries**. The SMS terms promise parents their numbers are deleted after the event.
- Raffle staff console → **Delete all raffle entries**, after the prize is paid out and the totals are recorded.

## Local testing

```bash
npx wrangler d1 execute jz-foundation --local --file=schema.sql
echo 'STAFF_PIN=1234' > .dev.vars
npx wrangler dev        # http://localhost:8787/montclareholidayfair/
```
