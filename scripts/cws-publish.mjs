// Uploads a package to an existing Chrome Web Store item and submits it for
// review (Chrome Web Store API v2). Used by the release workflow.
//
//   CWS_CLIENT_ID=… CWS_CLIENT_SECRET=… CWS_REFRESH_TOKEN=… \
//   CWS_PUBLISHER_ID=… CWS_EXTENSION_ID=… node scripts/cws-publish.mjs dist/paper-qa-1.0.0.zip
//
// The item must already exist (the first version is uploaded by hand in the
// Developer Dashboard, where the listing and privacy tabs are filled in).

import { readFile } from "node:fs/promises";

const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const zipPath = process.argv[2];
if (!zipPath) throw new Error("usage: node scripts/cws-publish.mjs <package.zip>");

const API = "https://chromewebstore.googleapis.com";
const item = `publishers/${env("CWS_PUBLISHER_ID")}/items/${env("CWS_EXTENSION_ID")}`;

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}: ${text}`);
  return body;
}

const { access_token: token } = await call("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: env("CWS_CLIENT_ID"),
    client_secret: env("CWS_CLIENT_SECRET"),
    refresh_token: env("CWS_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  }),
});
const auth = { authorization: `Bearer ${token}` };

console.log(`Uploading ${zipPath}…`);
let upload = await call(`${API}/upload/v2/${item}:upload`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/zip" },
  body: await readFile(zipPath),
});
console.log(JSON.stringify(upload));

let state = upload.uploadState;
for (let i = 0; state === "IN_PROGRESS" && i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const status = await call(`${API}/v2/${item}:fetchStatus`, { headers: auth });
  state = status.lastAsyncUploadState ?? status.uploadState;
  console.log(`upload state: ${state}`);
}
if (state !== "SUCCEEDED") throw new Error(`Upload did not succeed (state: ${state}). See the response above.`);

console.log("Submitting for review…");
const published = await call(`${API}/v2/${item}:publish`, { method: "POST", headers: auth });
console.log(JSON.stringify(published));
console.log("Submitted. The new version goes live once Chrome Web Store review passes.");
