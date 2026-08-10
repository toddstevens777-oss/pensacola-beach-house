const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'beachhouse.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS periods (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS weeks (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES periods(id),
  start_date TEXT NOT NULL, -- Thursday, YYYY-MM-DD
  end_date TEXT NOT NULL,   -- Wednesday, YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'open', -- open | requested | finalized
  finalized_family TEXT,    -- Stevens | Furr | Wagner | null
  sort_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES weeks(id),
  family TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES weeks(id),
  family TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS family_credentials (
  family TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL -- 'self' or 'admin'
);
`);

module.exports = db;
