CREATE TABLE attachments (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('thread.create', 'thread.targeted', 'message.create')),
  idempotency_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  payload_digest TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm')),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= CASE WHEN content_type LIKE 'video/%' THEN 52428800 ELSE 10485760 END),
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'attached')),
  uploaded INTEGER NOT NULL DEFAULT 0 CHECK (uploaded IN (0, 1)),
  thread_id TEXT,
  message_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, attachment_id),
  UNIQUE (project_id, review_key, actor_key, operation, idempotency_key, position),
  CHECK ((state = 'attached') = (message_id IS NOT NULL AND thread_id IS NOT NULL AND uploaded = 1)),
  FOREIGN KEY (project_id, review_key, thread_id, message_id) REFERENCES messages (project_id, review_key, thread_id, message_id)
);
CREATE INDEX attachments_message ON attachments (project_id, review_key, thread_id, message_id, position);
CREATE INDEX attachments_expired ON attachments (state, expires_at);
CREATE TRIGGER frozen_attachments_insert BEFORE INSERT ON attachments WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_attachments_update BEFORE UPDATE ON attachments WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_attachments_delete BEFORE DELETE ON attachments WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
