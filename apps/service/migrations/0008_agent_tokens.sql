CREATE TABLE device_authorizations (
  device_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  machine TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'consumed')),
  poll_interval INTEGER NOT NULL,
  last_poll_ms INTEGER,
  actor_key TEXT,
  actor_name TEXT,
  capabilities TEXT,
  token_id TEXT UNIQUE,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK ((state IN ('approved', 'consumed')) = (actor_key IS NOT NULL AND actor_name IS NOT NULL AND capabilities IS NOT NULL)),
  CHECK ((state = 'consumed') = (token_id IS NOT NULL))
);
CREATE INDEX device_authorizations_pending ON device_authorizations (project_id, state, expires_at);
CREATE INDEX device_authorizations_expired ON device_authorizations (expires_at);

CREATE TABLE device_attempts (
  project_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE INDEX device_attempts_actor ON device_attempts (project_id, actor_key, at_ms);

CREATE TABLE agent_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  agent TEXT NOT NULL,
  machine TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX agent_tokens_actor ON agent_tokens (project_id, actor_key, expires_at);

ALTER TABLE messages ADD COLUMN via TEXT;
ALTER TABLE messages ADD COLUMN transition TEXT CHECK (transition IN ('resolved', 'open'));
ALTER TABLE messages ADD COLUMN commit_sha TEXT;
ALTER TABLE messages ADD COLUMN deployment_id TEXT;

CREATE TRIGGER frozen_device_authorizations_insert BEFORE INSERT ON device_authorizations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_device_authorizations_update BEFORE UPDATE ON device_authorizations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_device_authorizations_delete BEFORE DELETE ON device_authorizations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_device_attempts_insert BEFORE INSERT ON device_attempts WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_device_attempts_update BEFORE UPDATE ON device_attempts WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_device_attempts_delete BEFORE DELETE ON device_attempts WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_agent_tokens_insert BEFORE INSERT ON agent_tokens WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_agent_tokens_update BEFORE UPDATE ON agent_tokens WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_agent_tokens_delete BEFORE DELETE ON agent_tokens WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
