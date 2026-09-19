import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // TAMBAHKAN BARIS INI BIAR DRIZZLE GAK NGUTAK-NGATIK SUPABASE INTERNAL:
  schemaFilter: ["public"],
});