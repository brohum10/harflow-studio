export const MAX_HAR_BYTES = 20 * 1024 * 1024;
export const MAX_ENTRIES = 10_000;

const DEFAULT_BUDGETS = Object.freeze({ requests: 80, transferBytes: 2_000_000, p95Ms: 500 });

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  return String(headers.find((header) =>
    String(header?.name ?? '').toLowerCase() === name)?.value ?? '');
}

function resourceType(mime) {
  const value = String(mime ?? '').toLowerCase();
  if (value.includes('html')) return 'document';
  if (value.includes('javascript') || value.includes('ecmascript')) return 'script';
  if (value.includes('css')) return 'style';
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('font/') || value.includes('woff')) return 'font';
  if (value.includes('json') || value.includes('xml')) return 'data';
  return 'other';
}

function safeAddress(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { host: '(non-HTTP)', displayUrl: '(non-HTTP request)' };
    }
    // Deliberately never return credentials, query strings, or fragments.
    return { host: url.hostname.toLowerCase(), displayUrl: `${url.hostname}${url.pathname}` };
  } catch {
    return { host: '(invalid URL)', displayUrl: '(invalid URL)' };
  }
}

function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || !entry.request || !entry.response) {
    throw new Error(`Entry ${index + 1} is missing a request or response.`);
  }
  const startedAt = Date.parse(entry.startedDateTime);
  if (!Number.isFinite(startedAt)) throw new Error(`Entry ${index + 1} has an invalid start time.`);
  const address = safeAddress(entry.request.url);
  const body = nonnegative(entry.response.bodySize);
  const headers = nonnegative(entry.response.headersSize);
  const customTransfer = nonnegative(entry.response._transferSize);
  const transferBytes = customTransfer ?? (body !== null && headers !== null ? body + headers : null);
  const phases = {};
  for (const name of ['blocked', 'dns', 'connect', 'send', 'wait', 'receive']) {
    phases[name] = nonnegative(entry.timings?.[name]);
  }
  const measuredTime = nonnegative(entry.time);
  const durationMs = measuredTime ?? Object.values(phases).reduce((sum, value) => sum + (value ?? 0), 0);
  const status = Number.isInteger(entry.response.status) ? entry.response.status : 0;
  const mime = String(entry.response.content?.mimeType ?? '').split(';')[0].trim().toLowerCase();
  return {
    id: index + 1,
    startedAt,
    durationMs,
    transferBytes,
    status,
    method: String(entry.request.method ?? 'GET').toUpperCase(),
    host: address.host,
    displayUrl: address.displayUrl,
    type: resourceType(mime),
    mime: mime || 'unknown',
    phases,
    hasContentEncoding: Boolean(headerValue(entry.response.headers, 'content-encoding')),
  };
}

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function grouped(requests, key) {
  const groups = new Map();
  for (const request of requests) {
    const label = request[key];
    const current = groups.get(label) ?? { label, count: 0, transferBytes: 0, unknownTransfers: 0, durations: [] };
    current.count += 1;
    if (request.transferBytes === null) current.unknownTransfers += 1;
    else current.transferBytes += request.transferBytes;
    current.durations.push(request.durationMs);
    groups.set(label, current);
  }
  return [...groups.values()].map(({ durations, ...item }) => ({
    ...item,
    p95Ms: percentile(durations, 0.95),
  })).sort((a, b) => b.transferBytes - a.transferBytes || a.label.localeCompare(b.label));
}

function findings(requests, metrics) {
  const output = [];
  if (metrics.errorCount) output.push({
    tone: 'warn', title: `${metrics.errorCount} error responses`,
    detail: 'Inspect the 4xx/5xx requests before optimizing transfer or timing.',
  });
  const longWait = requests.filter((item) => (item.phases.wait ?? 0) >= 800);
  if (longWait.length) output.push({
    tone: 'warn', title: `${longWait.length} long wait phases`,
    detail: 'HAR wait time includes server and network delay; investigate the slowest endpoints.',
  });
  const largeImages = requests.filter((item) => item.type === 'image' && (item.transferBytes ?? 0) >= 300_000);
  if (largeImages.length) output.push({
    tone: 'info', title: `${largeImages.length} large images`,
    detail: 'Check dimensions, formats, and lazy loading for images above 300 KB transferred.',
  });
  const textTypes = new Set(['document', 'script', 'style', 'data']);
  const compressionCandidates = requests.filter((item) =>
    textTypes.has(item.type) && (item.transferBytes ?? 0) >= 100_000 && !item.hasContentEncoding);
  if (compressionCandidates.length) output.push({
    tone: 'info', title: `${compressionCandidates.length} compression checks`,
    detail: 'Large text responses lack a captured Content-Encoding header; verify the export and server setup.',
  });
  if (metrics.requestCount > 80) output.push({
    tone: 'info', title: 'High request count',
    detail: 'Review whether noncritical requests can be deferred or consolidated.',
  });
  if (!output.length) output.push({
    tone: 'good', title: 'No heuristic alerts',
    detail: 'This is not proof of a fast page. Inspect the waterfall and compare against your own budgets.',
  });
  return output;
}

export function analyzeHar(document) {
  const entries = document?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Expected a HAR object with log.entries.');
  if (entries.length > MAX_ENTRIES) throw new Error(`HAR exceeds the ${MAX_ENTRIES.toLocaleString()}-entry safety limit.`);
  const requests = entries.map(normalizeEntry);
  const start = requests.length ? Math.min(...requests.map((item) => item.startedAt)) : 0;
  const finish = requests.length ? Math.max(...requests.map((item) => item.startedAt + item.durationMs)) : 0;
  const primaryHost = requests.find((item) => !item.host.startsWith('('))?.host ?? 'none';
  const metrics = {
    requestCount: requests.length,
    knownTransferBytes: requests.reduce((sum, item) => sum + (item.transferBytes ?? 0), 0),
    unknownTransfers: requests.filter((item) => item.transferBytes === null).length,
    p95Ms: percentile(requests.map((item) => item.durationMs), 0.95),
    loadSpanMs: finish - start,
    errorCount: requests.filter((item) => item.status >= 400).length,
    primaryHost,
  };
  return {
    requests: requests.map((item) => ({ ...item, offsetMs: item.startedAt - start })),
    metrics,
    hosts: grouped(requests, 'host'),
    types: grouped(requests, 'type'),
    findings: findings(requests, metrics),
  };
}

export function evaluateBudgets(metrics, budgets = DEFAULT_BUDGETS) {
  const definitions = [
    { key: 'requests', label: 'Requests', value: metrics.requestCount, limit: budgets.requests },
    { key: 'transferBytes', label: 'Known transfer', value: metrics.knownTransferBytes, limit: budgets.transferBytes },
    { key: 'p95Ms', label: 'p95 duration', value: metrics.p95Ms, limit: budgets.p95Ms },
  ];
  return definitions.map((item) => ({ ...item, passed: item.value <= item.limit }));
}

export function formatBytes(value) {
  if (value === null || value === undefined) return 'Unknown';
  if (value < 1_000) return `${Math.round(value)} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(2)} MB`;
}

export function formatMs(value) {
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)} s` : `${Math.round(value)} ms`;
}
