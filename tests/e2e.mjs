// End-to-end test: loads the unpacked extension into headless Chrome, opens
// a real paper, answers questions with a mocked Claude API, and checks
// highlights, quote navigation, zoom, cache restore, local files and the
// "open in Paper Q&A" offer.
//
//   npm run test:e2e
//   CHROME_PATH=/path/to/chrome npm run test:e2e
//   node tests/e2e.mjs --screenshots store/   # also writes store screenshots
//   EXTENSION_DIR=/tmp/unzipped npm run test:e2e  # test a built package
//
// Needs tests/papers/1512.03385.pdf (scripts/fetch-test-papers.sh).

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Test the unzipped store package instead of the source tree when set.
const EXTENSION = resolve(process.env.EXTENSION_DIR || ROOT);
const PAPER = join(ROOT, "tests/papers/1512.03385.pdf");
const shotsArg = process.argv.indexOf("--screenshots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;

const CHROME =
  process.env.CHROME_PATH ||
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].find(existsSync);
assert.ok(CHROME, "Chrome not found; set CHROME_PATH");
assert.ok(existsSync(PAPER), "Missing test paper; run scripts/fetch-test-papers.sh");

// A mocked Claude reply: five questions, one unanswerable and one with a
// fabricated quote that must be reported as not found.
const ANSWERS = {
  answers: [
    {
      question_index: 1,
      answerable: true,
      answer: "Deeper plain networks hit a degradation problem: accuracy saturates, then degrades, and training error rises.",
      quotes: [
        {
          text: "When deeper networks are able to start converging, a degradation problem has been exposed: with the network depth increasing, accuracy gets saturated (which might be unsurprising) and then degrades rapidly.",
          page: 1,
        },
        {
          text: "Unexpectedly, such degradation is not caused by overfitting, and adding more layers to a suitably deep model leads to higher training error",
          page: 1,
        },
      ],
    },
    {
      question_index: 2,
      answerable: true,
      answer: "An ensemble of residual nets reaches 3.57% error on the ImageNet test set, winning ILSVRC 2015.",
      quotes: [
        { text: "An ensemble of these residual nets achieves 3.57% error on the ImageNet test set.", page: 1 },
        { text: "This result won the 1st place on the ILSVRC 2015 classification task.", page: 1 },
      ],
    },
    {
      question_index: 3,
      answerable: true,
      answer: "With shortcut connections that perform identity mapping and are added to the stacked layers' outputs.",
      quotes: [
        {
          text: "The formulation of F(x) + x can be realized by feedforward neural networks with “shortcut connections”",
          page: 2,
        },
        {
          text: "In our case, the shortcut connections simply perform identity mapping, and their outputs are added to the outputs of the stacked layers",
          page: 2,
        },
      ],
    },
    { question_index: 4, answerable: false, answer: "The paper does not report energy consumption.", quotes: [] },
    {
      question_index: 5,
      answerable: true,
      answer: "(Fabricated quote, to test the not-found path.)",
      quotes: [{ text: "Residual networks were trained on a cluster of 512 TPUs for three weeks using the Adam optimizer.", page: 6 }],
    },
  ],
};
const QUESTIONS = [
  "Why do deeper plain networks perform worse?",
  "What error does the ensemble reach?",
  "How are shortcut connections implemented?",
  "How much energy does training use?",
  "What hardware was used?",
];

const toSse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const textReply = (text, usage = {}) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 400, ...usage } },
  { type: "message_stop" },
];
const start = { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 17000 } } };
const sse = toSse([start, ...textReply(JSON.stringify(ANSWERS))]);

// A web search question. The first reply searches and pauses (pause_turn);
// the resumed reply answers, citing one real search result and one made-up
// page that must be dropped.
const WEB_QUESTION = "Where is the official code released?";
const CODE_URL = "https://github.com/KaimingHe/deep-residual-networks";
const webPaused = toSse([
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me search for the code." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"resnet official code"}' } },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: CODE_URL, title: "KaimingHe/deep-residual-networks", encrypted_content: "enc", page_age: null }],
    },
  },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 50, server_tool_use: { web_search_requests: 1 } } },
  { type: "message_stop" },
]);
const webAnswer = toSse([
  start,
  ...textReply(
    JSON.stringify({
      answers: [
        {
          question_index: 1,
          answerable: true,
          answer: "The authors released their models on GitHub (from the web).",
          quotes: [],
          web_sources: [
            { url: `${CODE_URL}/`, title: "deep-residual-networks", quote: "Deep Residual Learning for Image Recognition" },
            { url: "https://example.com/made-up", title: "Made up", quote: "Not a real search result." },
          ],
        },
      ],
    }),
  ),
]);

// A free-form request spanning two lines, answered as a table without quotes.
const FREEFORM_REQUEST = "List the datasets used.\nFormat: a Markdown table with columns name | images";
const FREEFORM_ANSWER = "| name | images |\n|---|---|\n| ImageNet | 1.28M |\n| CIFAR-10 | 50k |";
const freeformReply = toSse([
  start,
  ...textReply(
    JSON.stringify({
      answers: [{ question_index: 1, answerable: true, answer: FREEFORM_ANSWER, quotes: [], web_sources: [] }],
    }),
  ),
]);

const server = createServer(async (req, res) => {
  res.writeHead(200, { "content-type": "application/pdf" });
  res.end(await readFile(PAPER));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: true,
  args: [...(process.env.CI ? ["--no-sandbox"] : []), "--window-size=1280,800", "--hide-scrollbars"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed = true;
    console.log(`✗ ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
};

try {
  const id = await browser.installExtension(EXTENSION);
  const viewer = `chrome-extension://${id}/vendor/pdfjs/web/viewer.html`;

  // Mock api.anthropic.com inside the service worker.
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(id));
  const cdp = (await swTarget.worker()).client;
  const apiCalls = [];
  cdp.on("Fetch.requestPaused", async (ev) => {
    const body = JSON.parse(ev.request.postData ?? "{}");
    apiCalls.push({ headers: ev.request.headers, body });
    const resumed = body.messages.at(-1).role === "assistant";
    const freeform = body.messages[0].content[1].text.includes("[free-form]");
    const reply = body.tools ? (resumed ? webAnswer : webPaused) : freeform ? freeformReply : sse;
    await cdp.send("Fetch.fulfillRequest", {
      requestId: ev.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: "text/event-stream" },
        { name: "access-control-allow-origin", value: "*" },
      ],
      body: Buffer.from(reply).toString("base64"),
    });
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.anthropic.com/*" }] });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.text().startsWith("Paper Q&A") && errors.push(m.text()));
  const status = () => page.$eval(".qa-status", (e) => e.textContent);

  await step("options page saves an API key", async () => {
    await page.goto(`chrome-extension://${id}/options/options.html`);
    // init() fills the key field from storage asynchronously and would
    // overwrite anything typed before it ran; the model list is filled after.
    await page.waitForSelector("#model option");
    await page.type("#apiKey", "sk-ant-test-key");
    await page.click("#save");
    await page.waitForFunction(() => document.querySelector("#saved").textContent === "Saved.");
    assert.equal(await page.$eval("#model", (e) => e.value), "claude-opus-5-5");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "screenshot-4-options.png") });
  });

  await step("viewer loads a web PDF and reads its text", async () => {
    await page.goto(`${viewer}?src=${encodeURIComponent(`${base}/resnet.pdf`)}`);
    await page.waitForFunction(() => /12 pages/.test(document.querySelector(".qa-status")?.textContent), { timeout: 30000 });
    assert.equal(await page.$eval(".qa-error", (e) => e.hidden), true, "unexpected error box");
  });

  await step("questions are answered and highlighted", async () => {
    await page.type(".qa-input", QUESTIONS.join("\n"));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "screenshot-1-ask.png") });
    await page.click(".qa-compose .qa-btn:not(.qa-primary)");
    assert.equal(await page.$$eval(".qa-card", (e) => e.length), 5);
    await page.click(".qa-primary");
    await page.waitForFunction(() => document.querySelectorAll(".qa-hl").length > 0, { timeout: 30000 });
    await sleep(1000);
    assert.equal(apiCalls.length, 1);
    const call = apiCalls[0];
    assert.equal(call.headers["anthropic-dangerous-direct-browser-access"], "true");
    assert.equal(call.headers["x-api-key"], "sk-ant-test-key");
    assert.equal(call.body.model, "claude-opus-5-5");
    assert.equal(call.body.output_config.format.type, "json_schema");
    assert.equal(call.body.tools, undefined, "web search tool sent without being asked for");
    const badges = await page.$$eval(".qa-quote", (els) => els.map((e) => e.querySelector(".qa-badge")?.textContent ?? "exact"));
    assert.deepEqual(badges, ["exact", "exact", "exact", "exact", "exact", "exact", "not found in text"]);
    const text = await page.$$eval('.page[data-page-number="1"] .qa-hl', (els) => els.map((e) => e.textContent).join(""));
    assert.match(text, /An ensemble of these residual nets achieves 3\.57% error/);
    assert.match(await status(), /Answered by claude-opus-5-5/);
    if (SHOTS) {
      await page.$eval(".qa-list", (e) => (e.scrollTop = 0));
      await page.screenshot({ path: join(SHOTS, "screenshot-2-answers.png") });
    }
  });

  await step("clicking a quote scrolls to and flashes it", async () => {
    const quotes = await page.$$(".qa-quote");
    await quotes[5].click();
    await page.waitForFunction(() => document.querySelectorAll(".qa-flash").length > 0, { timeout: 10000 });
    await sleep(1200); // smooth scroll
    const where = await page.$eval(".qa-flash", (el) => {
      const r = el.getBoundingClientRect();
      return { page: el.closest(".page").dataset.pageNumber, visible: r.top >= 0 && r.bottom <= innerHeight };
    });
    assert.deepEqual(where, { page: "2", visible: true });
  });

  await step("highlights survive zooming", async () => {
    const before = await page.$$eval(".qa-hl", (e) => e.length);
    await page.evaluate(() => (PDFViewerApplication.pdfViewer.currentScaleValue = "1.6"));
    await sleep(2000);
    assert.equal(await page.$$eval(".qa-hl", (e) => e.length), before);
    if (SHOTS) {
      const quotes = await page.$$(".qa-quote");
      await quotes[5].click();
      await sleep(1800);
      await page.screenshot({ path: join(SHOTS, "screenshot-3-zoom.png") });
    }
  });

  await step("reopening the PDF restores answers from cache without an API call", async () => {
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".qa-hl").length > 0, { timeout: 30000 });
    assert.match(await status(), /restored from cache/);
    assert.equal(apiCalls.length, 1);
  });

  await step("export produces a PDF", async () => {
    const cdpPage = await page.createCDPSession();
    await cdpPage.send("Browser.setDownloadBehavior", { behavior: "deny" });
    await page.evaluate(() => {
      window.__exported = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        window.__exported = blob.size;
        return orig(blob);
      };
    });
    await page.click(".qa-footer .qa-btn");
    await page.waitForFunction(() => window.__exported > 0, { timeout: 20000 });
    assert.equal(await page.$eval(".qa-error", (e) => e.hidden), true);
  });

  await step("Markdown export lists answers with quotes and pages", async () => {
    await page.evaluate(() => {
      window.__markdown = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        if (blob.type.startsWith("text/markdown")) blob.text().then((t) => (window.__markdown = t));
        return orig(blob);
      };
    });
    await page.click(".qa-footer .qa-btn:nth-child(2)");
    await page.waitForFunction(() => window.__markdown, { timeout: 10000 });
    const md = await page.evaluate(() => window.__markdown);
    assert.match(md, /^# .+\.pdf\n/);
    assert.match(md, /## 2\. What error does the ensemble reach\?\n\nAn ensemble of residual nets reaches 3\.57% error/);
    assert.match(md, /> “An ensemble of these residual nets achieves 3\.57% error on the ImageNet test set\.”\n>\n> — p\. 1\n/);
    assert.match(md, /## 4\. How much energy does training use\?\n\n\*\*Not answered in the paper\.\*\*/);
    assert.match(md, /— p\. 6 _\(not found in the PDF text\)_/);
  });

  await step("web search questions send the tool, resume after pause_turn and list verified sources", async () => {
    await page.click(".qa-options input");
    await page.type(".qa-input", WEB_QUESTION);
    await page.click(".qa-compose .qa-btn:not(.qa-primary)");
    await page.click(".qa-options input"); // off again for later questions
    await page.click(".qa-primary");
    await page.waitForFunction(() => document.querySelector(".qa-web-source"), { timeout: 30000 });
    const calls = apiCalls.slice(1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]);
    assert.match(calls[0].body.messages[0].content[1].text, /1\. \[web search allowed\] Where is the official code released\?/);
    const turn = calls[1].body.messages.at(-1).content;
    assert.deepEqual(
      turn.map((b) => b.type),
      ["text", "server_tool_use", "web_search_tool_result"],
    );
    assert.deepEqual(turn[1].input, { query: "resnet official code" });
    assert.equal(turn[2].content[0].encrypted_content, "enc");
    const sources = await page.$$eval(".qa-web-source", (els) => els.map((e) => [e.href, e.textContent]));
    assert.deepEqual(sources, [[CODE_URL, "github.comKaimingHe/deep-residual-networks“Deep Residual Learning for Image Recognition”"]]);
    assert.equal(await page.$$eval(".qa-card .qa-tag-q", (e) => e.length), 1);
    assert.match(await status(), /1 web search$/);
  });

  await step("free-form requests stay whole and are answered without quotes", async () => {
    await page.click(".qa-options label:nth-child(2) input");
    await page.type(".qa-input", FREEFORM_REQUEST);
    await page.click(".qa-compose .qa-btn:not(.qa-primary)");
    await page.click(".qa-options label:nth-child(2) input");
    assert.equal(await page.$$eval(".qa-card", (e) => e.length), 7, "a multi-line free-form request must be one question");
    await page.click(".qa-primary");
    await page.waitForFunction(() => document.querySelector(".qa-freeform"), { timeout: 30000 });
    const call = apiCalls.at(-1);
    assert.equal(call.body.max_tokens, 32000);
    assert.match(call.body.messages[0].content[1].text, /^Questions:\n1\. \[free-form\] List the datasets used\.\nFormat:/);
    assert.equal(await page.$eval(".qa-freeform", (e) => e.textContent), FREEFORM_ANSWER);
    const card = await page.$$eval(".qa-card", (els) => {
      const last = els.at(-1);
      return { quotes: last.querySelectorAll(".qa-quote").length, copy: last.querySelector(".qa-answer-actions button")?.textContent };
    });
    assert.deepEqual(card, { quotes: 0, copy: "Copy answer" });
  });

  await step("local file:// PDFs load (with file access allowed)", async () => {
    await page.goto(`${viewer}?src=${encodeURIComponent(`file://${PAPER}`)}`);
    await page.waitForFunction(() => /12 pages|Couldn't/.test(document.body.textContent), { timeout: 30000 });
    assert.match(await status(), /12 pages/);
  });

  await step("a PDF tab gets the offer banner, which opens the viewer", async () => {
    const tab = await browser.newPage();
    await tab.goto(`${base}/pdf/1512.03385`); // no .pdf extension: detected by content type
    await tab.waitForSelector("#paper-qa-offer", { timeout: 15000 });
    // The extension navigates the tab itself, which leaves puppeteer's handle
    // stale, so ask Chrome which tabs exist. The click is retried because the
    // first one occasionally lands while the PDF is still loading.
    const ext = await browser.newPage();
    await ext.goto(`chrome-extension://${id}/options/options.html`);
    const target = `${viewer}?src=${encodeURIComponent(`${base}/pdf/1512.03385`)}`;
    const opened = () => ext.evaluate(async (url) => (await chrome.tabs.query({})).some((t) => t.url === url), target);
    for (let attempt = 0; attempt < 3 && !(await opened()); attempt++) {
      // Bounded: once the tab has navigated, puppeteer's handle can hang.
      await Promise.race([tab.$eval("#paper-qa-offer button", (b) => b.click()).catch(() => {}), sleep(3000)]);
      for (let i = 0; i < 20 && !(await opened()); i++) await sleep(250);
    }
    assert.ok(await opened(), "viewer tab was not opened");
    await ext.close();
    await Promise.race([tab.close().catch(() => {}), sleep(3000)]);
  });

  await step("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
