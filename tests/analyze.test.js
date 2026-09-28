import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeHar, evaluateBudgets, formatBytes, formatMs, MAX_ENTRIES, percentile } from '../src/analyze.js';

const demo = JSON.parse(readFileSync(new URL('../examples/sample.har', import.meta.url), 'utf8'));

function one(overrides = {}) {
  return {
    startedDateTime: '2026-09-27T12:00:00.000Z',
    time: 100,
    request: { method: 'GET', url: 'https://example.test/items?token=secret#private' },
    response: { status: 200, bodySize: 40, headersSize: 10,
      content: { mimeType: 'application/json' }, headers: [] },
    timings: { wait: 60, receive: 40 },
    ...overrides,
  };
}

test('synthetic demo produces reliable totals and p95', () => {
  const report = analyzeHar(demo);
  assert.equal(report.metrics.requestCount, 8);
  assert.equal(report.metrics.knownTransferBytes, 835_900);
  assert.equal(report.metrics.p95Ms, 1_200);
  assert.equal(report.metrics.loadSpanMs, 1_500);
  assert.equal(report.metrics.errorCount, 1);
  assert.equal(report.metrics.primaryHost, 'www.example.test');
  assert.ok(report.findings.some((item) => item.title.includes('error responses')));
});

test('sensitive URL parts and headers never enter normalized request', () => {
  const entry = one({
    request: { method: 'GET', url: 'https://user:pass@example.test/items?token=secret#private',
      headers: [{ name: 'Authorization', value: 'Bearer request-secret' }] },
    response: { status: 200, bodySize: 40, headersSize: 10,
      content: { mimeType: 'application/json', text: 'response-secret' },
      headers: [{ name: 'Set-Cookie', value: 'cookie-secret' }] },
  });
  const report = analyzeHar({ log: { entries: [entry] } });
  const serialized = JSON.stringify(report);
  assert.equal(report.requests[0].displayUrl, 'example.test/items');
  for (const secret of ['user', 'pass', 'secret', 'private', 'Authorization', 'Set-Cookie']) {
    assert.ok(!serialized.includes(secret), `${secret} escaped normalization`);
  }
});

test('groups are derived from observed hosts and resource MIME types', () => {
  const report = analyzeHar(demo);
  assert.deepEqual(report.types.map((group) => group.label),
    ['image', 'script', 'font', 'document', 'data', 'style']);
  assert.equal(report.hosts.find((group) => group.label === 'www.example.test').count, 6);
  assert.equal(report.hosts.reduce((sum, group) => sum + group.transferBytes, 0),
    report.metrics.knownTransferBytes);
});

test('transfer is unknown when HAR does not capture wire bytes', () => {
  const entry = one({ response: { status: 200, bodySize: -1, headersSize: -1,
    content: { size: 999_999, mimeType: 'text/html' } } });
  const report = analyzeHar({ log: { entries: [entry] } });
  assert.equal(report.requests[0].transferBytes, null);
  assert.equal(report.metrics.unknownTransfers, 1);
  assert.equal(report.metrics.knownTransferBytes, 0);
});

test('custom transfer size takes precedence over HAR body/header sizes', () => {
  const entry = one({ response: { status: 200, _transferSize: 80, bodySize: 40,
    headersSize: 10, content: { mimeType: 'text/css' } } });
  const report = analyzeHar({ log: { entries: [entry] } });
  assert.equal(report.requests[0].transferBytes, 80);
  assert.equal(report.requests[0].type, 'style');
});

test('negative HAR timings are ignored and valid phases provide fallback', () => {
  const report = analyzeHar({ log: { entries: [one({
    time: -1, timings: { blocked: -1, wait: 20, receive: 5 },
  })] } });
  assert.equal(report.requests[0].durationMs, 25);
  assert.equal(report.requests[0].phases.blocked, null);
});

test('budget checks use inclusive limits', () => {
  const metrics = { requestCount: 3, knownTransferBytes: 1_000, p95Ms: 300 };
  const exact = evaluateBudgets(metrics, { requests: 3, transferBytes: 1_000, p95Ms: 300 });
  assert.ok(exact.every((item) => item.passed));
  const strict = evaluateBudgets(metrics, { requests: 2, transferBytes: 999, p95Ms: 299 });
  assert.ok(strict.every((item) => !item.passed));
});

test('nearest-rank percentile is correct for small samples', () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([20, 10, 30], 0.5), 20);
});

test('malformed and oversized HAR documents fail clearly', () => {
  assert.throws(() => analyzeHar({}), /log.entries/);
  assert.throws(() => analyzeHar({ log: { entries: [one({ startedDateTime: 'not-a-date' })] } }),
    /invalid start time/);
  assert.throws(() => analyzeHar({ log: { entries: Array(MAX_ENTRIES + 1).fill(one()) } }),
    /safety limit/);
});

test('empty capture and non-HTTP URL do not crash the analyzer', () => {
  assert.equal(analyzeHar({ log: { entries: [] } }).metrics.requestCount, 0);
  assert.equal(analyzeHar({ log: { entries: [one({ request: { method: 'GET', url: 'data:text/plain,secret' } })] } })
    .requests[0].displayUrl, '(non-HTTP request)');
});

test('formatting stays readable', () => {
  assert.equal(formatBytes(null), 'Unknown');
  assert.equal(formatBytes(1_500), '1.5 KB');
  assert.equal(formatMs(1_500), '1.50 s');
});
