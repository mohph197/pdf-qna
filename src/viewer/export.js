// Writes highlights into a copy of the PDF as standard /Highlight annotations
// (with appearance streams, so every reader shows them), using pdf-lib.

const AP_OPACITY = 0.4;

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Quad for characters [start, end) of a text item, in PDF user space.
 * Character positions are interpolated linearly along the item's width.
 */
export function segmentQuad(item, start, end) {
  const [a, b, c, d, e, f] = item.transform;
  const scale = Math.hypot(a, b) || 1;
  const ux = a / scale;
  const uy = b / scale;
  const nx = -uy; // unit normal, pointing "up" from the baseline
  const ny = ux;
  const fontSize = Math.hypot(c, d) || item.height || 10;
  const len = item.str.length || 1;
  const t0 = (item.width * start) / len;
  const t1 = (item.width * end) / len;
  const top = fontSize * 0.9;
  const bottom = -fontSize * 0.25;
  const p = (t, s) => [e + ux * t + nx * s, f + uy * t + ny * s];
  // Order used by Acrobat and most readers: UL, UR, LL, LR.
  return [...p(t0, top), ...p(t1, top), ...p(t0, bottom), ...p(t1, bottom)];
}

function bbox(quads) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, q[i]);
      x1 = Math.max(x1, q[i]);
      y0 = Math.min(y0, q[i + 1]);
      y1 = Math.max(y1, q[i + 1]);
    }
  }
  return [x0, y0, x1, y1];
}

const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

/**
 * @param {Uint8Array} bytes  original PDF
 * @param {Array} pages       text items per page (with transform/width/height)
 * @param {Array<{color, segments, title, contents}>} highlights
 * @returns {Promise<Uint8Array>}
 */
export async function exportAnnotated(bytes, pages, highlights) {
  const { PDFDocument, PDFHexString, PDFString } = globalThis.PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) {
    throw new Error("this PDF is encrypted, and annotations can't be added to it without breaking it");
  }
  const ctx = doc.context;
  const pdfPages = doc.getPages();
  const gsRef = ctx.register(ctx.obj({ Type: "ExtGState", BM: "Multiply", ca: AP_OPACITY, CA: AP_OPACITY }));
  let serial = 0;

  for (const hl of highlights) {
    const byPage = new Map();
    for (const s of hl.segments) {
      const item = pages[s.page - 1]?.items[s.item];
      if (!item || !item.str.slice(s.start, s.end).trim()) continue; // skip pure whitespace
      if (!byPage.has(s.page)) byPage.set(s.page, []);
      byPage.get(s.page).push(segmentQuad(item, s.start, s.end));
    }
    const rgb = hexToRgb(hl.color);
    for (const [pageNumber, quads] of byPage) {
      const page = pdfPages[pageNumber - 1];
      if (!page) continue;
      const rect = bbox(quads);
      const path = quads
        .map((q) => `${fmt(q[0])} ${fmt(q[1])} m ${fmt(q[2])} ${fmt(q[3])} l ${fmt(q[6])} ${fmt(q[7])} l ${fmt(q[4])} ${fmt(q[5])} l h`)
        .join("\n");
      const apRef = ctx.register(
        ctx.stream(`/GS0 gs\n${rgb.map(fmt).join(" ")} rg\n${path}\nf\n`, {
          Type: "XObject",
          Subtype: "Form",
          BBox: rect,
          Resources: { ExtGState: { GS0: gsRef } },
        }),
      );
      const annot = ctx.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: rect,
        QuadPoints: quads.flat(),
        C: rgb,
        CA: AP_OPACITY,
        F: 4, // print
        T: PDFHexString.fromText(`Paper Q&A · ${hl.title}`),
        Contents: PDFHexString.fromText(hl.contents),
        NM: PDFHexString.fromText(`paper-qa-${Date.now().toString(36)}-${serial++}`),
        M: PDFString.fromDate(new Date()),
        P: page.ref,
        AP: { N: apRef },
      });
      page.node.addAnnot(ctx.register(annot));
    }
  }
  return doc.save();
}
