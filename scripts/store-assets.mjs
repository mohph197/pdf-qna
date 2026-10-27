// Regenerates the extension icons and the Chrome Web Store images:
//   icons/icon{16,32,48,128}.png        from icons/icon.svg
//   store/screenshot-*.png  1280x800     real extension, mocked answers (via tests/e2e.mjs)
//   store/promo-small.png   440x280      small promo tile
//   store/promo-marquee.png 1400x560     marquee promo tile
//
//   npm run store-assets

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = join(ROOT, "store");
mkdirSync(STORE, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ||
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
const svg = readFileSync(join(ROOT, "icons/icon.svg"), "utf8");
const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

async function render(html, width, height, path, scale = 1) {
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path, omitBackground: true, clip: { x: 0, y: 0, width, height } });
}

for (const size of [16, 32, 48, 128]) {
  // Small sizes drop the page padding so the glyph stays legible.
  const img =
    size >= 48
      ? `<img src="${svgUrl}" width="${size}" height="${size}">`
      : `<img src="${svgUrl}" style="width:${size * 1.33}px;height:${size * 1.33}px;margin:${-size * 0.165}px">`;
  await render(`<div style="width:${size}px;height:${size}px;overflow:hidden">${img}</div>`, size, size, join(ROOT, `icons/icon${size}.png`));
}

const tile = (w, h, title, sub, iconSize) => `
<div style="width:${w}px;height:${h}px;display:flex;align-items:center;gap:${w / 22}px;padding:0 ${w / 14}px;box-sizing:border-box;
  background:linear-gradient(135deg,#1f2937 0%,#111827 60%,#3b2a0b 100%);font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:#f9fafb">
  <img src="${svgUrl}" width="${iconSize}" height="${iconSize}" style="flex:none;background:#fff3;border-radius:${iconSize / 5}px">
  <div>
    <div style="font-size:${h / 6.2}px;font-weight:700;letter-spacing:-0.5px">${title}</div>
    <div style="font-size:${h / 13}px;color:#d1d5db;margin-top:${h / 40}px;line-height:1.3">${sub}</div>
    <div style="margin-top:${h / 18}px;display:inline-block;font-size:${h / 16}px;line-height:1.5;background:#fbbf24;color:#111827;padding:0 ${h / 40}px;border-radius:4px">
      “…a degradation problem has been exposed”</div>
  </div>
</div>`;
await render(tile(440, 280, "Paper Q&amp;A", "Ask Claude about any PDF.<br>See the answers highlighted.", 120), 440, 280, join(STORE, "promo-small.png"));
await render(
  tile(1400, 560, "Paper Q&amp;A", "Ask Claude questions about a research paper.<br>Every answer is backed by verbatim quotes, highlighted in the PDF.", 260),
  1400,
  560,
  join(STORE, "promo-marquee.png"),
);
await browser.close();

// Screenshots come from the real extension, driven by the end-to-end test.
execFileSync(process.execPath, [join(ROOT, "tests/e2e.mjs"), "--screenshots", STORE], { stdio: "inherit" });
console.log(`Store assets written to ${STORE}`);
