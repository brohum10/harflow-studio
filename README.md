# HarFlow Studio

A private, browser-based HAR analyzer for finding where a page spends network time. Import a capture to see a request waterfall, host and resource breakdowns, editable performance budgets, and a short investigation queue. Add a second capture to compare request count, known transfer, p95 request duration, capture span, and errors. The included synthetic capture loads automatically, so the interface can be explored without exporting a real one.

**Live demo:** https://brohum10.github.io/harflow-studio/

**Stack:** semantic HTML, responsive CSS, vanilla JavaScript modules, Node.js built-in test runner, GitHub Pages

## Why I built it

Browser DevTools is great for individual requests, but it can be hard to get a quick overview of an exported capture. HarFlow turns a HAR into a shareable *summary* while keeping the source file in the browser. The analysis intentionally uses explainable calculations and flags possible issues without pretending a waterfall alone can diagnose the root cause.

## Run locally

There are no runtime dependencies or API keys. Use a local static server so the ES module and synthetic example can load:

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`. To run the automated checks, install Node.js 22+ and run:

```bash
npm run check
```

No `npm install` is needed. To inspect your own page, open your browser's Network panel, reload the page, export a HAR, and choose that file in HarFlow. **HAR files may contain cookies, authorization headers, request bodies, and private URLs. Do not commit or share a real HAR.**

For a before/after review, import a baseline capture, then choose a second HAR in the comparison panel. “Try synthetic comparison” loads both checked-in demo captures. The demo's reductions are fictional examples of the calculation—not a measured optimization of a real site.

## How it works

`src/analyze.js` validates and normalizes the HAR. It retains only the data required for the dashboard: method, status, hostname/path, MIME-based type, recorded duration/timing phases, and known transfer size. Credentials, query strings, fragments, headers, request/response bodies, and cookies are not copied into the normalized request objects. The UI in `src/app.js` renders those objects with DOM text nodes rather than injecting HTML. It reads selected files with the browser File API; there is no upload endpoint or analytics script.

The total known transfer is the sum of captured transfer sizes. Unknown sizes remain unknown rather than being guessed from content size. The p95 uses the nearest-rank method over recorded request durations. Capture span runs from the earliest request start to the latest recorded finish; it is **not** a page-load or Core Web Vital measurement. A first observed host is labeled "primary" for orientation, not as a verified site origin. Budget misses and findings are investigation prompts, not conclusions.

The dashboard limits input to 20 MB and 10,000 entries to keep browser work bounded. The exported JSON summary omits individual requests and sensitive URL components, but **hostnames and aggregate metrics can still reveal information**; review the summary before sharing it.

Comparison is intentionally capture-level: percentages describe differences between the two files, not a controlled causal performance improvement. If either capture lacks transfer sizes, HarFlow marks that delta partial rather than calling it a gain. If their first observed hosts differ, it warns that the files may not represent the same page. Repeat captures under similar conditions before using the result to judge a release.

## Test coverage

The 15-test suite covers synthetic totals, percentiles, budgets, grouping, before/after deltas, missing transfer data, mismatched hosts, negative timing fields, malformed and oversized captures, non-HTTP URLs, and removal of credential, query, header, and body secrets from normalized data. CI runs syntax checks and the test suite on Node 22 and 24.

## Reproducible analysis benchmark

```bash
npm run benchmark
```

The benchmark analyzes the same generated 10,000-entry HAR object after three warmups, then reports p50/p95 over ten runs. It verifies the output count. A local Apple arm64 / Node 24.12.0 run on September 29, 2026 measured **13.063 ms p50** and **14.378 ms p95**. This isolates normalization and aggregation; it excludes file reading, JSON parsing, UI rendering, and real page speed. Re-run it on your own machine rather than treating one laptop result as a universal guarantee.

## Limits and next steps

HAR exports vary by browser, and some timing or byte fields may be unavailable. HarFlow does not infer a critical path, calculate LCP/INP/CLS, or replace Lighthouse and real-user monitoring. A next step would be pairing repeated captures and adding statistical uncertainty rather than comparing one file against another.

## Resume-ready description

Built a privacy-first HAR analysis web app with request waterfalls, before/after capture comparison, configurable budgets, and explainable findings; analyzed a 10,000-entry synthetic HAR in 14.378 ms p95 on a local arm64/Node 24 benchmark and deployed the dependency-free app to GitHub Pages.
