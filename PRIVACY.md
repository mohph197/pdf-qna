# Privacy policy: Paper Q&A

_Last updated: 27 October 2026_

Paper Q&A is a Chrome extension that lets you ask questions about a PDF and highlights the answers. This policy explains what data it handles. The short version: the extension has no server of its own and collects no analytics. It sends the paper's text and your questions only to Anthropic's API, and only when you press **Find answers**. When you click a citation or the paper info button, it looks that one paper up on Semantic Scholar.

## What the extension stores on your computer

All of the following stays in your browser's extension storage (`chrome.storage.local`) on your device:

- **Your Anthropic API key**, which you enter on the options page.
- **Your settings**: chosen model, effort level, what to do when a PDF opens, whether citation previews are on, and your Semantic Scholar API key if you added one.
- **A cache of your questions and Claude's answers** for each PDF, keyed by a SHA-256 hash of the file. This lets a paper's highlights come back when you reopen it.

You can clear the cache on the options page. Removing the extension deletes all of it.

## What the extension sends, and to whom

When you press **Find answers** (or **Re-ask all**), the extension sends this data to Anthropic's API at `https://api.anthropic.com`:

- the text extracted from the PDF currently open in the viewer,
- the questions you typed,
- your API key, which authenticates the request.

If you tick **Search the web** for a question, Claude may also search the web for it. The searches are run by Anthropic as part of the same API request, so the extension itself still contacts only `api.anthropic.com`. The search queries Claude writes, which can draw on your question and the paper, are handled under Anthropic's terms. Links to the web pages Claude cites are shown in the sidebar; the extension does not open them unless you click one.

Anthropic processes this data under its own terms and privacy policy, which apply to your API account: <https://www.anthropic.com/legal/privacy>. Paper Q&A is an independent project and is not affiliated with or endorsed by Anthropic.

When you click a citation in the paper, or the paper info button in the viewer's toolbar, the extension asks the Semantic Scholar API (`https://api.semanticscholar.org`, run by the Allen Institute for AI) for that paper's details. The request contains the paper's identifier (DOI, arXiv or ACL Anthology ID) if one is known, otherwise its title. The title comes from the clicked reference, or from the open PDF's metadata or first page. If you added a Semantic Scholar API key, it is sent with the request. Nothing is sent until you click, and no PDF text other than that title or identifier is sent. Semantic Scholar's terms and privacy policy apply: <https://www.semanticscholar.org/product/api/license> and <https://allenai.org/privacy-policy>. You can turn citation previews off on the options page. Links in the card (Google Scholar, arXiv, DOI and so on) are opened only if you click them.

The extension also downloads the PDF you choose to open, from the web address it was opened from. This is the same request your browser would make to display it.

Nothing else is sent anywhere. In particular, the extension does not send your browsing history, the addresses of pages you visit, or any data about you to the developer or to anyone else.

## Why the extension can see the pages you visit

Chrome asks you to allow Paper Q&A to "read and change data on all websites". The extension uses this permission only to:

- notice when a tab is showing a PDF, by its address or its `application/pdf` content type, so it can offer to open it;
- show the small "Open in Paper Q&A" banner on that PDF tab;
- download the PDF into its viewer, including from sites that need your login cookies and from local files if you allow file access;
- if you choose to always open PDFs in Paper Q&A, send a PDF tab to its viewer as soon as the PDF starts loading.

It does not read or change the content of any other page.

## Data sale and sharing

The developer receives none of your data, so there is nothing to sell or share. Data is not used for advertising, credit decisions, or any purpose other than answering your questions and showing the papers you click.

## Children

Paper Q&A is not directed at children under 13.

## Changes

Changes to this policy will be published in this file in the project's repository, <https://github.com/mohph197/pdf-qna>, with a new date at the top.

## Contact

Open an issue at <https://github.com/mohph197/pdf-qna/issues>.
