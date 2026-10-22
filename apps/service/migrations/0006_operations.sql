PRAGMA defer_foreign_keys = true;

CREATE TABLE reviews_v2 (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'purging', 'purged')),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  purge_after TEXT,
  purge_run TEXT,
  purged_at TEXT,
  PRIMARY KEY (project_id, review_key),
  CHECK ((state = 'active') = (archived_at IS NULL)),
  CHECK ((state IN ('purging', 'purged')) = (purge_run IS NOT NULL))
);

INSERT INTO reviews_v2 (project_id, review_key, state, created_at) SELECT project_id, review_key, state, created_at FROM reviews;

DROP TABLE reviews;

ALTER TABLE reviews_v2 RENAME TO reviews;

CREATE INDEX reviews_purge ON reviews (state, purge_after);

PRAGMA defer_foreign_keys = false;

CREATE TABLE purge_objects (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  object_key TEXT NOT NULL,
  PRIMARY KEY (project_id, review_key, object_key)
);

CREATE TABLE purge_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('deleted', 'kept', 'waiting', 'purged')),
  resource TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX purge_log_review ON purge_log (project_id, review_key, seq);

CREATE TABLE restorations (
  manifest_sha256 TEXT NOT NULL PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'complete')),
  started_at TEXT NOT NULL,
  restored_at TEXT,
  backup_created_at TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  CHECK ((state = 'complete') = (restored_at IS NOT NULL))
);

CREATE TABLE maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  frozen INTEGER NOT NULL CHECK (frozen IN (0, 1)),
  reason TEXT,
  since TEXT
);
INSERT INTO maintenance (singleton, frozen) VALUES (1, 0);

CREATE TRIGGER frozen_reviews_insert BEFORE INSERT ON reviews WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_reviews_update BEFORE UPDATE ON reviews WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_reviews_delete BEFORE DELETE ON reviews WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_revisions_insert BEFORE INSERT ON revisions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_revisions_update BEFORE UPDATE ON revisions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_revisions_delete BEFORE DELETE ON revisions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_deployments_insert BEFORE INSERT ON deployments WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_deployments_update BEFORE UPDATE ON deployments WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_deployments_delete BEFORE DELETE ON deployments WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_threads_insert BEFORE INSERT ON threads WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_threads_update BEFORE UPDATE ON threads WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_threads_delete BEFORE DELETE ON threads WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_messages_insert BEFORE INSERT ON messages WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_messages_update BEFORE UPDATE ON messages WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_messages_delete BEFORE DELETE ON messages WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_operations_insert BEFORE INSERT ON operations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_operations_update BEFORE UPDATE ON operations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_operations_delete BEFORE DELETE ON operations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_changes_insert BEFORE INSERT ON changes WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_changes_update BEFORE UPDATE ON changes WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_changes_delete BEFORE DELETE ON changes WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_consumed_assertions_insert BEFORE INSERT ON consumed_assertions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_consumed_assertions_update BEFORE UPDATE ON consumed_assertions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_consumed_assertions_delete BEFORE DELETE ON consumed_assertions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_sessions_insert BEFORE INSERT ON sessions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_sessions_update BEFORE UPDATE ON sessions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_sessions_delete BEFORE DELETE ON sessions WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_technical_credentials_insert BEFORE INSERT ON technical_credentials WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_technical_credentials_update BEFORE UPDATE ON technical_credentials WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_technical_credentials_delete BEFORE DELETE ON technical_credentials WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_captures_insert BEFORE INSERT ON captures WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_captures_update BEFORE UPDATE ON captures WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_captures_delete BEFORE DELETE ON captures WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_targets_insert BEFORE INSERT ON targets WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_targets_update BEFORE UPDATE ON targets WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_targets_delete BEFORE DELETE ON targets WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_proposals_insert BEFORE INSERT ON proposals WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_proposals_update BEFORE UPDATE ON proposals WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_proposals_delete BEFORE DELETE ON proposals WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_sync_epoch_insert BEFORE INSERT ON sync_epoch WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_sync_epoch_update BEFORE UPDATE ON sync_epoch WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_sync_epoch_delete BEFORE DELETE ON sync_epoch WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_listings_insert BEFORE INSERT ON listings WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_listings_update BEFORE UPDATE ON listings WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_listings_delete BEFORE DELETE ON listings WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_listing_items_insert BEFORE INSERT ON listing_items WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_listing_items_update BEFORE UPDATE ON listing_items WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_listing_items_delete BEFORE DELETE ON listing_items WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_purge_log_insert BEFORE INSERT ON purge_log WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_purge_log_update BEFORE UPDATE ON purge_log WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_purge_log_delete BEFORE DELETE ON purge_log WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_purge_objects_insert BEFORE INSERT ON purge_objects WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_purge_objects_update BEFORE UPDATE ON purge_objects WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_purge_objects_delete BEFORE DELETE ON purge_objects WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_restorations_insert BEFORE INSERT ON restorations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_restorations_update BEFORE UPDATE ON restorations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
CREATE TRIGGER frozen_restorations_delete BEFORE DELETE ON restorations WHEN (SELECT frozen FROM maintenance WHERE singleton = 1) = 1 BEGIN SELECT RAISE(ABORT, 'socrate_frozen: instance gelée pour sauvegarde'); END;
