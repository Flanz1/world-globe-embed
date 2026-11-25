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

/* ── Pins tab: the same list + inspector. ── */

/** Shows pin map `id`'s actions and pins in the Pins inspector (no-op when it already shows). */
export async function pickPinMap(page, id) {
  const box = page.locator(`#pn-inspector [data-insp-pinmap="${id}"]`);
  if (await box.count()) return;
  await page.waitForSelector(`#tab-pins .pinmap[data-pinmap="${id}"]`, { state: "attached", timeout: 20000 });
  await openPinFoldersAround(page, `#tab-pins .pinmap[data-pinmap="${id}"]`);
  await page.locator(`#tab-pins [data-pick-pinmap="${id}"]`).click();
  await box.waitFor({ timeout: 10000 });
}

/** Shows pin folder `id`'s actions in the Pins inspector (no-op when it already shows). */
export async function pickPinFolder(page, id) {
  const box = page.locator(`#pn-inspector [data-insp-pinfolder="${id}"]`);
  if (await box.count()) return;
  await page.waitForSelector(`#tab-pins .rfolder[data-pinfolder="${id}"]`, { state: "attached", timeout: 20000 });
  await openPinFoldersAround(page, `#tab-pins .rfolder[data-pinfolder="${id}"] > .rfolder-head`);
  await page.locator(`#tab-pins [data-pick-pinfolder="${id}"]`).click();
  await box.waitFor({ timeout: 10000 });
}

async function openPinFoldersAround(page, selector) {
  await page.evaluate((sel) => {
    let el = document.querySelector(sel)?.parentElement;
    while (el && el.id !== "tab-pins") {
      if (el.classList.contains("rfolder") && el.classList.contains("closed")) el.querySelector(":scope > .rfolder-head .rfolder-toggle")?.click();
      el = el.parentElement;
    }
  }, selector);
}

/** Opens part `row`'s second line (colour, region, actions) in the Parts list if it is closed. */
export async function openPartRow(page, row) {
  const r = page.locator(`dialog.editor .ed-part-row[data-row="${row}"]`);
  if (await r.locator(".ed-part-more").isVisible()) return;
  await r.locator('[data-act="part-more"]').click();
}

/** Clicks part `row`'s action button `act` (opens its second line first). */
export async function partAct(page, row, act) {
  await openPartRow(page, row);
  await page.click(`dialog.editor .ed-part-row[data-row="${row}"] [data-act="${act}"]`);
}

/** Opens colour folder `key`'s ⋯ line (labels, contested, order, remove) if it is closed. */
export async function openFolderMore(page, key) {
  const f = `dialog.editor .ed-folder[data-key="${key}"]`;
  if (await page.locator(`${f} .ed-folder-more`).isVisible()) return;
  await page.click(`${f} [data-act="folder-more"]`);
}
