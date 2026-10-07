# Anfa Majid — personal website

A minimal research and engineering website built with React and Vite, designed for deployment at `https://anfa-majid.github.io`.

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
npm run dev
```

Vite will print a local address, usually `http://localhost:5173`.

Before publishing, verify the production build:

```bash
npm run lint
npm run build
npm run preview
```

## Publish at anfa-majid.github.io

1. Create a public GitHub repository named exactly `anfa-majid.github.io`.
2. Copy the contents of this folder into the root of that repository. `package.json` and `index.html` should be at the repository root—not inside another folder.
3. Commit the files and push them to the `main` branch.
4. In the GitHub repository, open **Settings → Pages**.
5. Under **Build and deployment**, set **Source** to **GitHub Actions**.
6. Open the **Actions** tab and wait for the “Deploy website to GitHub Pages” workflow to finish.
7. Visit `https://anfa-majid.github.io`.

Every later push to `main` automatically rebuilds and publishes the site.

## Add an Engineering Journal entry

Create a Markdown file in `src/journal`. The filename becomes the article URL, so use lowercase words separated by hyphens.

```markdown
---
title: The title of the entry
date: 2026-10-07
displayDate: October 2026
summary: One or two sentences shown on the journal index.
topics: Distributed systems, Kubernetes, Reliability
---

Start the entry here. Use normal Markdown headings, lists, blockquotes, links, and code.
```

The journal index is generated automatically. Entries are sorted by the `date` field, newest first.

## Update manuscripts

Edit the `manuscripts` object in `src/siteConfig.js`. Completed and ongoing work are stored in separate arrays. A manuscript follows this shape:

```js
{
  title: 'Manuscript title',
  description: 'A short plain-language description.',
  topics: ['Cloud systems', 'Security'],
}
```

Move an item from `ongoing` to `completed` when it is ready. The ongoing section is rendered in a more muted style by design.

## Add the CV PDF

The current CV files are:

```text
cv/AnfaMajid.tex
public/Anfa-Majid-CV.pdf
```

The PDF is displayed directly on the CV page and is also available through open and download links. After updating the LaTeX source, replace the compiled file in `public` while keeping the same filename.

The public URL is configured in `src/siteConfig.js`:

```js
cvPdfUrl: '/Anfa-Majid-CV.pdf',
```

## Personalize the remaining details

- Update the embedded CV configuration in the `CV` component in `src/App.jsx`.
- Update or remove the ongoing research item in `src/siteConfig.js`.
- Add more journal entries in `src/journal`.
- Update the GitHub URL in `src/siteConfig.js` if needed.

## Routing choice

The site uses hash-based URLs (for example, `/#/journal`) so every page and article remains directly accessible on GitHub Pages without a custom server or redirect workaround.
