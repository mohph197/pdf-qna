// Tests lib/references.js: unit cases for reference parsing and paper ids,
// then every citation link in real PDFs. Each citation's destination must
// lead to the text of its bibliography entry, which must yield a lookup query.
//
//   node tests/references-test.mjs paper1.pdf [paper2.pdf …]

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { idsFromUrl, isCiteDestName, paperQuery, parseReference, referenceAt, titleFits } from "../lib/references.js";

let failed = false;
const check = (name, fn) => {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed = true;
    console.log(`✗ ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
};

check("parses numbered, author-year and quoted references", () => {
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

check("finds paper ids in URLs", () => {
  assert.deepEqual(idsFromUrl("https://arxiv.org/pdf/2005.14165v4"), { arxiv: "2005.14165" });
  assert.deepEqual(idsFromUrl("https://arxiv.org/abs/hep-th/9901001"), { arxiv: "hep-th/9901001" });
  assert.deepEqual(idsFromUrl("https://aclanthology.org/N19-1423.pdf"), { acl: "N19-1423" });
  assert.deepEqual(idsFromUrl("https://doi.org/10.1145/3065386"), { doi: "10.1145/3065386" });
  assert.deepEqual(idsFromUrl("https://dl.acm.org/doi/pdf/10.1145/3065386"), { doi: "10.1145/3065386" });
  assert.deepEqual(idsFromUrl("https://link.springer.com/content/pdf/10.1007/s11263-015-0816-y.pdf"), { doi: "10.1007/s11263-015-0816-y" });
  assert.deepEqual(idsFromUrl("http://127.0.0.1:8080/resnet.pdf"), {});
});

check("accepts a found title only when it fits the reference", () => {
  const ref = "[17] H. Jegou, M. Douze, and C. Schmid. Product quantization for nearest neighbor search. TPAMI, 33, 2011.";
  assert.ok(titleFits("Product Quantization for Nearest Neighbor Search", ref));
  assert.ok(!titleFits("Optimized Product Quantization", ref + " Unrelated."));
});

// Every cite.* destination linked from a paper, resolved like the viewer does.
const files = process.argv.slice(2);
const EXPECT = {
  "1512.03385.pdf": { arxiv: "1512.03385", "cite.Simonyan2015": "Very deep convolutional networks for large-scale image recognition" },
  "1810.04805.pdf": { arxiv: "1810.04805", "cite.mikolov-etal:2013": "Distributed representations of words and phrases and their compositionality" },
  "2005.14165.pdf": { arxiv: "2005.14165", "cite.vinyals2016matching": "Matching Networks for One Shot Learning" },
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
  check(`${basename(file)}: identifies the paper and resolves all ${names.size} cited references`, () => {
    if (expect.arxiv) assert.deepEqual(paperQuery({ url: "http://localhost/paper.pdf", pages }), { arxiv: expect.arxiv });
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
      if (name === "arxiv") continue;
      assert.equal(refs.get(name)?.query.title, title, name);
    }
  });
}

process.exit(failed ? 1 : 0);
