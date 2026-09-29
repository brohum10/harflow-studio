import { performance } from 'node:perf_hooks';
import { analyzeHar, MAX_ENTRIES, percentile } from '../src/analyze.js';

// The same 10,000-entry synthetic object is analyzed on every run. This tests
// normalization/aggregation only, not disk read, JSON parsing, or rendering.
const entries = Array.from({ length: MAX_ENTRIES }, (_, index) => ({
  startedDateTime: new Date(Date.UTC(2026, 8, 27, 12) + index * 10).toISOString(),
  time: 20 + index % 300,
  request: { method: 'GET', url: `https://host${index % 20}.example.test/assets/file${index % 100}.js?token=synthetic` },
  response: {
    status: index % 50 === 0 ? 503 : 200,
    _transferSize: 1_000 + index % 1_000,
    content: { mimeType: 'application/javascript' },
    headers: [],
  },
  timings: { wait: 15 + index % 250, receive: 5 },
}));
const document = { log: { entries } };

function measure() {
  const started = performance.now();
  const report = analyzeHar(document);
  if (report.metrics.requestCount !== MAX_ENTRIES || report.metrics.unknownTransfers !== 0) {
    throw new Error('Benchmark result failed its sanity check.');
  }
  return performance.now() - started;
}

for (let run = 0; run < 3; run += 1) measure();
const samplesMs = Array.from({ length: 10 }, measure);
console.log(JSON.stringify({
  entries: MAX_ENTRIES,
  warmups: 3,
  measuredRuns: samplesMs.length,
  analysisOnly: true,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  p50Ms: Number(percentile(samplesMs, 0.5).toFixed(3)),
  p95Ms: Number(percentile(samplesMs, 0.95).toFixed(3)),
}, null, 2));
