import { expect, test } from "@playwright/test";
import { boardKinds, enterLobby, gameLog, hint, moveCount, newPlayer, points, pushOnce, seeded, settled, waitForTurn } from "./helpers";

test("Online-Partie zwischen Desktop und Smartphone: Einladung, Vorschau, Züge, Sperre, Chat, Aufgabe", async ({ browser }) => {
  const rene = await newPlayer(browser);
  const mia = await newPlayer(browser, { phone: true });

  await enterLobby(rene.page, "René");
  await rene.page.getByRole("button", { name: "Privat mit Einladungslink" }).click();
  const link = await rene.page.locator("#invite-link").inputValue();
  expect(link).toMatch(/\/\?t=[A-Z2-9]{5}$/);

  // Mia kommt über den Einladungslink direkt an den Tisch
  await enterLobby(mia.page, "Mia", new URL(link).pathname + new URL(link).search);
  await expect(rene.page.locator(".player .name").nth(1)).toContainText("Mia");
  await expect(hint(mia.page)).toHaveText("René ist am Zug.");
  expect(await boardKinds(mia.page)).toBe(await boardKinds(rene.page));
  // Wer nicht dran ist, kann nicht schieben
  await expect(mia.page.locator(".arrow:not([disabled])")).toHaveCount(0);

  // René zeigt mit der Maus auf einen Pfeil: Mia sieht die Vorschau auf derselben Reihe
  await waitForTurn(rene.page);
  await rene.page.locator('.arrow[data-move="left-2"]').hover();
  await expect(mia.page.locator('.arrow[data-move="left-2"]')).toHaveClass(/active/);
  await expect(mia.page.locator(".cell.hover")).toHaveCount(5);

  // René schiebt Reihe 3 von links; beide sehen danach dasselbe Feld
  await pushOnce(rene.page, { pick: "left-2" });
  await settled(mia.page, 0);
  expect(await boardKinds(mia.page)).toBe(await boardKinds(rene.page));
  expect(await points(mia.page, 0)).toBe(await points(rene.page, 0));

  // Mia ist dran. Direktes Zurückschieben ist gesperrt, sie schiebt per Touch woanders
  await waitForTurn(mia.page);
  await expect(mia.page.locator('.arrow[data-move="right-2"]')).toBeDisabled();
  await pushOnce(mia.page, { pick: "top-0", touch: true });
  await settled(rene.page, 1);
  expect(await boardKinds(mia.page)).toBe(await boardKinds(rene.page));
  expect(await gameLog(mia.page).allInnerTexts()).toEqual(await gameLog(rene.page).allInnerTexts());
  await expect(gameLog(rene.page).filter({ hasText: "Mia: Spalte 1 von oben" })).toHaveCount(1);

  // Chat am Tisch
  await mia.page.getByPlaceholder(/Nachricht/).last().fill("Gut geschoben!");
  await mia.page.getByPlaceholder(/Nachricht/).last().press("Enter");
  await expect(rene.page.getByText("Gut geschoben!")).toBeVisible();

  // Mia gibt auf: sie landet in der Lobby, René bleibt am Tisch und sieht den Grund
  await mia.page.getByRole("button", { name: "Aufgeben und Tisch verlassen" }).click();
  await expect(mia.page.getByRole("button", { name: "Privat mit Einladungslink" })).toBeVisible();
  await expect(rene.page.getByText("Mia hat den Tisch verlassen.")).toBeVisible();

  expect(rene.errors).toEqual([]);
  expect(mia.errors).toEqual([]);
});

test("Online-Partie bis zum Ende und Revanche", async ({ browser }) => {
  const a = await newPlayer(browser);
  const b = await newPlayer(browser);
  await enterLobby(a.page, "Anna");
  await a.page.getByLabel("Tischname").fill("Finale");
  await a.page.getByRole("button", { name: "Tisch eröffnen" }).click();

  // Ben findet den Tisch in der Lobby-Liste
  await enterLobby(b.page, "Ben");
  await b.page.getByRole("listitem").filter({ hasText: "Finale" }).getByRole("button", { name: "Beitreten" }).click();
  await expect(a.page.locator(".player .name").nth(1)).toContainText("Ben");

  const rnd = seeded(5);
  let moves = 0;
  for (; moves < 120; moves++) {
    const turn = await Promise.race([waitForTurn(a.page).then((on) => ({ page: a.page, on })), waitForTurn(b.page).then((on) => ({ page: b.page, on }))]);
    if (!turn.on) break;
    await pushOnce(turn.page, { random: rnd });
  }
  expect(moves).toBeLessThan(120);

  // Beide sehen dasselbe Ergebnis
  await expect(a.page.locator(".badge", { hasText: /Gewonnen|Verloren/ })).toHaveCount(2);
  await expect(b.page.locator(".badge", { hasText: /Gewonnen|Verloren/ })).toHaveCount(2);
  await expect(a.page.locator(".score")).toContainText(/Partien (1 : 0|0 : 1)/);
  expect(Math.max(await points(a.page, 0), await points(a.page, 1))).toBeGreaterThan(0);
  expect(await boardKinds(b.page)).toBe(await boardKinds(a.page));
  expect(await gameLog(b.page).allInnerTexts()).toEqual(await gameLog(a.page).allInnerTexts());
  await expect(gameLog(a.page).last()).toContainText("gewinnt");

  // Revanche: erst wenn beide wollen, beginnt die nächste Partie bei 0 : 0
  await a.page.getByRole("button", { name: "Revanche" }).click();
  await expect(b.page.getByRole("button", { name: "Revanche annehmen" })).toBeVisible();
  await b.page.getByRole("button", { name: "Revanche annehmen" }).click();
  await expect(a.page.locator(".badge", { hasText: /Gewonnen|Verloren/ })).toHaveCount(0);
  await expect.poll(() => moveCount(a.page)).toBe(0);
  expect(await points(a.page, 0)).toBe(0);
  expect(await points(b.page, 1)).toBe(0);

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});
