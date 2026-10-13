import { openDb, resetDb } from '../../src/db/index.js';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://bot:bot@localhost:5432/bot_test';

export async function testDb() {
  const db = await openDb(TEST_DB_URL);
  await resetDb(db);
  return db;
}
