# Paper Q&A: working agreement

Chrome MV3 extension: a pdf.js viewer with a sidebar that asks Claude about the open PDF and highlights verbatim quotes. See README.md for architecture. This file covers **how to make changes**.

## Workflow for every change

`main` is protected by a ruleset: no direct pushes, no force pushes, squash-merge PRs only, and the `Check, test and package` CI job must pass. Never try to get around it.

1. **Start from fresh main on a branch.** Run `git switch main && git pull --ff-only`, then `git switch -c <type>/<short-kebab-description>`, for example `fix/matcher-soft-hyphen`.
2. **Implement.** Match the surrounding code and keep the no-build-step design: plain ES modules, no bundler, no runtime npm dependencies.
3. **Test locally** (Node 20+ and Chrome required):
   - Always run `npm run check`.
   - If you touched `lib/matcher.js` or text extraction in `src/viewer/qa.mjs`, run `npm run test:matcher`. The pass count must not drop below the README's figure; currently 1250/1260.
   - If you touched `lib/references.js` (citation previews, paper info), run `npm run test:references`.
   - If you touched the viewer, background, options, manifest or `vendor/`, run `npm run test:e2e`.
   - Add or extend tests for new behavior. The end-to-end test mocks the Claude API in the service worker; tests must never make real API calls or use a real key.
4. **Commit** with Conventional Commit messages (see below). End each commit message with the `Co-Authored-By` trailer.
5. **Push and open a PR**: `git push -u origin <branch>`, then `gh pr create --base main --title "<conventional title>" --body …`. The body says what changed, why, and how it was tested, and ends with the Claude Code footer.
6. **Wait for CI** with `gh pr checks <n> --watch`. If a check fails, fix it with new commits on the branch. Never weaken a test to make it pass.
7. **Merge only when the user asks**, using `gh pr merge <n> --squash --delete-branch`. Then run `git switch main && git pull --ff-only`.

## PR titles drive releases

Squash merging makes the **PR title** the commit on `main`. release-please reads those titles to choose the next version, and the `Conventional PR title` check enforces the format. Pick the type by what changes **for users of the extension**:

| Type | Use for | Release |
| --- | --- | --- |
| `feat:` | new user-visible capability | minor |
| `fix:` | user-visible bug fix | patch |
| `perf:` | faster or lighter, same behavior | patch |
| `feat!:` / `fix!:` | breaking change: settings or cache format reset, removed feature | major |
| `docs:` `test:` `ci:` `chore:` `refactor:` | docs, tests, workflows, tooling, deps, internal cleanups | none |

An optional scope is welcome, for example `fix(matcher): …` or `feat(sidebar): …`. Write the title as a changelog line a user would understand.

## Releases: release-please owns them

- **Never** bump `version` in `manifest.json` or `package.json`, edit released sections of `CHANGELOG.md`, create tags, or run `gh release create` by hand. release-please does all of this in its "chore: release X.Y.Z" PR.
- **Never merge a release PR unless the user explicitly asks.** Merging it tags the version, creates the GitHub release and, once configured, submits to the Chrome Web Store.
- When the user asks to release, check that the release PR's CI passed, then squash-merge it. Afterwards, confirm the Release workflow attached `paper-qa-X.Y.Z.zip` to the GitHub release.

## Ask the user first

- Changing repository settings, rulesets, secrets, variables or Actions permissions.
- Anything that touches the Chrome Web Store: the developer dashboard, listing, or publishing credentials.
- Adding a manifest permission or host permission. Each one lengthens store review and must be justified. If you add one, also update the permission table in `store/LISTING.md`, and update `PRIVACY.md` if it changes what data is handled or where it is sent.
- Adding a runtime dependency, or anything loaded from a CDN. Store policy forbids remote code; everything ships in the package.

## Project gotchas

- **`vendor/` is generated.** Never hand-edit it. Change `scripts/vendor.sh`, which pins pdf.js and pdf-lib, patches `viewer.html` and strips unused files, and run it. When bumping pdf.js, bump `pdfjs-dist` in `package.json` to the same version.
- **Text layer alignment.** Highlights map text-content item `i` to span `i`. Text must be extracted with `{ includeMarkedContent: true, disableNormalization: true }`, keeping only items that have `str`. pdf.js doesn't put empty-string items in the DOM. If you change extraction, check that the viewer logs no "text layer has N spans" warnings.
- **The viewer's CSP has no inline styles.** Build DOM with the `h()` helper in `qa.mjs` and set styles through `el.style.setProperty(...)`, never with `style="…"` in HTML strings.
- **pdf.js detaches buffers.** Pass `bytes.slice()` to `PDFViewerApplication.open`.
- **The API key stays in the service worker.** Only `background/` talks to `api.anthropic.com`; the viewer page never sees the key. Keep the `anthropic-dangerous-direct-browser-access` header, structured output, and server-side `fallbacks`.
- **Model IDs** live in `shared/models.js`. Use exact current IDs from Anthropic's docs; never guess or add date suffixes.
- **End-to-end test quirk.** When the extension navigates a tab itself, Puppeteer's handle for that tab goes stale. Check tab URLs through `chrome.tabs.query` from an extension page instead, and bound any interaction with that tab with a timeout.
- **Store assets.** If the UI changes visibly, regenerate the screenshots with `npm run store-assets` and include them in the PR.
