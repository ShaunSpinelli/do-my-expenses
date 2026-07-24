import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { parseStatement } from './parser.js';
import { fillTemplate, CAPACITY } from './template.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  '../vendor/pdfjs/pdf.worker.min.mjs',
  import.meta.url,
).href;

/** Tax shown per row and in the totals: 13% of the transaction amount. */
const TAX_RATE = 0.13;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const money = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
});

const COLUMNS = [
  { key: 'transDate', label: 'Date', cls: 'date' },
  { key: 'weekday', label: 'Day', cls: '' },
  { key: 'description', label: 'Description', cls: 'desc' },
  { key: 'category', label: 'Category', cls: 'cat' },
  { key: 'amount', label: 'Amount', cls: 'num amount' },
  { key: 'tax', label: `Tax (${Math.round(TAX_RATE * 100)}%)`, cls: 'num' },
];

/** Where the chosen template is remembered between visits. */
const TEMPLATE_KEY = 'expense-report-template';

const state = {
  transactions: [],
  meta: {},
  /** {name, bytes} of the expense report template, once chosen */
  template: null,
  /** ids moved into the Work Expenses table */
  workIds: new Set(),
  filters: { query: '', category: '', workdaysOnly: false, showPayments: false },
  sort: {
    all: { key: 'transDate', dir: 'asc' },
    work: { key: 'transDate', dir: 'asc' },
  },
};

const el = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  browse: document.getElementById('browse'),
  fileName: document.getElementById('file-name'),
  status: document.getElementById('status'),
  warnings: document.getElementById('warnings'),
  results: document.getElementById('results'),
  meta: document.getElementById('meta'),
  search: document.getElementById('search'),
  categoryFilter: document.getElementById('category-filter'),
  workdaysOnly: document.getElementById('workdays-only'),
  showPayments: document.getElementById('show-payments'),
  allTable: document.getElementById('all-table'),
  workTable: document.getElementById('work-table'),
  allEmpty: document.getElementById('all-empty'),
  workEmpty: document.getElementById('work-empty'),
  exportAll: document.getElementById('export-all'),
  exportWork: document.getElementById('export-work'),
  templateInput: document.getElementById('template-input'),
  templateBrowse: document.getElementById('template-browse'),
  templateClear: document.getElementById('template-clear'),
  templateState: document.getElementById('template-state'),
};

/* ---------------------------------------------------------------- template */

el.templateBrowse.addEventListener('click', () => el.templateInput.click());
el.templateInput.addEventListener('change', async () => {
  const file = el.templateInput.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  state.template = { name: file.name, bytes };
  rememberTemplate(state.template);
  renderTemplateState();
  setStatus(`Template loaded: ${file.name}`);
});

el.templateClear.addEventListener('click', async () => {
  state.template = null;
  try {
    localStorage.removeItem(TEMPLATE_KEY);
  } catch {
    /* storage unavailable — nothing cached to clear */
  }
  el.templateInput.value = '';
  // Fall back to the bundled template if the site ships one.
  await loadBundledTemplate();
  renderTemplateState();
});

/**
 * A `template.xlsx` sitting next to index.html is used as the default, so the
 * common case needs no file picking. A template the user chose themselves wins
 * over it — theirs may be newer.
 */
async function loadBundledTemplate() {
  try {
    const url = new URL('../template.xlsx', import.meta.url);
    const response = await fetch(url);
    if (!response.ok) return false;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) return false;
    state.template = { name: 'template.xlsx', bytes, bundled: true };
    return true;
  } catch {
    // No bundled template (or opened over file://) — the picker still works.
    return false;
  }
}

async function initTemplate() {
  restoreTemplate();
  if (!state.template) await loadBundledTemplate();
  renderTemplateState();
}

/**
 * The template stays on this machine — it is kept in localStorage purely so it
 * doesn't have to be re-picked on every visit, and never leaves the browser.
 */
function rememberTemplate({ name, bytes }) {
  try {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ name, data: btoa(binary) }));
  } catch {
    // Over quota or storage blocked: the template still works for this session.
  }
}

function restoreTemplate() {
  try {
    const stored = localStorage.getItem(TEMPLATE_KEY);
    if (!stored) return;
    const { name, data } = JSON.parse(stored);
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    state.template = { name, bytes };
  } catch {
    // Unreadable cache is not worth surfacing; the user can pick the file again.
  }
}

function renderTemplateState() {
  const loaded = Boolean(state.template);
  if (!loaded) {
    el.templateState.textContent = 'Not loaded — pick your .xlsx template to enable export.';
  } else {
    const origin = state.template.bundled
      ? 'the default bundled with this site'
      : 'your copy, remembered on this device';
    el.templateState.textContent =
      `Using ${state.template.name} — ${origin}. Holds up to ${CAPACITY} line items.`;
  }
  el.templateState.classList.toggle('is-ready', loaded);
  el.templateBrowse.textContent = loaded ? 'Use a different one' : 'Choose template';
  // "Forget" only makes sense for a template the user picked.
  el.templateClear.hidden = !loaded || Boolean(state.template.bundled);
  el.exportAll.disabled = !loaded;
  el.exportWork.disabled = !loaded;
  const title = loaded ? '' : 'Load your expense report template first';
  el.exportAll.title = title;
  el.exportWork.title = title;
}

/* ------------------------------------------------------------------ intake */

el.browse.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files?.[0]) loadFile(el.fileInput.files[0]);
});

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('is-over');
  });
}
el.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    setStatus('That doesn’t look like a PDF.', true);
    return;
  }

  el.fileName.textContent = file.name;
  el.fileName.hidden = false;
  setStatus('Reading statement…');

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const { transactions, meta, warnings } = await parseStatement(pdf);

    if (!transactions.length) {
      setStatus(
        'No transactions found. This parser expects a statement with a ' +
          '"Description / Spend Categories / Amount($)" transaction table.',
        true,
      );
      el.results.hidden = true;
      return;
    }

    transactions.forEach((t, i) => {
      t.id = `t${i}`;
      t.tax = round2(t.amount * TAX_RATE);
    });

    state.transactions = transactions;
    state.meta = meta;
    state.workIds = new Set();

    setStatus(
      `Parsed ${transactions.length} rows from ${pdf.numPages} pages.`,
    );
    showWarnings(warnings);
    buildCategoryFilter();
    el.results.hidden = false;
    render();
  } catch (err) {
    console.error(err);
    setStatus(`Could not read that PDF: ${err.message}`, true);
  }
}

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.hidden = false;
  el.status.classList.toggle('is-error', isError);
}

function showWarnings(warnings) {
  el.warnings.replaceChildren();
  el.warnings.hidden = warnings.length === 0;
  for (const w of warnings) {
    const p = document.createElement('p');
    p.textContent = w;
    el.warnings.append(p);
  }
}

/* ----------------------------------------------------------------- filters */

el.search.addEventListener('input', () => {
  state.filters.query = el.search.value.trim().toLowerCase();
  render();
});
el.categoryFilter.addEventListener('change', () => {
  state.filters.category = el.categoryFilter.value;
  render();
});
el.workdaysOnly.addEventListener('change', () => {
  state.filters.workdaysOnly = el.workdaysOnly.checked;
  render();
});
el.showPayments.addEventListener('change', () => {
  state.filters.showPayments = el.showPayments.checked;
  render();
});

function buildCategoryFilter() {
  const categories = [...new Set(state.transactions.map((t) => t.category))].sort();
  el.categoryFilter.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All categories';
  el.categoryFilter.append(all);
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    el.categoryFilter.append(opt);
  }
}

/** Rows for the All Expenses table: everything not moved to Work, filtered. */
function visibleRows() {
  const { query, category, workdaysOnly, showPayments } = state.filters;
  return state.transactions.filter((t) => {
    if (state.workIds.has(t.id)) return false;
    if (!showPayments && t.type === 'payment') return false;
    if (category && t.category !== category) return false;
    if (workdaysOnly && !t.isWorkday) return false;
    if (query) {
      const haystack = `${t.description} ${t.details} ${t.category}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function workRows() {
  return state.transactions.filter((t) => state.workIds.has(t.id));
}

/* ------------------------------------------------------------------ render */

function render() {
  renderMeta();
  renderTable({
    table: el.workTable,
    rows: sortRows(workRows(), state.sort.work),
    sortKey: 'work',
    checked: true,
    emptyEl: el.workEmpty,
  });
  renderTable({
    table: el.allTable,
    rows: sortRows(visibleRows(), state.sort.all),
    sortKey: 'all',
    checked: false,
    emptyEl: el.allEmpty,
  });
}

function renderMeta() {
  const charges = state.transactions.filter((t) => t.type === 'charge');
  const total = sum(charges, 'amount');
  const items = [
    ['Cardholder', state.meta.cardholder],
    ['Account', state.meta.accountNumber],
    ['Statement date', state.meta.statementDateText],
    ['Period', state.meta.period],
    ['Expenses', `${charges.length}`],
    ['Total', money.format(total), true],
    [`Tax (${Math.round(TAX_RATE * 100)}%)`, money.format(round2(total * TAX_RATE)), true],
  ];

  el.meta.replaceChildren();
  for (const [label, value, isFigure] of items) {
    if (!value) continue;
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (isFigure) dd.classList.add('is-figure');
    wrap.append(dt, dd);
    el.meta.append(wrap);
  }
}

function renderTable({ table, rows, sortKey, checked, emptyEl }) {
  const sort = state.sort[sortKey];

  // Header
  const headRow = document.createElement('tr');
  const checkTh = document.createElement('th');
  checkTh.className = 'check';
  checkTh.setAttribute('aria-label', checked ? 'Remove' : 'Add to work expenses');
  headRow.append(checkTh);

  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.className = `sortable ${col.cls}`.trim();
    th.textContent = col.label;
    if (sort.key === col.key) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = sort.dir === 'asc' ? ' ▲' : ' ▼';
      th.append(arrow);
    }
    th.addEventListener('click', () => {
      if (sort.key === col.key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else {
        sort.key = col.key;
        sort.dir = 'asc';
      }
      render();
    });
    headRow.append(th);
  }
  table.tHead.replaceChildren(headRow);

  // Body
  const body = document.createElement('tbody');
  for (const t of rows) body.append(buildRow(t, checked));
  table.tBodies[0].replaceWith(body);

  // Footer
  table.tFoot.replaceChildren(buildFooter(rows));

  const isEmpty = rows.length === 0;
  table.closest('.table-scroll').hidden = isEmpty;
  if (emptyEl) emptyEl.hidden = !isEmpty;
}

function buildRow(t, isWorkRow) {
  const tr = document.createElement('tr');
  if (t.amount < 0) tr.classList.add('is-credit');
  if (t.type === 'payment') tr.classList.add('is-payment');

  const checkTd = document.createElement('td');
  checkTd.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = isWorkRow;
  box.title = isWorkRow ? 'Move back to All Expenses' : 'Move to Work Expenses';
  box.addEventListener('change', () => {
    if (box.checked) state.workIds.add(t.id);
    else state.workIds.delete(t.id);
    render();
  });
  checkTd.append(box);
  tr.append(checkTd);

  for (const col of COLUMNS) {
    const td = document.createElement('td');
    if (col.cls) td.className = col.cls;

    switch (col.key) {
      case 'transDate':
        td.textContent = t.transDate || t.transDateRaw;
        break;
      case 'weekday': {
        if (t.weekday === undefined) {
          td.textContent = '—';
          break;
        }
        const pill = document.createElement('span');
        pill.className = `pill ${t.isWorkday ? 'pill--work' : 'pill--weekend'}`;
        pill.textContent = DAY_NAMES[t.weekday];
        pill.title = t.isWorkday ? 'Workday (Mon–Fri)' : 'Weekend';
        td.append(pill);
        break;
      }
      case 'description':
        td.title = t.description;
        td.append(document.createTextNode(t.description));
        if (t.details) {
          const fx = document.createElement('span');
          fx.className = 'fx';
          fx.textContent = t.details;
          td.append(fx);
        }
        break;
      case 'amount':
        td.textContent = money.format(t.amount);
        break;
      case 'tax':
        td.textContent = money.format(t.tax);
        break;
      default:
        td.textContent = t[col.key] ?? '';
    }
    tr.append(td);
  }
  return tr;
}

function buildFooter(rows) {
  const tr = document.createElement('tr');
  const label = document.createElement('td');
  label.className = 'label';
  label.colSpan = COLUMNS.length - 1; // checkbox + all but Amount/Tax
  const workdays = rows.filter((r) => r.isWorkday).length;
  label.textContent =
    `${rows.length} ${rows.length === 1 ? 'row' : 'rows'} · ` +
    `${workdays} on workdays`;

  const total = document.createElement('td');
  total.className = 'num';
  total.textContent = money.format(sum(rows, 'amount'));

  const tax = document.createElement('td');
  tax.className = 'num';
  tax.textContent = money.format(sum(rows, 'tax'));

  tr.append(label, total, tax);
  return tr;
}

/* -------------------------------------------------------------------- sort */

function sortRows(rows, { key, dir }) {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp;
    if (key === 'amount' || key === 'tax' || key === 'weekday') {
      cmp = (a[key] ?? 0) - (b[key] ?? 0);
    } else {
      cmp = String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
    }
    // Keep a stable, date-ordered secondary sort so equal keys don't shuffle.
    if (cmp === 0) cmp = String(a.transDate).localeCompare(String(b.transDate));
    return cmp * factor;
  });
}

/* ------------------------------------------------------------------ export */

el.exportAll.addEventListener('click', () =>
  downloadReport(sortRows(visibleRows(), state.sort.all), 'all-expenses'),
);
el.exportWork.addEventListener('click', () =>
  downloadReport(sortRows(workRows(), state.sort.work), 'work-expenses'),
);

/** Fill the loaded template with these rows and download the result. */
async function downloadReport(rows, basename) {
  if (!state.template) {
    setStatus('Load your expense report template first.', true);
    return;
  }
  if (!rows.length) {
    setStatus('Nothing to export in that table.', true);
    return;
  }

  try {
    const { bytes, written, dropped } = await fillTemplate(state.template.bytes, rows);
    const stamp = state.meta.statementDate || new Date().toISOString().slice(0, 10);
    const filename = `${basename}-${stamp}.xlsx`;

    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    if (dropped.length) {
      // Never let rows disappear quietly.
      setStatus(
        `Wrote ${written} line items to ${filename}, but the template only holds ` +
          `${CAPACITY}. ${dropped.length} row(s) did not fit and were left out — ` +
          `narrow the selection or export in batches.`,
        true,
      );
    } else {
      setStatus(`Wrote ${written} line ${written === 1 ? 'item' : 'items'} to ${filename}.`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Could not fill the template: ${err.message}`, true);
  }
}

/* ------------------------------------------------------------------- utils */

function sum(rows, key) {
  return round2(rows.reduce((acc, r) => acc + (r[key] ?? 0), 0));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

initTemplate();
