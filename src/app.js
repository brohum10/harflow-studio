import { analyzeHar, compareAnalyses, evaluateBudgets, formatBytes, formatMs, MAX_HAR_BYTES } from './analyze.js';

const $ = (id) => document.getElementById(id);
const state = { analysis: null, comparison: null, selectedId: null, source: 'demo' };

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function status(message, tone = 'neutral') {
  $('status-message').textContent = message;
  $('status-message').dataset.tone = tone;
}

function currentBudgets() {
  const requests = Number($('budget-requests').value);
  const transfer = Number($('budget-transfer').value);
  const p95 = Number($('budget-p95').value);
  return {
    requests: Number.isFinite(requests) && requests > 0 ? requests : 80,
    transferBytes: Number.isFinite(transfer) && transfer > 0 ? transfer * 1_000_000 : 2_000_000,
    p95Ms: Number.isFinite(p95) && p95 > 0 ? p95 : 500,
  };
}

function renderMetrics() {
  const metrics = state.analysis.metrics;
  $('metric-requests').textContent = metrics.requestCount.toLocaleString();
  $('metric-bytes').textContent = formatBytes(metrics.knownTransferBytes);
  $('metric-p95').textContent = formatMs(metrics.p95Ms);
  $('metric-span').textContent = formatMs(metrics.loadSpanMs);
  $('note-requests').textContent = `${metrics.errorCount} returned 4xx / 5xx`;
  $('note-bytes').textContent = metrics.unknownTransfers
    ? `${metrics.unknownTransfers} transfers unknown; total is partial`
    : 'All transfers captured in HAR';
  $('note-p95').textContent = 'Nearest-rank percentile';
  $('note-span').textContent = 'First start to last finish';
}

function comparisonValue(key, value) {
  if (key === 'knownTransferBytes') return formatBytes(value);
  if (key === 'p95Ms' || key === 'loadSpanMs') return formatMs(value);
  return value.toLocaleString();
}

function renderComparison() {
  const container = $('comparison-results');
  container.replaceChildren();
  if (!state.comparison) {
    container.append(element('p', 'empty-message', 'Choose a second HAR to see before/after changes, or load the synthetic comparison.'));
    return;
  }
  const comparison = compareAnalyses(state.analysis, state.comparison);
  for (const row of comparison.rows) {
    const item = element('div', 'comparison-row');
    item.append(element('span', 'comparison-label', row.label));
    item.append(element('span', 'comparison-values', `${comparisonValue(row.key, row.before)} → ${comparisonValue(row.key, row.after)}`));
    const delta = row.comparable ? row.delta === 0 ? 'No change'
      : `${row.delta > 0 ? '+' : '−'}${comparisonValue(row.key, Math.abs(row.delta))}${row.percent === null ? '' : ` (${row.percent > 0 ? '+' : ''}${row.percent.toFixed(1)}%)`}`
      : 'Partial data';
    item.append(element('strong', `comparison-delta ${!row.comparable ? 'partial' : row.delta > 0 ? 'worse' : row.delta < 0 ? 'better' : ''}`, delta));
    container.append(item);
  }
  const notes = element('p', 'comparison-note');
  notes.textContent = comparison.samePrimaryHost
    ? 'These are capture-level changes, not controlled speed measurements. Repeat captures under the same conditions before drawing conclusions.'
    : 'Primary hosts differ. These captures may not describe the same page; treat every delta as contextual only.';
  container.append(notes);
  if (comparison.partialTransfer) container.append(element('p', 'comparison-note',
    'At least one capture has unknown transfer sizes, so the transfer delta is incomplete.'));
}

function renderBudgets() {
  const container = $('budget-results');
  container.replaceChildren();
  if (!state.analysis) return;
  const metrics = state.analysis.metrics;
  for (const budget of evaluateBudgets(metrics, currentBudgets())) {
    const partial = budget.key === 'transferBytes' && metrics.unknownTransfers > 0;
    const item = element('div', `budget-result ${partial ? 'partial' : budget.passed ? 'passed' : 'failed'}`);
    item.append(element('span', 'budget-result-name', budget.label));
    const value = budget.key === 'transferBytes' ? formatBytes(budget.value)
      : budget.key === 'p95Ms' ? formatMs(budget.value) : String(budget.value);
    item.append(element('strong', '', value));
    item.append(element('span', 'budget-verdict', partial ? 'PARTIAL' : budget.passed ? 'PASS' : 'OVER'));
    container.append(item);
  }
}

function renderFindings() {
  const container = $('finding-list');
  container.replaceChildren();
  for (const finding of state.analysis.findings) {
    const card = element('article', `finding ${finding.tone}`);
    card.append(element('span', 'finding-indicator', finding.tone === 'warn' ? '!' : '↗'));
    const content = element('div');
    content.append(element('strong', '', finding.title));
    content.append(element('p', '', finding.detail));
    card.append(content);
    container.append(card);
  }
}

function renderHosts() {
  const container = $('host-breakdown');
  container.replaceChildren();
  const hosts = state.analysis.hosts.slice(0, 6);
  if (!hosts.length) {
    container.append(element('p', 'empty-message', 'No host data in this capture.'));
    return;
  }
  const maximum = Math.max(1, ...hosts.map((item) => item.transferBytes));
  for (const host of hosts) {
    const row = element('div', 'host-row');
    const top = element('div', 'host-row-top');
    const name = element('strong', '', host.label);
    if (host.label === state.analysis.metrics.primaryHost) {
      name.append(element('small', 'primary-label', 'PRIMARY'));
    }
    top.append(name, element('span', '', `${host.count} req · ${formatBytes(host.transferBytes)}`));
    const track = element('div', 'host-track');
    const fill = element('span', 'host-fill');
    fill.style.width = `${Math.max(2, host.transferBytes / maximum * 100)}%`;
    track.append(fill);
    row.append(top, track);
    container.append(row);
  }
}

function updateHostFilter() {
  const select = $('filter-host');
  const previous = select.value;
  select.replaceChildren(new Option('All hosts', 'all'));
  for (const host of state.analysis.hosts) select.add(new Option(host.label, host.label));
  select.value = [...select.options].some((option) => option.value === previous) ? previous : 'all';
}

function filteredRequests() {
  const query = $('filter-search').value.trim().toLowerCase();
  const type = $('filter-type').value;
  const statusFilter = $('filter-status').value;
  const host = $('filter-host').value;
  const requests = state.analysis.requests.filter((request) => {
    if (query && !`${request.displayUrl} ${request.host}`.toLowerCase().includes(query)) return false;
    if (type !== 'all' && request.type !== type) return false;
    if (host !== 'all' && request.host !== host) return false;
    if (statusFilter === 'errors' && request.status < 400) return false;
    if (statusFilter === 'success' && (request.status < 200 || request.status >= 400)) return false;
    return true;
  });
  const sort = $('sort-by').value;
  requests.sort((a, b) => {
    if (sort === 'duration') return b.durationMs - a.durationMs || a.id - b.id;
    if (sort === 'transfer') return (b.transferBytes ?? -1) - (a.transferBytes ?? -1) || a.id - b.id;
    return a.startedAt - b.startedAt || a.id - b.id;
  });
  return requests;
}

function statusClass(value) {
  if (value >= 400) return 'error';
  if (value >= 300) return 'redirect';
  if (value >= 200) return 'success';
  return 'unknown';
}

function requestCell(text, className = '') {
  const cell = element('td', className);
  cell.append(element('span', '', text));
  return cell;
}

function renderRows() {
  const body = $('request-rows');
  body.replaceChildren();
  if (!state.analysis) return;
  const requests = filteredRequests();
  $('visible-count').textContent = `${requests.length.toLocaleString()} of ${state.analysis.requests.length.toLocaleString()} requests`;
  $('timeline-label').textContent = `0 → ${formatMs(state.analysis.metrics.loadSpanMs)}`;
  if (!requests.length) {
    const row = element('tr');
    const cell = element('td', 'empty-table', 'No requests match these filters.');
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
    return;
  }
  const span = Math.max(1, state.analysis.metrics.loadSpanMs);
  for (const request of requests) {
    const row = element('tr', request.id === state.selectedId ? 'selected' : '');
    const first = element('td', 'request-name');
    const button = element('button', 'request-button', request.displayUrl);
    button.type = 'button';
    button.setAttribute('aria-label', `Inspect ${request.method} ${request.displayUrl}`);
    button.setAttribute('aria-pressed', String(request.id === state.selectedId));
    button.addEventListener('click', () => {
      state.selectedId = request.id;
      renderRows();
      renderDetail();
    });
    first.append(button, element('small', '', `${request.method} · ${request.type}`));
    row.append(first, requestCell(request.host, 'host-cell'));
    const statusCell = element('td');
    statusCell.append(element('span', `status-pill ${statusClass(request.status)}`,
      request.status ? String(request.status) : '—'));
    row.append(statusCell, requestCell(formatBytes(request.transferBytes), 'numeric'),
      requestCell(formatMs(request.durationMs), 'numeric'));
    const timelineCell = element('td', 'timeline-cell');
    const track = element('div', 'timeline-track');
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', `Started ${formatMs(request.offsetMs)} after capture start, lasted ${formatMs(request.durationMs)}`);
    const bar = element('span', `timeline-bar ${request.type}`);
    const left = Math.min(99, request.offsetMs / span * 100);
    bar.style.left = `${left}%`;
    bar.style.width = `${Math.min(100 - left, Math.max(0.8, request.durationMs / span * 100))}%`;
    track.append(bar);
    timelineCell.append(track);
    row.append(timelineCell);
    body.append(row);
  }
}

function detailItem(label, value) {
  const item = element('div', 'detail-item');
  item.append(element('dt', '', label), element('dd', '', value));
  return item;
}

function renderDetail() {
  const container = $('request-detail');
  container.replaceChildren();
  const selected = state.analysis?.requests.find((request) => request.id === state.selectedId);
  if (!selected) {
    container.append(element('p', 'empty-message', 'Select a request in the waterfall to inspect its recorded timing.'));
    return;
  }
  container.append(element('p', 'detail-url', selected.displayUrl));
  const list = element('dl', 'detail-grid');
  list.append(detailItem('Method / status', `${selected.method} / ${selected.status || 'Unknown'}`));
  list.append(detailItem('Resource type', selected.type));
  list.append(detailItem('Duration', formatMs(selected.durationMs)));
  list.append(detailItem('Known transfer', formatBytes(selected.transferBytes)));
  list.append(detailItem('Start offset', formatMs(selected.offsetMs)));
  list.append(detailItem('MIME', selected.mime));
  container.append(list);
  const phases = element('div', 'phase-list');
  phases.append(element('h4', '', 'Captured timing phases'));
  for (const [name, value] of Object.entries(selected.phases)) {
    const item = element('div', 'phase-row');
    item.append(element('span', '', name), element('strong', '', value === null ? 'Not captured' : formatMs(value)));
    phases.append(item);
  }
  container.append(phases);
  container.append(element('p', 'detail-privacy', 'Query strings, URL credentials, fragments, and all headers are intentionally hidden.'));
}

function render() {
  renderMetrics();
  renderComparison();
  renderBudgets();
  renderFindings();
  renderHosts();
  updateHostFilter();
  renderRows();
  renderDetail();
  $('export-summary').disabled = false;
  $('source-badge').textContent = state.source === 'demo' ? 'SYNTHETIC BASELINE' : 'PRIVATE BASELINE';
}

function acceptDocument(document, source) {
  const analysis = analyzeHar(document);
  state.analysis = analysis;
  state.comparison = null;
  state.selectedId = analysis.requests[0]?.id ?? null;
  state.source = source;
  render();
  status(`${source === 'demo' ? 'Synthetic demo' : 'Private capture'} ready · ${analysis.metrics.requestCount.toLocaleString()} requests analyzed locally.`, 'success');
}

function acceptCandidate(document, source) {
  if (!state.analysis) throw new Error('Load a baseline capture first.');
  const candidate = analyzeHar(document);
  state.comparison = candidate;
  renderComparison();
  status(`${source === 'demo' ? 'Synthetic' : 'Private'} comparison ready · baseline ${state.analysis.metrics.requestCount.toLocaleString()} vs second capture ${candidate.metrics.requestCount.toLocaleString()} requests.`, 'success');
}

async function loadDemo() {
  try {
    status('Loading the synthetic example…');
    const response = await fetch('./examples/sample.har');
    if (!response.ok) throw new Error(`Demo request returned ${response.status}.`);
    acceptDocument(await response.json(), 'demo');
  } catch (error) {
    status(`Could not load the demo: ${error.message} Run a local web server or choose a HAR file.`, 'error');
  }
}

async function loadFile(file) {
  if (!file) return;
  try {
    if (file.size > MAX_HAR_BYTES) throw new Error('File exceeds the 20 MB safety limit.');
    status('Reading the file in this browser tab…');
    acceptDocument(JSON.parse(await file.text()), 'private');
  } catch (error) {
    status(`Could not analyze this file: ${error.message}`, 'error');
  }
}

async function loadComparisonFile(file) {
  if (!file) return;
  try {
    if (file.size > MAX_HAR_BYTES) throw new Error('File exceeds the 20 MB safety limit.');
    status('Reading the comparison file in this browser tab…');
    acceptCandidate(JSON.parse(await file.text()), 'private');
  } catch (error) {
    status(`Could not compare this file: ${error.message}`, 'error');
  }
}

async function loadComparisonDemo() {
  try {
    status('Loading synthetic before/after captures…');
    const [beforeResponse, afterResponse] = await Promise.all([
      fetch('./examples/sample.har'), fetch('./examples/optimized.har'),
    ]);
    if (!beforeResponse.ok || !afterResponse.ok) throw new Error('Demo captures could not be loaded.');
    const [before, after] = await Promise.all([beforeResponse.json(), afterResponse.json()]);
    acceptDocument(before, 'demo');
    acceptCandidate(after, 'demo');
  } catch (error) {
    status(`Could not load the comparison demo: ${error.message}`, 'error');
  }
}

function exportSummary() {
  if (!state.analysis) return;
  const { metrics, hosts, types, findings } = state.analysis;
  const content = JSON.stringify({ metrics, hosts, types, findings,
    budgets: evaluateBudgets(metrics, currentBudgets()),
    comparison: state.comparison ? compareAnalyses(state.analysis, state.comparison) : null }, null, 2);
  const url = URL.createObjectURL(new Blob([content + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'harflow-summary.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

$('har-file').addEventListener('change', (event) => {
  void loadFile(event.target.files?.[0]);
  event.target.value = '';
});
$('compare-file').addEventListener('change', (event) => {
  void loadComparisonFile(event.target.files?.[0]);
  event.target.value = '';
});
$('load-compare-demo').addEventListener('click', () => { void loadComparisonDemo(); });
const importCard = $('import-card');
importCard.addEventListener('dragover', (event) => {
  event.preventDefault();
  importCard.classList.add('dragging');
});
importCard.addEventListener('dragleave', () => importCard.classList.remove('dragging'));
importCard.addEventListener('drop', (event) => {
  event.preventDefault();
  importCard.classList.remove('dragging');
  void loadFile(event.dataTransfer?.files?.[0]);
});
$('load-demo').addEventListener('click', () => { void loadDemo(); });
$('export-summary').addEventListener('click', exportSummary);
for (const id of ['budget-requests', 'budget-transfer', 'budget-p95']) {
  $(id).addEventListener('input', renderBudgets);
}
for (const id of ['filter-search', 'filter-type', 'filter-status', 'filter-host', 'sort-by']) {
  $(id).addEventListener('input', renderRows);
}
void loadDemo();
