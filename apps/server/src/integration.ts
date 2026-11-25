import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import type { Hub, TableEvent } from "./hub";

/**
 * HTTP-Schnittstelle für Integrationen wie Matchdesk (`/api/integrations/v1`).
 *
 * Anmeldung per `Authorization: Bearer <INTEGRATION_API_KEY>`. Ohne gesetzten Schlüssel ist die
 * Schnittstelle aus (503). Ereignisse gehen per POST an die `callbackUrl` des Tisches, signiert mit
 * HMAC-SHA256 über `<timestamp>.<body>` (Header `X-Bandenduell-Timestamp`, `X-Bandenduell-Signature`).
 * Die Header-Namen stammen vom Billard-Server und bleiben gleich, damit das Matchdesk-Modul „arena“
 * alle Spielserver auf dieselbe Weise prüfen kann.
 */

const playerSchema = z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(60) });
const reserveSchema = z.object({
  game: z.literal("shift").default("shift"),
  name: z.string().max(40).optional(),
  ref: z.string().max(64).optional(),
  callbackUrl: z.string().url().max(500).optional(),
  players: z.tuple([playerSchema, playerSchema])
});

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function integrationRouter(hub: Hub, apiKey: string | undefined): Router {
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));
  router.use((req: Request, res: Response, next) => {
    if (!apiKey) return res.status(503).json({ error: "integration_disabled" });
    const header = req.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!given || !safeEqual(given, apiKey)) return res.status(401).json({ error: "unauthorized" });
    next();
  });

  router.post("/tables", (req, res) => {
    const parsed = reserveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid", issues: parsed.error.issues });
    const { players, name, ref, callbackUrl } = parsed.data;
    res.status(201).json(hub.reserveTable({ players, name, ref, callbackUrl }));
  });

  router.get("/tables/:id", (req, res) => {
    const info = hub.reservedTable(req.params.id);
    if (!info) return res.status(404).json({ error: "not_found" });
    res.json(info);
  });

  router.delete("/tables/:id", (req, res) => {
    if (!hub.closeReserved(req.params.id)) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
  });

  return router;
}

export function signPayload(secret: string, timestamp: string, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Schickt Tisch-Ereignisse an die Integration; drei Versuche mit wachsender Pause. */
export function createEventSender(secret: string | undefined, fetchImpl: typeof fetch = fetch) {
  return (event: TableEvent, callbackUrl: string | null) => {
    if (!callbackUrl) return;
    if (!secret) {
      console.warn("[integration] INTEGRATION_WEBHOOK_SECRET fehlt, Ereignis nicht gesendet:", event.type);
      return;
    }
    const body = JSON.stringify(event);
    const attempt = async (n: number): Promise<void> => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      try {
        const res = await fetchImpl(callbackUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bandenduell-timestamp": timestamp,
            "x-bandenduell-signature": signPayload(secret, timestamp, body)
          },
          body
        });
        if (res.ok) return;
        throw new Error(`HTTP ${res.status}`);
      } catch (error) {
        if (n >= 3) {
          console.error(`[integration] Ereignis ${event.type} für Tisch ${event.table.id} nicht zugestellt:`, error);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000 * 2 ** n));
        return attempt(n + 1);
      }
    };
    void attempt(1);
  };
}
