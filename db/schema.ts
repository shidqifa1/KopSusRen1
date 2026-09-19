import { pgTable, serial, jsonb, timestamp } from "drizzle-orm/pg-core";

export const appState = pgTable("app_state", {
  id: serial().primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
