/**
 * Statement parser.
 *
 * Turns a credit-card statement PDF into transaction rows. Built against CIBC
 * Visa statements, which lay their transaction table out in fixed columns:
 *
 *   Trans date | Post date | Description | Spend Categories | Amount($)
 *
 * Rather than hard-coding pixel offsets (they shift from page to page — the
 * continuation pages are indented ~36pt), we locate the column header row on
 * each page and derive the column boundaries from where its labels sit. Any
 * statement that keeps those headers parses the same way.
 */

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "Jun 02", "Jul 3" — the short form used in the transaction columns.
const SHORT_DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})\b/i;
// "July 3, 2026" — the long form used in the statement header.
const LONG_DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i;
// "1,234.56", "1,234.56-" (trailing minus = credit), "-1,234.56", "$1,234.56".
const AMOUNT_RE = /^\$?\s*(-)?([\d,]+\.\d{2})\s*(-)?$/;

// Rows that sit inside the table but aren't transactions.
const NOISE_RE = /^(total\b|card number\b|prepared for\b|page \d|trans\b|sub-?total\b|closing balance\b|opening balance\b)/i;

const ROW_TOLERANCE = 2.5; // pt — items this close vertically are one row

/**
 * @param {object} pdfDoc a pdf.js PDFDocumentProxy
 * @returns {Promise<{transactions: object[], meta: object, warnings: string[]}>}
 */
export async function parseStatement(pdfDoc) {
  const pages = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const content = await page.getTextContent();
    pages.push(toRows(content.items));
  }

  const meta = extractMeta(pages);
  const { transactions, warnings } = extractTransactions(pages);

  resolveYears(transactions, meta.statementDate);

  return { transactions, meta, warnings };
}

/* ------------------------------------------------------------------ layout */

/** Collapse pdf.js text items into rows of {x, text}, top of page first. */
function toRows(items) {
  const glyphs = items
    .filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
    .map((it) => ({
      x: it.transform[4],
      y: it.transform[5],
      text: it.str,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  for (const g of glyphs) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - g.y) <= ROW_TOLERANCE) {
      last.cells.push(g);
    } else {
      rows.push({ y: g.y, cells: [g] });
    }
  }

  for (const row of rows) {
    row.cells.sort((a, b) => a.x - b.x);
    row.text = normalize(row.cells.map((c) => c.text).join(' '));
  }
  return rows;
}

function normalize(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Find the transaction-table header on a page and turn it into column
 * boundaries. Returns null if this page has no such header.
 */
function findColumns(row) {
  const find = (label) =>
    row.cells.find((c) => normalize(c.text).toLowerCase() === label);

  const desc = find('description');
  const amount = row.cells.find((c) => /^amount\s*\(\$?\)?/i.test(normalize(c.text)));
  if (!desc || !amount) return null;

  const category = find('spend categories') || find('category') || find('categories');

  // The two date columns are whatever labels sit left of Description.
  const leading = row.cells.filter((c) => c.x < desc.x - 1).sort((a, b) => a.x - b.x);
  if (leading.length < 2) return null;
  const transX = leading[0].x;
  const postX = leading[1].x;

  return {
    leftEdge: transX - 8,
    postStart: (transX + postX) / 2,
    descStart: (postX + desc.x) / 2,
    descTextStart: desc.x,
    // Categories are preceded by an icon, so their text starts well right of
    // the header label — back off only a hair so descriptions never bleed in.
    catStart: category ? category.x - 4 : null,
    amountStart: amount.x - 8,
  };
}

/** Split a row's glyphs into the five logical columns. */
function splitRow(row, cols) {
  const out = { trans: [], post: [], desc: [], cat: [], amount: [] };
  for (const cell of row.cells) {
    // Page furniture (barcodes, bleed marks) lives in the left margin and can
    // land on the same baseline as a real row.
    if (cell.x < cols.leftEdge) continue;
    // Some rows carry a one-glyph points-multiplier marker in the gutter just
    // left of where descriptions actually begin. Drop it, but only if it's too
    // short to be real text.
    if (
      cell.x >= cols.descStart &&
      cell.x < cols.descTextStart - 6 &&
      cell.text.trim().length <= 2
    ) {
      continue;
    }
    if (cell.x >= cols.amountStart) out.amount.push(cell.text);
    else if (cols.catStart !== null && cell.x >= cols.catStart) out.cat.push(cell.text);
    else if (cell.x >= cols.descStart) out.desc.push(cell.text);
    else if (cell.x >= cols.postStart) out.post.push(cell.text);
    else out.trans.push(cell.text);
  }
  return {
    trans: normalize(out.trans.join(' ')),
    post: normalize(out.post.join(' ')),
    desc: normalize(out.desc.join(' ')),
    cat: normalize(out.cat.join(' ')),
    amount: normalize(out.amount.join(' ')),
  };
}

/* ------------------------------------------------------------ transactions */

function extractTransactions(pages) {
  const transactions = [];
  const warnings = [];
  let section = null; // 'payments' | 'charges'
  let last = null;

  pages.forEach((rows, pageIndex) => {
    let cols = null; // column layout is per-page; section carries across pages

    for (const row of rows) {
      const detected = findColumns(row);
      if (detected) {
        cols = detected;
        last = null;
        continue;
      }

      const heading = row.text.toLowerCase();
      if (/^your payments\b/.test(heading)) {
        section = 'payments';
        last = null;
        continue;
      }
      if (/^your new charges and credits\b/.test(heading)) {
        section = 'charges';
        last = null;
        continue;
      }

      if (!cols || !section) continue;
      if (NOISE_RE.test(row.text)) {
        last = null;
        continue;
      }

      const parts = splitRow(row, cols);
      const transDate = matchShortDate(parts.trans);

      if (!transDate) {
        // A row with a description but no date or amount continues the
        // transaction above it — e.g. the "32.99 AUD @ 1.0078**" line under a
        // foreign-currency charge.
        if (last && parts.desc && !parts.amount && !parts.cat) {
          last.details = last.details ? `${last.details} ${parts.desc}` : parts.desc;
        } else {
          last = null;
        }
        continue;
      }

      const amount = parseAmount(parts.amount);
      if (amount === null) {
        if (parts.desc) {
          warnings.push(`Page ${pageIndex + 1}: skipped "${truncate(row.text, 60)}" — no amount found.`);
        }
        last = null;
        continue;
      }

      last = {
        transDateRaw: parts.trans,
        transMonth: transDate.month,
        transDay: transDate.day,
        transDate: null, // filled in by resolveYears
        postDateRaw: parts.post,
        description: stripFlags(parts.desc),
        details: '',
        category: parts.cat || (section === 'payments' ? 'Payment' : 'Uncategorized'),
        amount,
        type: section === 'payments' ? 'payment' : 'charge',
        page: pageIndex + 1,
      };
      transactions.push(last);
    }
  });

  return { transactions, warnings };
}

/** Drop the points-multiplier arrow glyph some rows carry before the merchant. */
function stripFlags(desc) {
  return desc.replace(/^[^A-Za-z0-9$*#(]+\s*/, '').trim() || desc;
}

function parseAmount(text) {
  if (!text) return null;
  const m = AMOUNT_RE.exec(text);
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  // CIBC prints credits with a trailing minus.
  return m[1] || m[3] ? -value : value;
}

function matchShortDate(text) {
  const m = SHORT_DATE_RE.exec(text || '');
  if (!m) return null;
  return { month: MONTHS[m[1].toLowerCase()], day: Number(m[2]) };
}

/**
 * Transaction rows carry no year. Anchor them to the statement date, rolling
 * back a year for rows that would otherwise land in the future — which is how
 * a December charge on a January statement is handled.
 */
function resolveYears(transactions, statementDate) {
  if (!statementDate) return;
  const anchor = new Date(statementDate);
  for (const t of transactions) {
    let year = anchor.getFullYear();
    let d = new Date(year, t.transMonth, t.transDay);
    if (d - anchor > 45 * 24 * 3600 * 1000) {
      year -= 1;
      d = new Date(year, t.transMonth, t.transDay);
    }
    t.transDate = toISO(d);
    t.weekday = d.getDay(); // 0 = Sunday
    t.isWorkday = t.weekday >= 1 && t.weekday <= 5;
  }
}

function toISO(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* -------------------------------------------------------------------- meta */

/**
 * The summary page is two columns printed on shared baselines, so reading it
 * line-by-line interleaves unrelated text. Instead we treat it as positioned
 * cells and read each label's value from directly below it (how this statement
 * stacks label/value), falling back to the same row on its right.
 */
function extractMeta(pages) {
  const rows = pages[0] || [];
  const find = (re) => {
    for (let r = 0; r < rows.length; r++) {
      for (const cell of rows[r].cells) {
        if (re.test(normalize(cell.text))) return { row: r, cell };
      }
    }
    return null;
  };

  const valueFor = (re) => {
    const hit = find(re);
    if (!hit) return null;
    // Alongside the label first ("Limit   $9,000.00"), staying close enough
    // that we can't reach across into the other column.
    const right = rows[hit.row].cells
      .filter((c) => c.x > hit.cell.x + 4 && c.x < hit.cell.x + 130 && normalize(c.text))
      .sort((a, b) => a.x - b.x)[0];
    if (right) return normalize(right.text);
    // Otherwise stacked beneath it ("Statement Date" / "July 3, 2026").
    for (let r = hit.row + 1; r < Math.min(hit.row + 4, rows.length); r++) {
      const below = rows[r].cells.find((c) => Math.abs(c.x - hit.cell.x) < 12);
      if (below && normalize(below.text)) return normalize(below.text);
    }
    return null;
  };

  const statementDateText = valueFor(/^statement date$/i);

  return {
    cardholder: extractCardholder(rows, find(/^account number$/i)),
    accountNumber: valueFor(/^account number$/i),
    statementDateText,
    statementDate: parseLongDate(statementDateText),
    period: valueFor(/statement period$/i),
    creditLimit: valueFor(/^limit$/i),
    available: valueFor(/^available$/i),
  };
}

/** The name sits above the account-number label, wrapped across 1-2 lines. */
function extractCardholder(rows, accountLabel) {
  if (!accountLabel) return null;
  const parts = [];
  const stopAt = Math.max(0, accountLabel.row - 4);
  for (let r = accountLabel.row - 1; r >= stopAt && parts.length < 2; r--) {
    const cell = rows[r].cells.find((c) => Math.abs(c.x - accountLabel.cell.x) < 12);
    const text = cell ? normalize(cell.text) : '';
    if (!text) continue; // rows that only carry left-column text
    if (!/^[A-Z][A-Z .'-]*$/.test(text)) break;
    parts.unshift(text);
  }
  return parts.length ? titleCase(parts.join(' ')) : null;
}

function parseLongDate(text) {
  const m = LONG_DATE_RE.exec(text || '');
  if (!m) return null;
  return toISO(new Date(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2])));
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bMr\b/, 'Mr');
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
