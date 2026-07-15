// Capture a README screenshot at 2× (2720×1760) from a running skill-loom UI.
//
//   node demo/shoot.mjs <url> <out.png> [skill name]
//
// With no skill name it shoots the library view; with one it opens that skill's
// detail page first. Needs Playwright + a Chromium:
//
//   npm i -D playwright && npx playwright install chromium
//
// Example (regenerate both README shots):
//   node demo/shoot.mjs http://127.0.0.1:7777/ docs/dashboard-library.png
//   node demo/shoot.mjs http://127.0.0.1:7777/ docs/dashboard-detail.png "code review"

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "Playwright not found. Run: npm i -D playwright && npx playwright install chromium",
  );
  process.exit(1);
}

const url = process.argv[2] || "http://127.0.0.1:7777/";
const out = process.argv[3] || "shot.png";
const skill = process.argv[4]; // optional: open this skill's detail view first

const browser = await chromium.launch();
const ctx = await browser.newContext({
  // 1600 wide so the ledger's taxonomy chips (domain/layer) never truncate;
  // 2× keeps the capture crisp. Long descriptions still ellipsize, as intended.
  viewport: { width: 1600, height: 880 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("#groups [data-skill]");

if (skill) {
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll("#groups [data-skill]")].find(
      (el) => new RegExp(name, "i").test(el.textContent || ""),
    );
    if (row) row.click();
  }, skill);
  await page.waitForSelector("#filelist .file");
  await page.waitForSelector("#history .commit");
}

await page.waitForTimeout(700); // let fonts + layout settle
await page.screenshot({ path: out });
await browser.close();
console.log("shot →", out);
