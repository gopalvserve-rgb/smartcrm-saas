INSERT INTO control.changelog (title, body, kind, ship_date, is_published)
VALUES (
  'SHOWCASE_SEED_FIX_v1',
  'Fixed Postgres "inconsistent types deduced for $1" error in showcase Education + Real Estate demo seeders. The receipt_no concatenation now passes the formatted string as a separate parameter instead of mixing int+text uses of $1. showcase-edu and showcase-re can now be seeded with dummy data from super-admin.',
  'fix',
  CURRENT_DATE,
  1
)
ON CONFLICT DO NOTHING;
