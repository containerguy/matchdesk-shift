import { expect, type Browser, type Page } from "@playwright/test";

export const HINT = {
  myTurn: /^Du bist dran/,
  over: "Partie vorbei."
};

export async function newPlayer(browser: Browser, options: { phone?: boolean } = {}) {
  const context = await browser.newContext(
    options.phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 860 } }
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return { context, page, errors };
}

export async function enterLobby(page: Page, name: string, path = "/") {
  await page.goto(path);
  await page.getByLabel("Dein Name").fill(name);
  await page.getByRole("button", { name: "Weiter zur Lobby" }).click();
}

export const hint = (page: Page) => page.locator("p.hint");
export const board = (page: Page) => page.locator(".board");
export const gameLog = (page: Page) => page.locator("ol.log li");

/** Wartet, bis dieser Spieler am Zug ist oder die Partie vorbei ist. Gibt false zurück, wenn sie vorbei ist. */
export async function waitForTurn(page: Page, timeout = 60_000) {
  await expect(hint(page)).toHaveText(/^Du bist dran|Partie vorbei/, { timeout });
  return !(await hint(page).innerText()).includes(HINT.over);
}

/** Feld, wie dieser Spieler es gerade sieht: eine Ziffer je Zelle. */
export async function boardKinds(page: Page) {
  return (await page.locator(".grid .cell").evaluateAll((cells) => cells.map((c) => (c as HTMLElement).dataset.kind))).join("");
}

export async function moveCount(page: Page) {
  return Number(await board(page).getAttribute("data-moves"));
}

export async function points(page: Page, seat: 0 | 1) {
  return Number(await page.getByTestId(`points-${seat}`).innerText());
}

/** Wartet, bis die Animation vorbei ist und der Zug ausgewertet ist. */
export async function settled(page: Page, after: number, timeout = 20_000) {
  await expect.poll(async () => (await moveCount(page)) > after && (await board(page).getAttribute("data-phase")) !== "animating", { timeout }).toBe(true);
}

/**
 * Ein Zug über die Oberfläche: freien Pfeil wählen und schieben.
 * Maus: klicken. Touch: Pfeil antippen (Vorschau), dann „… schieben“ bestätigen.
 */
export async function pushOnce(page: Page, options: { random?: () => number; touch?: boolean; pick?: string; wait?: boolean } = {}) {
  const enabled = page.locator(".arrow:not([disabled])");
  await expect(enabled.first()).toBeVisible();
  const count = await enabled.count();
  const arrow = options.pick ? page.locator(`.arrow[data-move="${options.pick}"]`) : enabled.nth(Math.floor((options.random?.() ?? 0) * count));
  const before = await moveCount(page);
  if (options.touch) {
    await arrow.tap();
    await expect(arrow).toHaveClass(/active/);
    await page.getByRole("button", { name: /schieben$/ }).tap();
  } else {
    await arrow.click();
  }
  if (options.wait !== false) await settled(page, before);
}

/** Einfacher fester Zufall, damit Testläufe wiederholbar sind. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}
