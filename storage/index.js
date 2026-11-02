// storage/index.js — Backend selection.
//
// DATABASE_URL set  → Postgres
// DATABASE_URL unset → JSONL/JSON files under $DATA_DIR
//
// The two implement the same async interface, so nothing above this layer
// knows or cares which is in use. Tests run on files (fast, no services);
// production runs on Postgres.

import "dotenv/config";

// STORAGE_BACKEND forces a choice regardless of DATABASE_URL. The test suite
// sets it to "files" so a stray DATABASE_URL in .env can never point tests at
// a real database and truncate it.
const forced = process.env.STORAGE_BACKEND;
if (forced && forced !== "files" && forced !== "postgres") {
  throw new Error(`STORAGE_BACKEND must be "files" or "postgres", got "${forced}"`);
}
const usePostgres = forced ? forced === "postgres" : Boolean(process.env.DATABASE_URL);
if (usePostgres && !process.env.DATABASE_URL) {
  throw new Error("STORAGE_BACKEND=postgres but DATABASE_URL is not set");
}

const impl = usePostgres
  ? await import("./postgres.js")
  : await import("./files.js");

export const {
  backend, describe, migrate, close,
  insertTransaction, selectTransactions, deleteTransactions,
  selectState, upsertState,
  selectCloses, insertCloses,
  selectAlerts, insertAlert, updateAlert, deleteAlert, markAlertsChecked,
  acquireLock, releaseLock,
} = impl;
