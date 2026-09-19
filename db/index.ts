import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

// URL database nanti bakal kita simpen dengan aman di Environment Variable (DATABASE_URL)
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("⚠️ DATABASE_URL belum diset!");
}

export const sql = postgres(connectionString || "", {
  prepare: false,
  // Two pooler connections keep bootstrap reads responsive without the burst
  // of five connections that exhausted slots across warm serverless instances.
  max: 2,
  idle_timeout: 5,
  connect_timeout: 5,
  max_lifetime: 60,
});

export const db = drizzle(connectionString || "", { schema });
