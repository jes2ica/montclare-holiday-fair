# Montclare Holiday Fair

Website and volunteer tools for the Montclare Children's School Holiday Fair (*Yeti, Set, Snow!*), served at `holidayfair.montclarepa.org` by the Cloudflare Pages project `montclare-holiday-fair` in the Montclare PA's Cloudflare account.

| Page | URL |
|---|---|
| Fair page | https://holidayfair.montclarepa.org/ |
| Face-painting waitlist (parents) | https://holidayfair.montclarepa.org/facepainting/ |
| Face-painting staff console (PIN) | https://holidayfair.montclarepa.org/facepainting/staff/ |

## How it is wired

- `montclarepa.org` DNS stays at GoDaddy. One record points the subdomain at Pages: `CNAME holidayfair → montclare-holiday-fair.pages.dev`, and the domain is added under the Pages project's **Custom domains**.
- The PA's own Terms and Privacy pages are at `/terms/` and `/privacy/`. The waitlist texts go through J&Z Foundation's Twilio A2P campaign, which was registered with `jz-foundation.org/terms/` and `/privacy/`, so the SMS consent checkbox keeps linking to those.
- Old `jz-foundation.org/montclareholidayfair/...` links are redirected to the matching page here.
- Data lives in the D1 database `montclare-holiday-fair`: table `fp_queue`.

## Files

- `public/` – fair page, banner and booth art, waitlist page, staff console, Terms and Privacy
- `public/_worker.js` – Pages advanced-mode worker: API under `/api/fp/*` (join, live queue, staff actions, wait estimates, optional Twilio texts); never served as a file
- `schema.sql` – waitlist table, plus the unused raffle and shop tables (safe to re-run)
- `migrations/` – one-off changes for databases created before a table changed
- `wrangler.jsonc` – Pages config: painters and minutes per child

## Deploy

First time, in the Montclare PA's Cloudflare account:

```bash
npm install
npx wrangler login
npx wrangler d1 create montclare-holiday-fair                                # put the id in wrangler.jsonc
npx wrangler d1 execute montclare-holiday-fair --remote --file=schema.sql    # tables, safe to re-run
npx wrangler pages project create montclare-holiday-fair --production-branch main
npx wrangler pages deploy
npx wrangler pages secret put STAFF_PIN                                      # PIN for the face-painting staff console
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

Raffle tickets are sold in person only, with no online ordering or payments; the fair page's raffle card opens the lobby sales schedule. The online raffle (buyer page, Square staff console, `/api/raffle/*`) was removed; to bring it back, revert the commit "Remove the online raffle" and put the live pot and **Buy raffle tickets** button back on the fair page's raffle card. Old `/raffle/` links go to the fair page. The `raffle_entries` and `raffle_draws` tables stay in the database, unused.

## Holiday shop

The online shop (cart on the fair page, Square payment links, pickup console) was removed for now. To bring it back, revert the commit "Remove the online shop for now". The `shop_orders` table stays in the database, unused.

## After the fair

- Face-painting staff console → **Delete all entries**. The SMS terms promise parents their numbers are deleted after the event.

## Local testing

```bash
npx wrangler d1 execute montclare-holiday-fair --local --file=schema.sql
echo 'STAFF_PIN=1234' > .dev.vars
npx wrangler pages dev  # http://localhost:8788/
```
