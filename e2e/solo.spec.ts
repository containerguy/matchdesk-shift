import { expect, test } from "@playwright/test";
import { gameLog, hint, moveCount, newPlayer, pushOnce, seeded, waitForTurn } from "./helpers";

test("Solo-Partie gegen den Computer bis zum Ende", async ({ browser }) => {
  const { page, errors } = await newPlayer(browser);
  await page.goto("/");
  await page.getByRole("button", { name: "Allein gegen den Computer spielen" }).click();
  await page.getByRole("group", { name: "Gegner wählen" }).getByRole("button", { name: "Schwer" }).click();
  await expect(page.locator(".player .name").nth(1)).toContainText("Computer (Schwer)");

  const rnd = seeded(8);
  let turns = 0;
  for (; turns < 120; turns++) {
    if (!(await waitForTurn(page, 30_000))) break;
    await pushOnce(page, { random: rnd, wait: false });
  }
  expect(turns).toBeLessThan(120);
  await expect(gameLog(page).filter({ hasText: /^Computer \(Schwer\): / }).first()).toBeVisible();
  await expect(page.locator(".badge", { hasText: "Gewonnen" })).toHaveCount(1);
  await expect(gameLog(page).last()).toContainText("gewinnt");

  // Neue Partie beginnt wieder bei null, man selbst ist dran
  await page.getByRole("button", { name: "Neue Partie" }).click();
  await expect.poll(() => moveCount(page)).toBe(0);
  await expect(hint(page)).toHaveText(/^Du bist dran/);
  expect(errors).toEqual([]);
});

test("Am Smartphone gegen den Computer, danach zu zweit an einem Gerät", async ({ browser }) => {
  const { page, errors } = await newPlayer(browser, { phone: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Allein gegen den Computer spielen" }).click();
  await page.getByRole("group", { name: "Gegner wählen" }).getByRole("button", { name: "Leicht" }).click();

  // Antippen zeigt erst die Vorschau, erst die Bestätigung schiebt
  await waitForTurn(page);
  await page.locator('.arrow[data-move="bottom-4"]').tap();
  await expect(page.locator(".cell.hover")).toHaveCount(5);
  expect(await moveCount(page)).toBe(0);
  await page.getByRole("button", { name: "Spalte E von unten schieben" }).tap();

  // Der Computer antwortet sichtbar: erst Vorschau, dann sein Zug
  await expect(page.locator(".arrow.active")).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => moveCount(page), { timeout: 15_000 }).toBe(2);
  await expect(gameLog(page).filter({ hasText: /^Computer \(Leicht\): / })).toHaveCount(1);
  await expect(hint(page)).toHaveText(/^Du bist dran/);

  await page.getByRole("group", { name: "Gegner wählen" }).getByRole("button", { name: "Zu zweit" }).click();
  await expect(page.locator(".player .name").nth(1)).toContainText("Spieler 2");
  await pushOnce(page, { touch: true, pick: "left-0" });
  await pushOnce(page, { touch: true, pick: "top-3" });
  expect(await moveCount(page)).toBe(2);
  expect(errors).toEqual([]);
});

test("Eingebettete Partie gegen den Computer (Matchdesk)", async ({ browser }) => {
  const { page, errors } = await newPlayer(browser);
  await page.goto("/?embed=1&solo=easy&name=Anna");
  await expect(page.locator(".app.embed")).toBeVisible();
  await expect(page.locator(".topbar")).toHaveCount(0);
  await expect(page.locator(".player .name").nth(0)).toContainText("Anna");
  await expect(page.locator(".player .name").nth(1)).toContainText("Computer (Leicht)");

  const rnd = seeded(3);
  await pushOnce(page, { random: rnd });
  await expect.poll(() => moveCount(page), { timeout: 15_000 }).toBe(2);
  await waitForTurn(page);

  await page.getByRole("button", { name: "Neue Partie" }).click();
  await expect.poll(() => moveCount(page)).toBe(0);
  expect(errors).toEqual([]);
});
