CREATE TABLE proposals (
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  original TEXT NOT NULL,
  replacement TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  wording_id TEXT,
  wording TEXT,
  PRIMARY KEY (project_id, review_key, thread_id),
  FOREIGN KEY (project_id, review_key, thread_id) REFERENCES threads (project_id, review_key, thread_id)
);

CREATE INDEX proposals_wording ON proposals (project_id, review_key, wording_id)
