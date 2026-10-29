// End-to-end test: loads the unpacked extension into headless Chrome, opens
// a real paper, answers questions with a mocked Claude API, and checks
// highlights, quote navigation, zoom, cache restore, local files, the
// "open in Paper Q&A" offer, readable viewer URLs, "always open" mode and
// going back to Chrome's viewer, asking about selected text, the Implement
// tab's implementation prompts, and citation previews (linked and plain-text)
// and paper info with a mocked Semantic Scholar API.
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
import { runInThisContext } from "node:vm";
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

// A question about text selected in the PDF.
const SELECTION_QUESTION = "What does this mean?";
const selectionReply = toSse([
  start,
  ...textReply(
    JSON.stringify({
      answers: [
        {
          question_index: 1,
          answerable: true,
          answer: "It names the paper's topic: training very deep networks with residual learning.",
          quotes: [{ text: "An ensemble of these residual nets achieves 3.57% error on the ImageNet test set.", page: 1 }],
          web_sources: [],
        },
      ],
    }),
  ),
]);

// The Implement tab. The paper's systems are listed; the reader picks the
// second, and the prompt is written after a web search (paused turn) and a
// fetch of the official README. One cited page was neither, so it is dropped.
const SYSTEMS = [
  { name: "Deep residual networks for ImageNet", kind: "architecture", summary: "ResNet-18 to ResNet-152 with bottleneck blocks.", pages: [4, 5, 99] },
  { name: "Residual networks for CIFAR-10", kind: "architecture", summary: "6n+2-layer residual nets for 32×32 images.", pages: [7] },
];
const IMPLEMENT_NOTES = "PyTorch, a single GPU";
const README_URL = `${CODE_URL}/blob/master/README.md`;
const IMPL_PROMPT = "# Goal\n\nReimplement the CIFAR-10 residual networks of He et al. (2015).\n\n## Specification\n\n| depth | 6n+2 |\n|---|---|";
const systemsReply = toSse([start, ...textReply(JSON.stringify({ systems: SYSTEMS }))]);
const implementPaused = webPaused.replace("resnet official code", "resnet cifar-10 official code");
const implementAnswer = toSse([
  start,
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_2", name: "web_fetch", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ url: README_URL }) } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "web_fetch_tool_result",
      tool_use_id: "srvtoolu_2",
      content: {
        type: "web_fetch_result",
        url: README_URL,
        content: { type: "document", source: { type: "text", media_type: "text/plain", data: "Deep Residual Networks" }, title: "README.md" },
      },
    },
  },
  { type: "content_block_stop", index: 1 },
  ...textReply(
    JSON.stringify({
      prompt: IMPL_PROMPT,
      web_sources: [
        { url: README_URL, title: "README" },
        { url: CODE_URL, title: "Code" },
        { url: "https://example.com/made-up", title: "Made up" },
      ],
    }),
    { server_tool_use: { web_fetch_requests: 1 } },
  ),
]);

// Mocked paper lookups. Semantic Scholar knows the open paper (found by the
// arXiv stamp on its first page) but is "busy" for title searches, so the
// cited paper comes from arXiv's title search plus OpenAlex. Crossref has
// neither (VGG was published at ICLR, which has no DOIs).
const VGG = "Very Deep Convolutional Networks for Large-Scale Image Recognition";
const LOOKUPS = {
  "https://api.semanticscholar.org/graph/v1/paper/ARXIV:1512.03385": {
    paperId: "2c03df8b48bf3fa39054345bafabfeff15bfd11d",
    title: "Deep Residual Learning for Image Recognition",
    url: "https://www.semanticscholar.org/paper/2c03df8b48bf3fa39054345bafabfeff15bfd11d",
    authors: [{ name: "Kaiming He" }, { name: "X. Zhang" }, { name: "Shaoqing Ren" }, { name: "Jian Sun" }],
    venue: "Computer Vision and Pattern Recognition",
    publicationVenue: { name: "Computer Vision and Pattern Recognition", alternate_names: ["CVPR"] },
    year: 2015,
    citationCount: 243353,
    influentialCitationCount: 33155,
    referenceCount: 54,
    tldr: { text: "This work presents a residual learning framework." },
    abstract: "Deeper neural networks are more difficult to train.",
    externalIds: { ArXiv: "1512.03385", DOI: "10.1109/cvpr.2016.90" },
    citationStyles: { bibtex: "@inproceedings{He2015DeepRL}" },
  },
  "https://api.semanticscholar.org/graph/v1/paper/search/match": { status: 429, body: { message: "Too Many Requests" } },
  "https://api.crossref.org/works": { message: { items: [] } },
  "https://export.arxiv.org/api/query": {
    type: "application/atom+xml",
    body: `<feed><entry><id>http://arxiv.org/abs/1409.1556v6</id><title>${VGG}</title></entry></feed>`,
  },
  "https://api.openalex.org/works/doi:10.48550/arxiv.1409.1556": {
    id: "https://openalex.org/W1686810756",
    doi: "https://doi.org/10.48550/arxiv.1409.1556",
    display_name: VGG,
    publication_year: 2014,
    cited_by_count: 88465,
    authorships: [{ author: { display_name: "Karen Simonyan" } }, { author: { display_name: "Andrew Zisserman" } }],
    primary_location: { source: { display_name: "arXiv (Cornell University)", type: "repository" } },
  },
};

// The paper without its link annotations, like PDFs from archives that strip
// them: its numbered citations ("[41]") are plain text.
// pdf-lib is a UMD script (package.json makes .js files ES modules here).
runInThisContext(await readFile(join(ROOT, "vendor/pdf-lib/pdf-lib.min.js"), "utf8"));
const { PDFDocument, PDFName } = globalThis.PDFLib;
const unlinkedDoc = await PDFDocument.load(await readFile(PAPER));
for (const p of unlinkedDoc.getPages()) p.node.delete(PDFName.of("Annots"));
// A new file ID, so pdf.js doesn't restore the original's zoom and position.
unlinkedDoc.context.trailerInfo.ID = undefined;
const UNLINKED = Buffer.from(await unlinkedDoc.save());

const server = createServer(async (req, res) => {
  res.writeHead(200, { "content-type": "application/pdf" });
  res.end(req.url === "/unlinked.pdf" ? UNLINKED : await readFile(PAPER));
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
  const lookupCalls = [];
  cdp.on("Fetch.requestPaused", async (ev) => {
    if (!ev.request.url.startsWith("https://api.anthropic.com/")) {
      const url = new URL(ev.request.url);
      lookupCalls.push(url);
      const mock = LOOKUPS[decodeURIComponent(url.origin + url.pathname)];
      const wrapped = mock?.status || mock?.type;
      const body = wrapped ? mock.body : (mock ?? { error: "not found" });
      await cdp.send("Fetch.fulfillRequest", {
        requestId: ev.requestId,
        responseCode: wrapped ? (mock.status ?? 200) : mock ? 200 : 404,
        responseHeaders: [{ name: "content-type", value: mock?.type ?? "application/json" }],
        body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64"),
      });
      return;
    }
    const body = JSON.parse(ev.request.postData ?? "{}");
    apiCalls.push({ headers: ev.request.headers, body });
    const resumed = body.messages.at(-1).role === "assistant";
    const questions = body.messages[0].content[1].text;
    const schema = body.output_config?.format?.schema?.properties ?? {};
    const reply = schema.systems
      ? systemsReply
      : schema.prompt
        ? resumed
          ? implementAnswer
          : implementPaused
        : body.tools
      ? resumed
        ? webAnswer
        : webPaused
      : questions.includes("[free-form]")
        ? freeformReply
        : questions.includes("[about selection]")
          ? selectionReply
          : sse;
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
  await cdp.send("Fetch.enable", {
    patterns: [
      "https://api.anthropic.com/*",
      "https://api.semanticscholar.org/*",
      "https://api.crossref.org/*",
      "https://api.openalex.org/*",
      "https://export.arxiv.org/*",
    ].map((urlPattern) => ({ urlPattern })),
  });

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
    if (SHOTS) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(SHOTS, "screenshot-4-options.png") });
    }
  });

  await step("viewer loads a web PDF and reads its text", async () => {
    await page.goto(`${viewer}?src=${encodeURIComponent(`${base}/resnet.pdf`)}`);
    await page.waitForFunction(() => /12 pages/.test(document.querySelector(".qa-status")?.textContent), { timeout: 30000 });
    assert.equal(await page.$eval(".qa-error", (e) => e.hidden), true, "unexpected error box");
    // The address bar shows the PDF's own URL.
    assert.equal(page.url(), `chrome-extension://${id}/${base}/resnet.pdf`);
  });

  await step("the paper info button shows the open paper", async () => {
    await page.click("#qaInfoButton");
    await page.waitForSelector(".qa-pop .qa-paper-title", { timeout: 10000 });
    const card = await page.$eval(".qa-pop", (e) => ({
      title: e.querySelector(".qa-paper-title").textContent,
      venue: e.querySelector(".qa-paper-venue").textContent,
      stats: e.querySelector(".qa-paper-stats").textContent,
      links: [...e.querySelectorAll(".qa-pop-links a")].map((a) => a.textContent),
    }));
    assert.deepEqual(card, {
      title: "Deep Residual Learning for Image Recognition",
      venue: "Computer Vision and Pattern Recognition (CVPR) · 2015",
      stats: "Cited by 243,353 · 33,155 influential · 54 references",
      links: ["Google Scholar", "Semantic Scholar", "arXiv", "DOI", "Open in Paper Q&A"],
    });
    assert.ok(lookupCalls.some((u) => decodeURIComponent(u.pathname) === "/graph/v1/paper/ARXIV:1512.03385"));
    assert.equal(await page.$eval(".qa-pop-source", (e) => e.textContent), "Data from Semantic Scholar");
    await page.keyboard.press("Escape");
    assert.equal(await page.$(".qa-pop"), null);
  });

  await step("hovering a citation looks it up; clicking shows the cited paper instead of jumping", async () => {
    const before = await page.evaluate(() => PDFViewerApplication.page);
    const link = '.annotationLayer [data-internal-link] a[href*="cite.Simonyan2015"]';
    await page.waitForSelector(link, { timeout: 10000 });
    // Pointing at the citation starts the lookup, before any click.
    await page.hover(link);
    const fetched = () => lookupCalls.some((u) => u.pathname.endsWith("/doi:10.48550/arxiv.1409.1556"));
    for (let i = 0; i < 40 && !fetched(); i++) await sleep(250);
    assert.ok(fetched(), "hovering didn't start the lookup");
    const match = lookupCalls.find((u) => u.pathname === "/graph/v1/paper/search/match");
    assert.equal(match.searchParams.get("query"), "Very deep convolutional networks for large-scale image recognition");
    const callsBefore = lookupCalls.length;
    await page.click(link);
    await page.waitForSelector(".qa-pop .qa-paper-title", { timeout: 10000 });
    const card = await page.$eval(".qa-pop", (e) => ({
      title: e.querySelector(".qa-paper-title").textContent,
      stats: e.querySelector(".qa-paper-stats").textContent,
      links: [...e.querySelectorAll(".qa-pop-links a")].map((a) => a.textContent),
      source: e.querySelector(".qa-pop-source").textContent,
    }));
    // Semantic Scholar was busy, so the card comes from arXiv and OpenAlex.
    assert.deepEqual(card, {
      title: VGG,
      stats: "Cited by 88,465",
      links: ["Google Scholar", "OpenAlex", "arXiv", "DOI", "Open in Paper Q&A"],
      source: "Data from OpenAlex",
    });
    assert.equal(lookupCalls.length, callsBefore, "the click looked the paper up again");
    assert.equal(await page.evaluate(() => PDFViewerApplication.page), before, "the citation link navigated");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "screenshot-5-citation.png") });
    // "Go to reference" still takes you to the bibliography entry.
    await page.click(".qa-pop-actions .qa-link");
    await page.waitForFunction(() => PDFViewerApplication.page === 9, { timeout: 10000 });
    assert.equal(await page.$(".qa-pop"), null);
    await page.evaluate(() => (PDFViewerApplication.page = 1));
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
    // Reloading the readable URL goes through the service worker's router.
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".qa-hl").length > 0, { timeout: 30000 });
    assert.match(await status(), /restored from cache/);
    assert.equal(apiCalls.length, 1);
    assert.equal(page.url(), `chrome-extension://${id}/${base}/resnet.pdf`);
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

  await step("selected text in the PDF can be asked about", async () => {
    await page.evaluate(() => (PDFViewerApplication.page = 1));
    await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { timeout: 10000 });
    // Select a whole line of the title area that has no highlight in it.
    const selected = await page.evaluate(() => {
      const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span:not(.qa-hl)')].find((s) => {
        const r = s.getBoundingClientRect();
        return s.textContent.trim().length > 20 && !s.querySelector(".qa-hl") && r.top > 0 && r.bottom < innerHeight;
      });
      const range = document.createRange();
      range.selectNodeContents(span);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return span.textContent.replace(/\s+/g, " ").trim();
    });
    await page.waitForSelector(".qa-sel-ask:not([hidden])", { timeout: 5000 });
    await page.click(".qa-sel-ask");
    assert.equal(await page.$eval(".qa-context", (e) => e.hidden), false);
    assert.equal(await page.$eval(".qa-context .qa-page", (e) => e.textContent), "About p. 1");
    assert.equal(await page.$eval(".qa-sel-ask", (e) => e.hidden), true);
    assert.equal(await page.evaluate(() => document.activeElement.className), "qa-input");
    await page.type(".qa-input", SELECTION_QUESTION);
    await page.click(".qa-compose .qa-btn:not(.qa-primary)");
    assert.equal(await page.$eval(".qa-context", (e) => e.hidden), true, "the selection must not stick to later questions");
    await page.click(".qa-primary");
    await page.waitForFunction(() => document.querySelectorAll(".qa-card")[7]?.querySelector(".qa-quote"), { timeout: 30000 });
    const call = apiCalls.at(-1);
    assert.equal(
      call.body.messages[0].content[1].text,
      `Questions:\n1. [about selection] ${SELECTION_QUESTION}\n<selection page="1">\n${selected}\n</selection>`,
    );
    const about = await page.$$eval(".qa-card", (els) => els.at(-1).querySelector(".qa-about")?.textContent);
    assert.equal(about, `About p. 1“${selected}”`);
    // The selection is cached with the question and exported.
    await page.evaluate(() => (window.__markdown = null));
    await page.click(".qa-footer .qa-btn:nth-child(2)");
    await page.waitForFunction(() => window.__markdown, { timeout: 10000 });
    const md = await page.evaluate(() => window.__markdown);
    assert.ok(md.includes(`## 8. ${SELECTION_QUESTION}\n\nAbout the selected text on p. 1:\n\n> “${selected}”\n`), md.slice(-600));
  });

  await step("the Implement tab lists the paper's systems, lets the reader pick one and writes a prompt", async () => {
    const before = apiCalls.length;
    const tab = (name) => page.$eval(`.qa-tab[aria-selected="true"]`, (e) => e.textContent).then((t) => t === name);
    await page.click(".qa-tab:nth-child(2)");
    assert.ok(await tab("Implement"));
    assert.deepEqual(await page.$$eval(".qa-panel", (els) => els.map((e) => e.hidden)), [true, false]);
    await page.type(".qa-impl-notes", IMPLEMENT_NOTES);
    await page.click(".qa-impl .qa-primary");
    await page.waitForSelector(".qa-impl-system", { timeout: 30000 });
    const choices = await page.$$eval(".qa-impl-system", (els) => els.map((e) => e.textContent));
    assert.deepEqual(choices, [
      "Deep residual networks for ImageNetarchitectureResNet-18 to ResNet-152 with bottleneck blocks.pp. 4, 5",
      "Residual networks for CIFAR-10architecture6n+2-layer residual nets for 32×32 images.pp. 7",
    ]);
    assert.equal(apiCalls.length, before + 1);
    const find = apiCalls.at(-1).body;
    assert.equal(find.tools, undefined, "listing the systems must not search the web");
    assert.equal(find.messages[0].content[1].text, "List the systems this paper implements.");
    assert.ok(find.messages[0].content[0].cache_control, "the paper must be cached");

    const shots = SHOTS ? join(SHOTS, "screenshot-6-implement.png") : null;
    await (await page.$$(".qa-impl-system"))[1].click();
    await page.waitForSelector(".qa-impl-prompt", { timeout: 30000 });
    const calls = apiCalls.slice(before + 1);
    assert.equal(calls.length, 2, "the paused web turn must be resumed");
    assert.deepEqual(calls[0].body.tools, [
      { type: "web_search_20260209", name: "web_search", max_uses: 5 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
    ]);
    assert.equal(calls[0].body.max_tokens, 64000);
    const ask = calls[0].body.messages[0].content[1].text;
    assert.match(ask, /^<target>\[web search allowed\] Residual networks for CIFAR-10 \(architecture\): 6n\+2-layer residual nets for 32×32 images\. \(described on pp\. 7\)<\/target>/);
    assert.match(ask, /The paper's other systems:\n- Deep residual networks for ImageNet \(architecture\)/);
    assert.match(ask, /<notes>\nPyTorch, a single GPU\n<\/notes>/);
    assert.equal(await page.$eval(".qa-impl-prompt", (e) => e.textContent), IMPL_PROMPT);
    assert.equal(await page.$eval(".qa-impl-head strong", (e) => e.textContent), "Prompt for Residual networks for CIFAR-10");
    const sources = await page.$$eval(".qa-impl-sources a", (els) => els.map((e) => [e.href, e.textContent]));
    assert.deepEqual(sources, [
      [README_URL, "README.md"],
      [CODE_URL, "KaimingHe/deep-residual-networks"],
    ]);
    assert.match(await page.$eval(".qa-impl-status", (e) => e.textContent), /1 web search · 1 page fetched$/);
    assert.equal(await page.$$eval(".qa-card", (e) => e.length), 8, "the Q&A cards must not change");
    if (shots) await page.screenshot({ path: shots });

    // Copy and download.
    await page.evaluate(() => {
      window.__prompt = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        if (blob.type.startsWith("text/markdown")) blob.text().then((t) => (window.__prompt = t));
        return orig(blob);
      };
    });
    await page.click(".qa-impl-actions .qa-btn:nth-child(2)");
    await page.waitForFunction(() => window.__prompt, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__prompt), `${IMPL_PROMPT}\n`);

    // The other system can still be chosen, and everything is cached.
    await page.click(".qa-impl-head .qa-link");
    assert.equal(await page.$$eval(".qa-impl-system", (e) => e.length), 2);
    await page.click(".qa-impl-back");
    await page.reload();
    await page.waitForSelector(".qa-impl-prompt", { timeout: 30000 });
    assert.ok(await tab("Implement"), "the open tab must be remembered");
    assert.equal(await page.$eval(".qa-impl-notes", (e) => e.value), IMPLEMENT_NOTES);
    assert.equal(apiCalls.length, before + 3);
    await page.click(".qa-tab:nth-child(1)");
    assert.deepEqual(await page.$$eval(".qa-panel", (els) => els.map((e) => e.hidden)), [false, true]);
  });

  await step("plain-text numbered citations work like links in PDFs without them", async () => {
    await page.goto(`${viewer}?src=${encodeURIComponent(`${base}/unlinked.pdf`)}`);
    await page.waitForFunction(() => /12 pages/.test(document.querySelector(".qa-status")?.textContent), { timeout: 30000 });
    // The centre of "41" in the first "[41]" in the text layer, once the
    // page has rendered and the point hits that text.
    const citeAt = () => page.waitForFunction(
      () => {
        for (const span of document.querySelectorAll(".textLayer span")) {
          const i = span.textContent.indexOf("[41]");
          if (i < 0 || !span.firstChild) continue;
          span.scrollIntoView({ block: "center" });
          const range = document.createRange();
          range.setStart(span.firstChild, i + 1);
          range.setEnd(span.firstChild, i + 3);
          const r = range.getBoundingClientRect();
          const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          return document.elementFromPoint(point.x, point.y) === span && point;
        }
        return null;
      },
      { timeout: 10000, polling: 250 },
    );
    const { x, y } = await (await citeAt()).jsonValue();
    await page.mouse.move(x, y);
    await page.waitForSelector(".textLayer span.qa-cite-text", { timeout: 5000 });
    const before = await page.evaluate(() => PDFViewerApplication.page);
    await citeAt();
    await page.mouse.click(x, y);
    await page.waitForSelector(".qa-pop .qa-paper-title", { timeout: 10000 });
    assert.equal(await page.$eval(".qa-pop .qa-paper-title", (e) => e.textContent), VGG);
    assert.equal(await page.evaluate(() => PDFViewerApplication.page), before, "the click navigated");
    await page.click(".qa-pop-actions .qa-link");
    await page.waitForFunction(() => PDFViewerApplication.page === 9, { timeout: 10000 });
    // Plain text elsewhere isn't a citation.
    await page.mouse.move(5, 5);
    assert.equal(await page.$(".textLayer span.qa-cite-text"), null);
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
    const target = `chrome-extension://${id}/${base}/pdf/1512.03385`; // the viewer's readable URL
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

  await step('"always open" mode opens PDFs in the viewer straight away', async () => {
    const ext = await browser.newPage();
    await ext.goto(`chrome-extension://${id}/options/options.html`);
    await ext.evaluate(() => chrome.storage.local.set({ openMode: "always" }));
    const pdfUrl = `${base}/pdf/2005.14165?always#page=2`;
    const pretty = `chrome-extension://${id}/${pdfUrl}`;
    const shown = () => ext.evaluate(async (url) => (await chrome.tabs.query({})).some((t) => t.url === url), pretty);
    try {
      // Opened by the extension page, so puppeteer never holds the tab.
      await ext.evaluate((url) => chrome.tabs.create({ url, active: false }), pdfUrl);
      for (let i = 0; i < 60 && !(await shown()); i++) await sleep(250);
      assert.ok(await shown(), "the PDF was not opened in the viewer");
    } finally {
      await ext.evaluate(async (url) => {
        await chrome.storage.local.set({ openMode: "ask" });
        const tabs = await chrome.tabs.query({});
        await chrome.tabs.remove(tabs.filter((t) => t.url === url).map((t) => t.id));
      }, pretty);
      await ext.close();
    }
  });

  await step("Chrome's PDF viewer can be made the default again from the viewer and the options page", async () => {
    const openMode = () => page.evaluate(async () => (await chrome.storage.local.get("openMode")).openMode);
    const note = () => page.$eval(".qa-viewer-note", (e) => (e.hidden ? null : e.textContent));
    assert.equal(await note(), null, "the note must only show in always mode");
    await page.evaluate(() => chrome.storage.local.set({ openMode: "always" }));
    await page.waitForSelector(".qa-viewer-note:not([hidden])", { timeout: 5000 });
    assert.equal(await note(), "Paper Q&A opens every PDF. Use Chrome's PDF viewer again");
    await page.click(".qa-viewer-note button");
    await page.waitForFunction(() => /default again/.test(document.querySelector(".qa-viewer-note").textContent));
    assert.equal(await openMode(), "ask");
    assert.equal(await note(), "Chrome's PDF viewer is the default again. Open this PDF there");

    const ext = await browser.newPage();
    try {
      await ext.goto(`chrome-extension://${id}/options/options.html`);
      await ext.evaluate(() => chrome.storage.local.set({ openMode: "always" }));
      await ext.reload();
      await ext.waitForSelector("#restoreViewerRow:not([hidden])", { timeout: 5000 });
      await ext.click("#restoreViewer");
      await ext.waitForFunction(() => document.querySelector("#restoredViewer").textContent);
      assert.equal(await ext.$eval("#openMode", (e) => e.value), "ask");
      assert.equal(await openMode(), "ask");
    } finally {
      await ext.close();
    }
  });

  await step("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
