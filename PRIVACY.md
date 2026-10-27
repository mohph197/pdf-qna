# Privacy policy: Paper Q&A

_Last updated: 27 October 2026_

Paper Q&A is a Chrome extension that lets you ask questions about a PDF and highlights the answers. This policy explains what data it handles. The short version: the extension has no server of its own, collects no analytics, and sends data only to Anthropic's API, and only when you press **Find answers**.

## What the extension stores on your computer

All of the following stays in your browser's extension storage (`chrome.storage.local`) on your device:

- **Your Anthropic API key**, which you enter on the options page.
- **Your settings**: chosen model, effort level, and what to do when a PDF opens.
- **A cache of your questions and Claude's answers** for each PDF, keyed by a SHA-256 hash of the file. This lets a paper's highlights come back when you reopen it.

You can clear the cache on the options page. Removing the extension deletes all of it.

## What the extension sends, and to whom

When you press **Find answers** (or **Re-ask all**), the extension sends this data to Anthropic's API at `https://api.anthropic.com`:

- the text extracted from the PDF currently open in the viewer,
- the questions you typed,
- your API key, which authenticates the request.

Anthropic processes this data under its own terms and privacy policy, which apply to your API account: <https://www.anthropic.com/legal/privacy>. Paper Q&A is an independent project and is not affiliated with or endorsed by Anthropic.

The extension also downloads the PDF you choose to open, from the web address it was opened from. This is the same request your browser would make to display it.

Nothing else is sent anywhere. In particular, the extension does not send your browsing history, the addresses of pages you visit, or any data about you to the developer or to anyone else.

## Why the extension can see the pages you visit

Chrome asks you to allow Paper Q&A to "read and change data on all websites". The extension uses this permission only to:

- notice when a tab is showing a PDF, by its address or its `application/pdf` content type, so it can offer to open it;
- show the small "Open in Paper Q&A" banner on that PDF tab;
- download the PDF into its viewer, including from sites that need your login cookies and from local files if you allow file access.

It does not read or change the content of any other page.

## Data sale and sharing

The developer receives none of your data, so there is nothing to sell or share. Data is not used for advertising, credit decisions, or any purpose other than answering your questions.

## Children

Paper Q&A is not directed at children under 13.

## Changes

Changes to this policy will be published in this file in the project's repository, <https://github.com/mohph197/pdf-qna>, with a new date at the top.

## Contact

Open an issue at <https://github.com/mohph197/pdf-qna/issues>.
