import type { VercelRequest, VercelResponse } from "@vercel/node";
import { extractToken, verifyToken } from "./_auth.js";

export function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  const auth = verifyToken(extractToken(req) || "");
  if (!auth.valid) {
    res.status(401).json({
      ok: false,
      error: "Unauthorized. Sesi telah berakhir, silakan login ulang.",
    });
    return false;
  }
  return true;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Terjadi kesalahan pada server";
}
