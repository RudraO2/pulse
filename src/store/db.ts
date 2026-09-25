import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// One SQLite file for everything the agent needs to survive a restart.
// node:sqlite (unflagged since Node 22.13) = no native build step on Windows or Render.
// Note: node:sqlite ships WITHOUT FTS5, so question search uses our own BM25 (bm25.ts).

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE events (
    seq  INTEGER PRIMARY KEY,
    ts   INTEGER NOT NULL,
    type TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX events_ts ON events(ts);

  CREATE TABLE messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    platform      TEXT NOT NULL,
    chat_id       TEXT NOT NULL,
    chat_type     TEXT NOT NULL,
    chat_title    TEXT,
    user_id       TEXT NOT NULL,
    user_name     TEXT NOT NULL,
    text          TEXT NOT NULL,
    msg_id        TEXT NOT NULL,
    reply_to_id   TEXT,
    thread_ts     TEXT,
    addressed     INTEGER NOT NULL DEFAULT 0,
    ts            INTEGER NOT NULL,
    question_like INTEGER NOT NULL DEFAULT 0,
    answered_by   TEXT,
    answered_at   INTEGER,
    run_id        TEXT,
    escalated     INTEGER NOT NULL DEFAULT 0,
    simulated     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(platform, chat_id, msg_id)
  );
  CREATE INDEX messages_ts ON messages(ts);

  CREATE TABLE memory (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_key TEXT NOT NULL,
    sender   TEXT NOT NULL,
    text     TEXT NOT NULL,
    ts       INTEGER NOT NULL
  );
  CREATE INDEX memory_chat ON memory(chat_key, id);

  CREATE TABLE runs (
    run_id     TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    json       TEXT NOT NULL
  );

  CREATE TABLE outbox (
    key             TEXT PRIMARY KEY,
    platform        TEXT NOT NULL,
    chat_id         TEXT NOT NULL,
    reply_to        TEXT,
    text_sha        TEXT NOT NULL,
    status          TEXT NOT NULL,
    provider_msg_id TEXT,
    created_at      INTEGER NOT NULL,
    sent_at         INTEGER,
    error           TEXT
  );

  -- JSON documents keyed by id: approvals, attention items, pending mod questions
  CREATE TABLE docs (
    kind       TEXT NOT NULL,
    id         TEXT NOT NULL,
    status     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    json       TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX docs_kind_status ON docs(kind, status);

  CREATE TABLE helpers (
    platform  TEXT NOT NULL,
    user_name TEXT NOT NULL,
    simulated INTEGER NOT NULL DEFAULT 0,
    answers   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (platform, user_name, simulated)
  );

  CREATE TABLE questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    platform   TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    msg_id     TEXT NOT NULL,
    user_name  TEXT NOT NULL,
    text       TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    cluster_id TEXT,
    simulated  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX questions_ts ON questions(ts);

  CREATE TABLE clusters (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE cluster_members (
    cluster_id  TEXT NOT NULL,
    question_id INTEGER NOT NULL,
    PRIMARY KEY (cluster_id, question_id)
  );

  CREATE TABLE members (
    platform    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    is_member   INTEGER NOT NULL,
    PRIMARY KEY (platform, user_id, chat_id)
  );

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
]

let db: DatabaseSync | null = null

export function openDb(file = process.env.DB_PATH || path.resolve('data', 'pulse.db')): DatabaseSync {
  if (db) db.close()
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function getDb(): DatabaseSync {
  return db ?? openDb()
}

export function closeDb(): void {
  db?.close()
  db = null
}

function migrate(d: DatabaseSync): void {
  const row = d.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = row.user_version
  while (version < MIGRATIONS.length) {
    d.exec('BEGIN')
    try {
      d.exec(MIGRATIONS[version]!)
      d.exec(`PRAGMA user_version = ${version + 1}`)
      d.exec('COMMIT')
    } catch (err) {
      d.exec('ROLLBACK')
      throw err
    }
    version++
  }
}

/** Run fn inside a transaction (node:sqlite has no helper for this). */
export function tx<T>(fn: () => T): T {
  const d = getDb()
  d.exec('BEGIN')
  try {
    const out = fn()
    d.exec('COMMIT')
    return out
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}
