// Tests lib/references.js: unit cases for reference parsing and paper ids,
// then every citation link in real PDFs. Each citation's destination must
// lead to the text of its bibliography entry, which must yield a lookup query.
// Also tests background/scholar.js's lookups against a fake fetch (no
// network): source racing, fallbacks and picking a paper's published version.
//
//   node tests/references-test.mjs paper1.pdf [paper2.pdf …]

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { lookupPaper } from "../background/scholar.js";
import { idsFromUrl, isCiteDestName, paperQuery, parseReference, referenceAt, titleFits } from "../lib/references.js";

let failed = false;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed = true;
    console.log(`✗ ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
};

await check("parses numbered, author-year and quoted references", () => {
  assert.deepEqual(
    parseReference("[41] K. Simonyan and A. Zisserman. Very deep convolutional networks for large-scale image recognition. In ICLR, 2015."),
    { title: "Very deep convolutional networks for large-scale image recognition" },
  );
  assert.deepEqual(
    parseReference(
      "Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. 2019. BERT: Pre-training of deep bidirectional transformers for language understanding. In NAACL.",
    ),
    { title: "BERT: Pre-training of deep bidirectional transformers for language understanding" },
  );
  assert.deepEqual(
    parseReference("Vaswani, A., Shazeer, N., & Polosukhin, I. (2017). Attention is all you need. In Advances in NeurIPS (pp. 5998–6008)."),
    { title: "Attention is all you need" },
  );
  assert.deepEqual(
    parseReference('[3] A. Author, "Quoted titles win over sentence guessing," IEEE Trans. 12(3), 2020. doi:10.1109/5.771073.'),
    { doi: "10.1109/5.771073", title: "Quoted titles win over sentence guessing" },
  );
  assert.deepEqual(
    parseReference("[YdC+19] Dani Yogatama, Chris Dyer, et al. Learning and evaluating general linguistic intelligence. arXiv preprint arXiv:1901.11373, 2019."),
    { arxiv: "1901.11373", title: "Learning and evaluating general linguistic intelligence" },
  );
});

await check("finds paper ids in URLs", () => {
  assert.deepEqual(idsFromUrl("https://arxiv.org/pdf/2005.14165v4"), { arxiv: "2005.14165" });
  assert.deepEqual(idsFromUrl("https://arxiv.org/abs/hep-th/9901001"), { arxiv: "hep-th/9901001" });
  assert.deepEqual(idsFromUrl("https://aclanthology.org/N19-1423.pdf"), { acl: "N19-1423" });
  assert.deepEqual(idsFromUrl("https://doi.org/10.1145/3065386"), { doi: "10.1145/3065386" });
  assert.deepEqual(idsFromUrl("https://dl.acm.org/doi/pdf/10.1145/3065386"), { doi: "10.1145/3065386" });
  assert.deepEqual(idsFromUrl("https://link.springer.com/content/pdf/10.1007/s11263-015-0816-y.pdf"), { doi: "10.1007/s11263-015-0816-y" });
  assert.deepEqual(idsFromUrl("http://127.0.0.1:8080/resnet.pdf"), {});
});

await check("accepts a found title only when it fits the reference", () => {
  const ref = "[17] H. Jegou, M. Douze, and C. Schmid. Product quantization for nearest neighbor search. TPAMI, 33, 2011.";
  assert.ok(titleFits("Product Quantization for Nearest Neighbor Search", ref));
  assert.ok(!titleFits("Optimized Product Quantization", ref + " Unrelated."));
  // A longer title that contains the cited one is a different paper.
  assert.ok(!titleFits("Deep Residual Learning for Image Recognition: A Survey", "Deep residual learning for image recognition"));
  // Hyphenation joined across a line break still fits.
  assert.ok(titleFits("Very Deep Convolutional Networks for Large-Scale Image Recognition", "Very deep convolutional networks for largescale image recognition. In ICLR"));
});

// --- Lookups, with every API faked -------------------------------------------

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const work = (id, title, cited, extra = {}) => ({
  id: `https://openalex.org/${id}`,
  display_name: title,
  cited_by_count: cited,
  publication_year: 2016,
  authorships: [{ author: { display_name: "Kaiming He" } }],
  ...extra,
});
const crossrefItem = (doi, title, type = "proceedings-article") => ({ DOI: doi, title: [title], type });
const RESNET = "Deep Residual Learning for Image Recognition";

// routes: [[url prefix, () => Response]]; records every URL fetched.
function fakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new Error(`unexpected request ${url}`);
    return route[1](url);
  };
  return calls;
}
const memory = () => {
  const m = new Map();
  return { get: async (k) => ({ [k]: m.get(k) }), set: async (o) => Object.entries(o).forEach(([k, v]) => m.set(k, v)) };
};
const S2 = "https://api.semanticscholar.org/";
const CROSSREF = "https://api.crossref.org/";
const OPENALEX = "https://api.openalex.org/works/doi:";
const ARXIV = "https://export.arxiv.org/";
const busy = () => json({ message: "Too Many Requests" }, 429);
const none = () => json({ error: "not found" }, 404);

await check("lookups use Semantic Scholar when it answers", async () => {
  fakeFetch([
    [S2, () => json({ data: [{ paperId: "abc", title: RESNET, citationCount: 243353, tldr: { text: "Residual nets." } }] })],
    [CROSSREF, () => new Promise(() => {})], // slower than Semantic Scholar
    [ARXIV, () => new Promise(() => {})],
  ]);
  const paper = await lookupPaper({ title: RESNET, context: `K. He. ${RESNET}. In CVPR, 2016.` }, { storage: memory() });
  assert.equal(paper.source, "Semantic Scholar");
  assert.equal(paper.tldr, "Residual nets.");
});

await check("when Semantic Scholar is busy, Crossref and OpenAlex answer, skipping look-alike titles", async () => {
  const calls = fakeFetch([
    [S2, busy],
    [CROSSREF, () => json({ message: { items: [crossrefItem("10.3390/app1", `${RESNET}: A Survey`, "journal-article"), crossrefItem("10.1109/cvpr.2016.90", RESNET)] } })],
    [`${OPENALEX}10.1109/cvpr.2016.90`, () => json(work("W1", RESNET, 235023, { doi: "https://doi.org/10.1109/cvpr.2016.90", primary_location: { source: { display_name: "CVPR/Proceedings - CVPR", type: "conference" } } }))],
    [ARXIV, () => new Response("<feed></feed>")],
  ]);
  const paper = await lookupPaper({ title: RESNET, context: `[12] K. He, X. Zhang. ${RESNET}. In CVPR, 2016.` }, { storage: memory() });
  assert.deepEqual(
    [paper.source, paper.citations, paper.doi, paper.venue, paper.citationsUrl],
    ["OpenAlex", 235023, "10.1109/cvpr.2016.90", "CVPR", "https://openalex.org/works?filter=cites:W1"],
  );
  assert.match(paper.bibtex, /^@inproceedings\{he2016deep,\n {2}title = \{\{Deep Residual Learning/);
  assert.equal(calls.filter((u) => u.startsWith(S2)).length, 1, "a keyless 429 must not be retried");
});

await check("an arXiv preprint is shown with its published version's citations", async () => {
  fakeFetch([
    [S2, busy],
    [`${OPENALEX}10.48550/arxiv.1512.03385`, () => json(work("W2", RESNET, 4193, { doi: "https://doi.org/10.48550/arxiv.1512.03385" }))],
    [CROSSREF, () => json({ message: { items: [crossrefItem("10.1109/cvpr.2016.90", RESNET)] } })],
    [`${OPENALEX}10.1109/cvpr.2016.90`, () => json(work("W1", RESNET, 235023, { doi: "https://doi.org/10.1109/cvpr.2016.90" }))],
  ]);
  const paper = await lookupPaper({ arxiv: "1512.03385" }, { storage: memory() });
  assert.deepEqual([paper.citations, paper.doi, paper.arxiv], [235023, "10.1109/cvpr.2016.90", "1512.03385"]);
});

await check("papers without a DOI are found through arXiv's title search", async () => {
  const VGG = "Very Deep Convolutional Networks for Large-Scale Image Recognition";
  fakeFetch([
    [S2, busy],
    [CROSSREF, () => json({ message: { items: [] } })],
    [ARXIV, () => new Response(`<feed><entry><id>http://arxiv.org/abs/1409.1556v6</id><title>${VGG}</title></entry></feed>`)],
    [`${OPENALEX}10.48550/arxiv.1409.1556`, () => json(work("W3", VGG, 88465))],
  ]);
  const paper = await lookupPaper({ title: VGG.toLowerCase(), context: `[41] K. Simonyan. ${VGG}. In ICLR, 2015.` }, { storage: memory() });
  assert.deepEqual([paper.title, paper.arxiv, paper.citations], [VGG, "1409.1556", 88465]);
});

await check("not found when no source has it; an error only when every source failed", async () => {
  fakeFetch([[S2, busy], [CROSSREF, () => json({ message: { items: [] } })], [ARXIV, () => new Response("<feed></feed>")]]);
  assert.equal(await lookupPaper({ title: "No such paper here", context: "A. B. No such paper here. 2020." }, { storage: memory() }), null);
  fakeFetch([[S2, busy], [CROSSREF, () => json({}, 503)], [ARXIV, () => new Response("", { status: 503 })]]);
  await assert.rejects(lookupPaper({ title: "No such paper here", context: "No such paper here" }, { storage: memory() }), { code: "server" });
});

await check("found papers are cached", async () => {
  const storage = memory();
  fakeFetch([[S2, () => json({ data: [{ paperId: "abc", title: RESNET }] })], [CROSSREF, none], [ARXIV, none]]);
  await lookupPaper({ title: RESNET, context: RESNET }, { storage });
  const calls = fakeFetch([]);
  assert.equal((await lookupPaper({ title: RESNET, context: RESNET }, { storage })).title, RESNET);
  assert.deepEqual(calls, []);
});

// Every cite.* destination linked from a paper, resolved like the viewer does.
const files = process.argv.slice(2);
const EXPECT = {
  "1512.03385.pdf": {
    paper: { arxiv: "1512.03385", title: "Deep Residual Learning for Image Recognition" },
    "cite.Simonyan2015": "Very deep convolutional networks for large-scale image recognition",
  },
  "1810.04805.pdf": {
    paper: { arxiv: "1810.04805", title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding" },
    "cite.mikolov-etal:2013": "Distributed representations of words and phrases and their compositionality",
  },
  "2005.14165.pdf": {
    paper: { arxiv: "2005.14165", title: "Language Models are Few-Shot Learners" },
    "cite.vinyals2016matching": "Matching Networks for One Shot Learning",
  },
};
for (const file of files) {
  const pdf = await getDocument({ data: new Uint8Array(await readFile(file)), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  const names = new Set();
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    pages.push({ items: tc.items.filter((it) => it.str !== undefined) });
    for (const a of await page.getAnnotations()) if (isCiteDestName(a.dest)) names.add(a.dest);
  }
  const refs = new Map();
  for (const name of names) {
    const dest = await pdf.getDestination(name);
    const ref = referenceAt(pages, await pdf.getPageIndex(dest[0]), dest[2], dest[3]);
    refs.set(name, ref && { ...ref, query: parseReference(ref.text) });
  }
  const expect = EXPECT[basename(file)] ?? {};
  await check(`${basename(file)}: identifies the paper and resolves all ${names.size} cited references`, () => {
    if (expect.paper) assert.deepEqual(paperQuery({ url: "http://localhost/paper.pdf", pages }), expect.paper);
    assert.ok(names.size > 20, "too few citation links found");
    const bad = [...refs].filter(([, r]) => !r || !(r.query.title || r.query.arxiv || r.query.doi));
    assert.deepEqual(
      bad.map(([n, r]) => `${n}: ${r?.text ?? "no text at destination"}`),
      [],
      "references without a usable query",
    );
    // Entries never run into the next one.
    const long = [...refs].filter(([, r]) => r.text.length > 450);
    assert.deepEqual(long.map(([n, r]) => `${n}: ${r.text}`), [], "suspiciously long references");
    for (const [name, title] of Object.entries(expect)) {
      if (name === "paper") continue;
      assert.equal(refs.get(name)?.query.title, title, name);
    }
  });
}

process.exit(failed ? 1 : 0);
