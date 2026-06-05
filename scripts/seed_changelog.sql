INSERT INTO control.changelog (title, body, kind, ship_date, is_published)
VALUES (
  'FB_OAUTH_POOL_FIX_v1',
  'Fixed "Cannot use a pool after calling end on the pool" Postgres error during Facebook reconnect. The per-tenant pool LRU cache could evict and .end() a pool that was still being used by an in-flight long-running OAuth callback (5+s of Graph API calls between DB writes). Now the LRU only evicts pools with zero active or pending clients; if all are busy it defers eviction.',
  'fix',
  CURRENT_DATE,
  1
)
ON CONFLICT DO NOTHING;
