import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db } from "../db/index.js";
import { appState } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { verifyToken, extractToken } from "./_auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const token = extractToken(req);
  const auth = verifyToken(token || '');

  if (!auth.valid) {
    return res.status(401).json({ ok: false, error: "Unauthorized. Sesi telah berakhir, silakan login ulang." });
  }

  if (req.method === "GET") {
    const rows = await db.select().from(appState).limit(1);
    if (rows.length === 0) {
      return res.status(200).json(null);
    }
    return res.status(200).json(rows[0].data);
  }

  if (req.method === "POST") {
    const data = req.body;

    const existing = await db
      .select({ id: appState.id })
      .from(appState)
      .limit(1);

    if (existing.length === 0) {
      await db.insert(appState).values({ data });
    } else {
      await db
        .update(appState)
        .set({ data, updatedAt: new Date() })
        .where(eq(appState.id, existing[0].id));
    }

    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    await db.delete(appState);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).send("Method not allowed");
}
