# LeakShot Web

**Try it now: [leakshot-web.vercel.app](https://leakshot-web.vercel.app)**

Find secrets hiding in your screenshots — **entirely in your browser**.

Drag in screenshots (or a whole folder) and LeakShot reads them with in-browser
OCR, finds visible secrets (AWS keys, Stripe/GitHub/Google/Slack tokens, JWTs,
credit cards, SSNs, context-keyword passwords), and lets you redact and download
a cleaned PNG.

> **Scans in your browser. Your screenshots never leave your device.**

## The privacy guarantee (read this)

There is **no backend**. This is a static single-page app. OCR runs via
WebAssembly ([tesseract.js](https://github.com/naptha/tesseract.js)) and secret
detection runs as plain JavaScript, both **on your machine, in the tab**.

- Your image bytes are **never uploaded anywhere**. Open the browser Network tab
  and you will see no request that carries your image.
- The **only** network traffic is your browser downloading the OCR engine and
  English language model to run locally (see the CDN note below).
- Everything is discarded when you close the tab.

### OCR-assets-from-CDN caveat

In a production build, tesseract.js fetches its worker, WASM core, and the
`eng.traineddata` language model from a public CDN (`cdn.jsdelivr.net`) the first
time you scan. This is the engine downloading itself to run locally — **not** an
upload of your data. If you want a fully self-hosted, zero-third-party-CDN
deployment, host those assets yourself and configure tesseract's
`workerPath` / `corePath` / `langPath` in `src/ocr.ts` to point at them.

## Stack

- **Vite + React + TypeScript** — client-only SPA, deploys to Vercel with zero
  config.
- **tesseract.js** — in-browser OCR (per-word text + bounding boxes).
- **Canvas API** — drawing highlight boxes and exporting redacted PNGs.
- **vitest** — unit tests for the detector engine and file enumeration.

The detector engine in `src/detectors.ts` is a faithful TypeScript port of the
desktop LeakShot Python detector (`leakshot/detectors.py`): the same precision
tiers, regex patterns, allowlist, Luhn card check, JWT base64url block-repair /
JSON-likeness scoring, and the 3-view (raw / space-collapsed / confusion-
denoised) scan. It is pure (no DOM) so it is unit-tested in Node.

## Requirements: Node

This project needs Node (v20+; developed on **v24.18.0**, npm **v11.16.0**).

Install Node from <https://nodejs.org> (LTS is fine) or via a version manager:

```sh
# macOS with Homebrew
brew install node
# or nvm
nvm install --lts
```

## Run locally

```sh
npm install
npm run dev        # http://localhost:5173
```

## Test

```sh
npm test           # vitest run — 26 tests, detector + file-enum vectors
```

## Build (static output)

```sh
npm run build      # type-checks, then emits a static site to dist/
npm run preview    # optional: serve the built dist/ locally
```

`dist/` is a fully static bundle — no server code, no environment variables.

## Deploy to Vercel

No configuration is required (`vercel.json` here just enables SPA rewrites and
clean URLs). Pick either path:

### (a) Vercel CLI

```sh
npm i -g vercel     # if you do not have it
vercel              # first run: it opens a browser to log you in, then prompts
                    # to link/create a project. Accept the detected settings:
                    #   Framework: Vite
                    #   Build command: npm run build
                    #   Output directory: dist
vercel --prod       # promote to production
```

The login step requires **your** browser authentication — run it yourself.

### (b) Push to GitHub, import at vercel.com

1. Create a repo and push this folder.
2. Go to <https://vercel.com/new> and import the repo.
3. Vercel auto-detects Vite: Build command `npm run build`, Output `dist`.
4. Click **Deploy**.

## What the detectors find

| Detector | Tier | Validation |
| --- | --- | --- |
| AWS Access Key | HIGH | base32 charset, allowlist for vendor examples |
| Stripe / GitHub / Google / Slack tokens | HIGH | format-specific regex |
| JWT | HIGH | base64url-decode header+payload to JSON, require `alg`; OCR block-repair |
| Credit card | HIGH | Luhn + at least 2 distinct nonzero digits, 13-19 length, OCR letter-to-digit fix |
| Private key header | HIGH | dash-tolerant `BEGIN ... PRIVATE KEY` |
| SSN | HIGH | excludes 000/666/9xx area, 00 group, 0000 serial |
| Context keyword (`password=...`, `api_key: ...`) | MEDIUM | keyword + value, split-value recovery, overlap-skip vs HIGH |

## Notes / left for later

- OCR quality is whatever tesseract's default English model gives; very small or
  low-contrast text may be missed. The confusion-denoise views recover many
  common OCR swaps (0/O, 1/l/I, 5/S, ...).
- Box mapping covers the words spanning a finding; it is word-accurate, not
  sub-character-accurate. Redaction pads boxes slightly so the secret is fully
  covered.
- Folder selection uses the non-standard `webkitdirectory` input and the drop
  `webkitGetAsEntry` API (Chrome / Edge / desktop Safari). Plain multi-file
  drops and the file picker work everywhere, including iOS Photos.
