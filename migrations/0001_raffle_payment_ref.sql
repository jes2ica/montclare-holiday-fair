-- Run once on a database created before raffle entries recorded Square transaction IDs.
ALTER TABLE raffle_entries ADD COLUMN payment_ref TEXT;
