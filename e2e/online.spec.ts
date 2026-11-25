import { expect, test } from "@playwright/test";
import { boardKinds, cellCenter, enterLobby, gameLog, hint, moveCount, newPlayer, points, pushOnce, seeded, settled, waitForTurn } from "./helpers";

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

  // Der nächste Stein hängt an Renés Maus: im Feld nahe am linken Rand von Reihe 3 rastet er dort ein.
  // Mia sieht die Vorschau auf derselben Reihe, samt Stein.
  await waitForTurn(rene.page);
  const nearLeft = await cellCenter(rene.page, 2, 0);
  await rene.page.mouse.move(nearLeft.x, nearLeft.y, { steps: 4 });
  await expect(rene.page.locator('.arrow[data-move="left-2"]')).toHaveClass(/active/);
  await expect(rene.page.getByTestId("carrier")).toHaveClass(/\bon\b/);
  await expect(mia.page.locator('.arrow[data-move="left-2"]')).toHaveClass(/active/);
  await expect(mia.page.locator(".cell.hover")).toHaveCount(5);
  await expect(mia.page.getByTestId("carrier")).toHaveClass(/\bon\b.*theirs|theirs.*\bon\b/);

  // Weiter nach oben gezogen rastet er in Spalte B oben ein, zurück an Reihe 3 links
  const nearTop = await cellCenter(rene.page, 0, 1);
  await rene.page.mouse.move(nearTop.x, nearTop.y - 10, { steps: 4 });
  await expect(rene.page.locator('.arrow[data-move="top-1"]')).toHaveClass(/active/);
  await rene.page.mouse.move(nearLeft.x, nearLeft.y, { steps: 4 });
  await expect(mia.page.locator('.arrow[data-move="left-2"]')).toHaveClass(/active/);

  // Klick schiebt Reihe 3 von links, egal wo im Feld; beide sehen danach dasselbe Feld
  await rene.page.mouse.click(nearLeft.x, nearLeft.y);
  await settled(rene.page, 0);
  await settled(mia.page, 0);
  await expect(gameLog(mia.page).filter({ hasText: "René: Reihe 3 von links" })).toHaveCount(1);
  expect(await boardKinds(mia.page)).toBe(await boardKinds(rene.page));
  expect(await points(mia.page, 0)).toBe(await points(rene.page, 0));

  // Mia ist dran. Direktes Zurückschieben ist gesperrt, sie schiebt per Touch woanders
  await waitForTurn(mia.page);
  await expect(mia.page.locator('.arrow[data-move="right-2"]')).toHaveAttribute("aria-disabled", "true");
  await pushOnce(mia.page, { pick: "top-0", touch: true });
  await settled(rene.page, 1);
  expect(await boardKinds(mia.page)).toBe(await boardKinds(rene.page));
  expect(await gameLog(mia.page).allInnerTexts()).toEqual(await gameLog(rene.page).allInnerTexts());
  await expect(gameLog(rene.page).filter({ hasText: "Mia: Spalte A von oben" })).toHaveCount(1);

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
  // Abschluss über dem Spielfeld: der Sieger bekommt Konfetti und „Gewonnen!“, der Verlierer einen ruhigen Hinweis
  await expect(a.page.locator(".celebration")).toHaveCount(1);
  await expect(b.page.locator(".celebration")).toHaveCount(1);
  const results = [await a.page.locator(".celebration").getAttribute("data-result"), await b.page.locator(".celebration").getAttribute("data-result")];
  expect(results.sort()).toEqual(["lost", "won"]);
  for (const p of [a.page, b.page]) {
    const won = (await p.locator(".celebration").getAttribute("data-result")) === "won";
    await expect(p.locator(".celebration-banner strong")).toHaveText(won ? "Gewonnen!" : "Verloren");
    await expect(p.locator(".celebration .confetti i")).toHaveCount(won ? 70 : 0);
  }

  // Revanche: erst wenn beide wollen, beginnt die nächste Partie bei 0 : 0
  await a.page.getByRole("button", { name: "Revanche" }).click();
  await expect(b.page.getByRole("button", { name: "Revanche annehmen" })).toBeVisible();
  await b.page.getByRole("button", { name: "Revanche annehmen" }).click();
  await expect(a.page.locator(".badge", { hasText: /Gewonnen|Verloren/ })).toHaveCount(0);
  await expect(a.page.locator(".celebration")).toHaveCount(0);
  await expect.poll(() => moveCount(a.page)).toBe(0);
  expect(await points(a.page, 0)).toBe(0);
  expect(await points(b.page, 1)).toBe(0);

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});
