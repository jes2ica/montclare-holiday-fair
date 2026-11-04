# Montclare Holiday Fair

Website and volunteer tools for the Montclare Children's School Holiday Fair (*Yeti, Set, Snow!*), served at `holidayfair.montclarepa.org` by the Cloudflare Pages project `montclare-holiday-fair` in the Montclare PA's Cloudflare account.

| Page | URL |
|---|---|
| Fair page | https://holidayfair.montclarepa.org/ |
| Face-painting waitlist (parents) | https://holidayfair.montclarepa.org/facepainting/ |
| Face-painting staff console (PIN) | https://holidayfair.montclarepa.org/facepainting/staff/ |
| 50/50 raffle (buyers) | https://holidayfair.montclarepa.org/raffle/ |
| Raffle staff console (PIN) | https://holidayfair.montclarepa.org/raffle/staff/ |
| Holiday shop cart and orders (buyers) | https://holidayfair.montclarepa.org/shop/ |
| Shop pickup console (PIN) | https://holidayfair.montclarepa.org/shop/staff/ |

## How it is wired

- `montclarepa.org` DNS stays at GoDaddy. One record points the subdomain at Pages: `CNAME holidayfair → montclare-holiday-fair.pages.dev`, and the domain is added under the Pages project's **Custom domains**.
- The PA's own Terms and Privacy pages are at `/terms/` and `/privacy/`. The waitlist texts go through J&Z Foundation's Twilio A2P campaign, which was registered with `jz-foundation.org/terms/` and `/privacy/`, so the SMS consent checkbox keeps linking to those.
- Old `jz-foundation.org/montclareholidayfair/...` links are redirected to the matching page here.
- Data lives in the D1 database `montclare-holiday-fair`: tables `fp_queue`, `raffle_entries` and `raffle_draws`.

## Files

- `public/` – fair page, banner and booth art, waitlist, raffle and shop pages, staff consoles, Terms and Privacy
- `public/shop/items.json` – the online shop's catalog (items, prices, stock, open or closed)
- `public/_worker.js` – Pages advanced-mode worker: API under `/api/fp/*` (join, live queue, staff actions, wait estimates, optional Twilio texts) `/api/raffle/*` (orders, staff payments, drawing) and `/api/shop/*` (catalog, Square checkout, pickup); never served as a file
- `schema.sql` – waitlist and raffle tables (safe to re-run)
- `migrations/` – one-off changes for databases created before a table changed
- `wrangler.jsonc` – Pages config: painters, minutes per child, raffle bundles, Square app settings

## Deploy

First time, in the Montclare PA's Cloudflare account:

```bash
npm install
npx wrangler login
npx wrangler d1 create montclare-holiday-fair                                # put the id in wrangler.jsonc
npx wrangler d1 execute montclare-holiday-fair --remote --file=schema.sql    # tables, safe to re-run
npx wrangler pages project create montclare-holiday-fair --production-branch main
npx wrangler pages deploy
npx wrangler pages secret put STAFF_PIN                                      # PIN for both staff consoles
```

After that, `npx wrangler pages deploy` publishes changes. Secrets apply to the next deploy, so deploy again after changing one.

## Face-painting waitlist

Parents join on their phone and get a ticket number; staff text them when it's their turn.

Turn on texting after the Twilio A2P campaign is approved:

```bash
npx wrangler pages secret put TWILIO_ACCOUNT_SID
npx wrangler pages secret put TWILIO_AUTH_TOKEN
npx wrangler pages secret put TWILIO_MESSAGING_SERVICE_SID   # the Messaging Service tied to the approved campaign
```

Then run `npx wrangler pages deploy`. Until these are set, "Text: turn ready" only marks the child as called, and the staff console shows a reminder to call the number out loud.

On the day:

- Station tablet: open the staff console, enter the PIN.
- Post a QR code to the waitlist URL at the station.
- Flow per child: **Text: turn ready** → **Start** (child sits down) → **Done**.
- More than one painter? Change `PAINTERS` in `wrangler.jsonc` and run `npx wrangler pages deploy`.

## 50/50 raffle

Buyers pick a bundle on their phone and get a code like `YETI-4821`. At the raffle table a volunteer finds the code on the staff console (opened on the phone or iPad with the Square Point of Sale app) and taps **Charge on Square**: the Square app opens with the amount, the buyer taps their card, and Square returns to the staff console, which marks the order paid and saves the Square transaction ID. **Cash** marks it paid by hand. Paying assigns consecutive ticket numbers that appear on the buyer's phone. Buyers who didn't order on a phone can be recorded directly with **Record a sale**. **Draw winner** picks one paid ticket at random (voided tickets can't win) and closes sales. Buyers never get texts: the Twilio campaign covers the face-painting waitlist only.

Square uses the Point of Sale API of the school's app at developer.squareup.com. `SQUARE_APP_ID` (the production Application ID, a public value) and `SQUARE_CALLBACK_URL` live under `vars` in `wrangler.jsonc`; the callback must match the Web callback URL saved in that app's Point of Sale API settings exactly.

Ticket bundles: `RAFFLE_PRICES` under `vars`, as `qty:dollars` pairs, e.g. `1:5,5:20,15:50` (then `npx wrangler pages deploy`).

A database created before raffle orders stored Square transaction IDs needs this once:

```bash
npx wrangler d1 execute montclare-holiday-fair --remote --file=migrations/0001_raffle_payment_ref.sql
```

## Holiday shop

Families add Swag and Bracelets & Giveaways items to a cart on the fair page, then pay on `/shop/` through a Square payment link (Checkout API). Each order gets a pickup code like `SNOW-4821`. When the buyer returns from Square, or whenever the pickup console refreshes, the site asks Square whether the order was paid. There's no webhook to set up.

Turn it on with the PA's production access token (developer.squareup.com → the app → Credentials → Production):

```bash
CLOUDFLARE_ACCOUNT_ID=0ca3057b0381d0117295beb8b28506db npx wrangler pages secret put SQUARE_ACCESS_TOKEN --project-name montclare-holiday-fair
npm run deploy
```

Payments go to the account's first active location, or set `SQUARE_LOCATION_ID` under `vars`. For testing against Square's sandbox, set `SQUARE_ENV` to `sandbox` and use a sandbox token.

The catalog is `public/shop/items.json`; edit it and run `npm run deploy`:

```json
{
  "open": true,
  "pickup": "Pick up your order at the Holiday Marketplace on Saturday, December 5. Show your order code.",
  "items": [
    { "id": "tote", "booth": "swag", "name": "Holiday Fair tote", "price": 12, "stock": 20 },
    { "id": "bracelet", "booth": "bracelets", "name": "Snowflake bracelet", "price": 3, "note": "Glow-in-the-dark" }
  ]
}
```

- `booth` is `swag` or `bracelets`, the tile the item is listed under. `id` must never change once orders exist.
- `stock` is optional. Paid orders count against it, and so do unpaid ones for 30 minutes while the buyer is on Square's page. `"sold_out": true` stops sales of one item.
- `"open": false` closes online sales; items then show as "At the fair".
- Prices and stock are checked on the server, so editing the page in a browser can't change what Square charges.

`npm run preview` deploys to https://preview.montclare-holiday-fair.pages.dev with the dummy catalog in `public/shop/items.demo.json` and checkout turned off, for trying the shop without touching the real site.

A database created before the shop existed needs this once:

```bash
npx wrangler d1 execute montclare-holiday-fair --remote --file=migrations/0002_shop_orders.sql
```

## After the fair

- Face-painting staff console → **Delete all entries**. The SMS terms promise parents their numbers are deleted after the event.
- Raffle staff console → **Delete all raffle entries**, after the prize is paid out and the totals are recorded.
- Shop pickup console → **Delete all shop orders**, once everything is picked up. Square keeps its own records.

## Local testing

```bash
npx wrangler d1 execute montclare-holiday-fair --local --file=schema.sql
echo 'STAFF_PIN=1234' > .dev.vars
npx wrangler pages dev  # http://localhost:8788/
```
