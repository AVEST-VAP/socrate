CREATE TABLE reviews (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key)
);

CREATE TABLE revisions (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, revision_id),
  FOREIGN KEY (project_id, review_key) REFERENCES reviews (project_id, review_key)
);

CREATE TABLE deployments (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  build_id TEXT NOT NULL,
  url TEXT NOT NULL,
  origin TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, deployment_id),
  FOREIGN KEY (project_id, review_key, revision_id) REFERENCES revisions (project_id, review_key, revision_id)
);
CREATE INDEX deployments_origin ON deployments (project_id, origin);

CREATE TABLE threads (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('global')),
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
CREATE INDEX threads_review_created ON threads (project_id, review_key, created_at, thread_id);

CREATE TABLE messages (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  author_key TEXT NOT NULL,
  author_name TEXT NOT NULL,
  exploring TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, thread_id, message_id),
  UNIQUE (project_id, review_key, thread_id, seq),
  FOREIGN KEY (project_id, review_key, thread_id) REFERENCES threads (project_id, review_key, thread_id)
);

CREATE TABLE operations (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, actor_key, kind, idempotency_key)
);

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX changes_review ON changes (project_id, review_key, seq);

CREATE TABLE consumed_assertions (
  issuer TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, jti)
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  exploring TEXT,
  capabilities TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE technical_credentials (
  credential_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
