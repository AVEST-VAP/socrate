PRAGMA defer_foreign_keys = true;

CREATE TABLE threads_v2 (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('global', 'targeted')),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  version INTEGER NOT NULL DEFAULT 0,
  revision_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  author_key TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, thread_id),
  FOREIGN KEY (project_id, review_key, deployment_id) REFERENCES deployments (project_id, review_key, deployment_id)
);

INSERT INTO threads_v2 SELECT project_id, review_key, thread_id, kind, state, version, revision_id, deployment_id, author_key, author_name, created_at, updated_at FROM threads;

DROP TABLE threads;

ALTER TABLE threads_v2 RENAME TO threads;

CREATE INDEX threads_review_created ON threads (project_id, review_key, created_at, thread_id);

CREATE TABLE captures (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempt TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'reclaiming')),
  uploaded INTEGER NOT NULL DEFAULT 0 CHECK (uploaded IN (0, 1)),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  thread_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, capture_id),
  UNIQUE (project_id, review_key, actor_key, idempotency_key)
);
CREATE INDEX captures_expired ON captures (state, expires_at);
CREATE UNIQUE INDEX captures_thread ON captures (project_id, review_key, thread_id) WHERE thread_id IS NOT NULL;

CREATE TABLE targets (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  context TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, thread_id),
  FOREIGN KEY (project_id, review_key, thread_id) REFERENCES threads (project_id, review_key, thread_id),
  FOREIGN KEY (project_id, review_key, capture_id) REFERENCES captures (project_id, review_key, capture_id)
);

PRAGMA defer_foreign_keys = false
