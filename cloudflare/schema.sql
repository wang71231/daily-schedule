CREATE TABLE IF NOT EXISTS schedule_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  server_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO schedule_state VALUES (
  1, lower(hex(randomblob(16))), 0,
  '{"logs":{},"extraCourses":[],"historyHours":"0","trainingRate":"0"}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
-- Every accepted version is kept. History is not silently trimmed on the server.
CREATE TABLE IF NOT EXISTS schedule_history (
  revision INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_config (id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
