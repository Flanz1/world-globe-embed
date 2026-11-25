/**
 * The Regions tab is a list (folders and region rows) with an inspector beside it: a region's card and every
 * action on it (Edit, More…, Folder, Pin) only exist once the region is picked, and a folder's actions once the
 * folder is picked. These helpers pick them the way a person does: open the folders on the way, click the row.
 */

/** Shows region `id`'s card in the inspector (no-op when it already shows). */
export async function pickRegion(page, id) {
  const card = page.locator(`#r-inspector .rcard[data-region="${id}"]`);
  if (await card.count()) return;
  await page.waitForSelector(`#r-tree .rrow[data-region="${id}"]`, { state: "attached", timeout: 20000 });
  await openFoldersAround(page, `#r-tree .rrow[data-region="${id}"]`);
  await page.locator(`#r-tree .rrow[data-region="${id}"] .rrow-pick`).click();
  await card.waitFor({ timeout: 10000 });
}

/** Shows folder `id`'s actions and regions in the inspector (no-op when it already shows). */
export async function pickFolder(page, id) {
  const box = page.locator(`#r-inspector [data-insp-folder="${id}"]`);
  if (await box.count()) return;
  await page.waitForSelector(`#r-tree .rfolder[data-category="${id}"]`, { state: "attached", timeout: 20000 });
  await openFoldersAround(page, `#r-tree .rfolder[data-category="${id}"] > .rfolder-head`);
  await page.locator(`#r-tree .rfolder-pick[data-pick-folder="${id}"]`).click();
  await box.waitFor({ timeout: 10000 });
}

/** Ticks region `id`'s box while selecting regions (opening its folders first). */
export async function tickRegion(page, id) {
  const sel = `#r-tree .rrow[data-region="${id}"]`;
  await page.waitForSelector(sel, { state: "attached", timeout: 20000 });
  await openFoldersAround(page, sel);
  await page.locator(`${sel} input.bulk-box`).check();
}

/** Opens every closed folder that holds `selector`, so it can be clicked. */
export async function openFoldersAround(page, selector) {
  await page.evaluate((sel) => {
    let el = document.querySelector(sel)?.parentElement;
    while (el && el.id !== "r-tree") {
      if (el.classList.contains("rfolder") && el.classList.contains("closed")) el.querySelector(":scope > .rfolder-head .rfolder-toggle")?.click();
      el = el.parentElement;
    }
  }, selector);
}
