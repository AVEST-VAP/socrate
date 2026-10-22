CREATE TABLE sync_epoch (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch TEXT NOT NULL
);
INSERT INTO sync_epoch (singleton, epoch) VALUES (1, lower(hex(randomblob(16))));

CREATE TABLE listings (
  listing_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  filter TEXT NOT NULL,
  epoch TEXT NOT NULL,
  ceiling INTEGER NOT NULL,
  total INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX listings_expired ON listings (expires_at);

CREATE TABLE listing_items (
  listing_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (listing_id, position)
);
