# matchdesk-shift

**Dreierschub** ist ein Schiebe- und Legespiel für zwei Spieler im Browser: Lobby, Tische mit Einladungslink, Chat, Partie gegen den Computer. Gespielt wird online zwischen zwei Geräten, auch am Smartphone. Eingebunden wird es über das Modul „arena“ in [Matchdesk](https://github.com/containerguy/Matchdesk).

Dieses Repository enthält nur Dreierschub. Jedes Spiel hat ein eigenes Repository (Billard: [matchdesk-billiard](https://github.com/containerguy/matchdesk-billiard)); Server, Lobby und Einbindung folgen demselben Aufbau.

## Regeln

- Feld 5 × 5 mit sechs Symbolen: Zitrone 1, Kirschen 2, Trauben 3, Melone 4, Glocke 5, Edelstein 6 Punkte.
- Wer am Zug ist, schiebt den angezeigten **nächsten Stein** von einer der vier Seiten in eine Reihe oder Spalte. Am anderen Ende fällt ein Stein heraus. Der Stein danach ist als Vorschau zu sehen.
- Drei oder mehr gleiche Steine in einer Linie verschwinden und bringen dem Schiebenden Punkte: 3 gleiche = Wert × 3, 4 = Wert × 5, 5 = Wert × 8. Die Lücken füllen sich zufällig neu auf; entsteht dabei wieder eine Linie, zählt sie als Kette doppelt, dreifach usw.
- Den letzten Schub des Gegners direkt zurückzuschieben (gleiche Linie, Gegenseite) ist nicht erlaubt.
- Wer zuerst **150 Punkte** hat, gewinnt. Nach 60 Zügen gewinnt, wer vorn liegt (bei Gleichstand wird weitergespielt, bis jemand führt).

Der Zufall steckt im Spielzustand auf dem Server; Clients bekommen den Zustand ohne ihn und können die Nachfüllsteine nicht vorhersehen.

## Aufbau

```text
packages/core      Spiel-Schnittstelle (GameDefinition)
packages/protocol  Nachrichten zwischen Client und Server (zod-geprüft)
games/shift        Regeln und Computergegner (rein, deterministisch, getestet)
apps/server        Express + WebSocket: Lobby, Tische, Schiedsrichter, Integrations-API
apps/client        Vite + React: Lobby, Spielfeld, Steuerung
e2e                End-to-End-Tests (Playwright)
```

## Entwickeln

```bash
npm install
npm run dev        # Server auf :3000, Client auf http://localhost:5173
npm test           # Unit-Tests (Vitest)
npm run typecheck
npm run test:e2e   # End-to-End-Tests im Browser (Playwright)
```

## End-to-End-Tests

Die Tests unter `e2e/` bauen den Client, starten den echten Spielserver und spielen im Browser: eine Online-Partie zwischen Desktop und Smartphone (Einladungslink, Vorschau beim Gegner, Züge per Maus und Touch, Sperre fürs Zurückschieben, Chat, Aufgabe), eine Online-Partie bis zum Ende mit Revanche, eine Partie gegen den Computer bis zum Ende, eine am Smartphone mit Wechsel zu zweit an einem Gerät und die eingebettete Partie gegen den Computer. Sie laufen in der CI als eigener Check `e2e` und sind Pflicht: ohne grüne E2E-Tests wird nicht gemergt.

Einmalig vor dem ersten lokalen Lauf: `npx playwright install chromium`.

## Bedienung

- Maus: Der nächste Stein hängt am Zeiger und rastet an der nächsten Einschubstelle am Rand ein (die Reihe wird markiert, der Gegner sieht die Vorschau). Klick schiebt.
- Touch: Stein mit dem Finger an den Rand ziehen; Loslassen zeigt nur die Vorschau. Dieselbe Stelle noch einmal antippen oder „… schieben“ schiebt.
- Tastatur: Tab auf eine Einschubstelle, Enter schiebt.

## Betreiben

Ein Prozess liefert Client und WebSocket (`/ws`) auf einem Port aus.

```bash
npm ci
npm run build
npm start          # Port 3000 (PORT=... zum Ändern)
```

Oder mit Docker: `docker compose up -d --build`. Fertige Images baut der Workflow „Image“ bei jedem Push auf `main`: `ghcr.io/containerguy/matchdesk-shift:latest` und `:sha-<commit>`. In PRs wird das Image nur gebaut und unter `/game-servers/shift` kurz gestartet.

Der Spielstand liegt im Arbeitsspeicher, ein Neustart beendet laufende Partien. `GET /health` meldet den Zustand.

## Einbindung in Matchdesk

Gleiche Schnittstelle wie beim Billard, damit das Modul „arena“ alle Spiele gleich behandelt:

- Eingebettet mit `?embed=1`, Platz-Link `?seat=<token>`; gegen den Computer `?embed=1&solo=easy|medium|hard&name=<Anzeigename>` (läuft ganz im Browser).
- `<BASE_PATH>/api/integrations/v1`: `POST /tables` (reservierter Tisch, `game` ist `shift`), `GET /tables/:id`, `DELETE /tables/:id`.
- Ereignisse `game.finished`, `table.expired`, `table.closed` per `POST` an die `callbackUrl`, signiert mit `X-Bandenduell-Timestamp` und `X-Bandenduell-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`. Die Header-Namen sind die gemeinsame Kennung aller Spielserver.
- `postMessage` an das umgebende Fenster: `{ source: "bandenduell", type: "ready" | "status" | "matchEnded" | "closed", … }`.

| Umgebungsvariable | Bedeutung |
| --- | --- |
| `BASE_PATH` | Unterpfad hinter dem Reverse Proxy, z. B. `/game-servers/shift` |
| `INTEGRATION_API_KEY` | Schlüssel für `Authorization: Bearer …`; ohne ihn ist die Schnittstelle aus |
| `INTEGRATION_WEBHOOK_SECRET` | Geheimnis für die Signatur der Ereignisse |
| `FRAME_ANCESTORS` | wer das Spiel einbetten darf (CSP `frame-ancestors`), Standard `'self'` |
