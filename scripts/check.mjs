// Static checks run in CI: JS syntax, manifest/package version agreement,
// and every file the manifest references exists.
//   node scripts/check.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const errors = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (["node_modules", "vendor", "dist", ".git", "tests/papers"].some((x) => relative(root, path) === x)) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(m?js)$/.test(name)) out.push(path);
  }
  return out;
}

for (const file of walk(root)) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    errors.push(`${relative(root, file)}: ${e.stderr.toString().trim().split("\n").slice(0, 4).join(" | ")}`);
  }
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  errors.push(`manifest.json version ${manifest.version} != package.json version ${pkg.version}`);
}
const referenced = [
  manifest.background?.service_worker,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  "vendor/pdfjs/web/viewer.html",
  "vendor/pdfjs/build/pdf.mjs",
  "vendor/pdfjs/build/pdf.worker.mjs",
  "vendor/pdf-lib/pdf-lib.min.js",
].filter(Boolean);
for (const f of referenced) if (!existsSync(join(root, f))) errors.push(`missing file referenced by the extension: ${f}`);

const viewer = readFileSync(join(root, "vendor/pdfjs/web/viewer.html"), "utf8");
for (const needle of ["src/viewer/boot.mjs", "src/viewer/qa.mjs", "src/viewer/qa.css", "connect-src * blob: data: file:"]) {
  if (!viewer.includes(needle)) errors.push(`vendor/pdfjs/web/viewer.html is not patched (missing ${needle}); run scripts/vendor.sh`);
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`✓ checks passed (version ${manifest.version})`);
