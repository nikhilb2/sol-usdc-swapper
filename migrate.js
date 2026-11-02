// migrate.js — Apply storage/schema.sql. Idempotent.
//
//   npm run migrate
//
// docker-compose applies the schema automatically on a FIRST start (empty
// volume). This is the path for a volume that already exists, or for a
// database you brought yourself.

import { migrate, describe, backend, close } from "./storage/index.js";

try {
  console.log(`Migrating ${describe()}...`);
  await migrate();
  console.log(backend === "files" ? "✅ data directory ready" : "✅ schema applied");
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}
