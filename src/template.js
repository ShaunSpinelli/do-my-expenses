/**
 * Fills the expense report template with line items.
 *
 * The template is used as-is: we open its .xlsx package, rewrite only the two
 * XML parts that need to change, and copy every other part through byte for
 * byte. Nothing else is regenerated, so sheet protection, conditional
 * formatting, data validations, column widths, print setup, the pre-built
 * SUBTOTAL / check / total formulas, the GL-code lookup row and the other
 * worksheets all survive exactly as the template author left them.
 *
 * Only these cells are written, per line item row:
 *   B  Date        (Excel serial; the column is already date-formatted)
 *   C  Supplier
 *   D  Description
 *   E  TOTAL
 *   F  HST/GST
 *
 * Column G (SUBTOTAL), Q/R (the balance check) and row 46 (totals) keep the
 * template's own formulas and are left alone — Excel recalculates them on open.
 */

import { readZip, writeZip, entryText, textEntry } from './zip.js';

const SHEET_PART = 'xl/worksheets/sheet1.xml';
const WORKBOOK_PART = 'xl/workbook.xml';

/** Line item rows in the template, inclusive. */
export const FIRST_ITEM_ROW = 13;
export const LAST_ITEM_ROW = 45;
export const CAPACITY = LAST_ITEM_ROW - FIRST_ITEM_ROW + 1;

/** Excel's epoch is 1899-12-30 (it treats 1900 as a leap year). */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * @param {Uint8Array} templateBytes the .xlsx template, unmodified
 * @param {object[]} transactions line items to write
 * @returns {Promise<{bytes: Uint8Array, written: number, dropped: object[]}>}
 */
export async function fillTemplate(templateBytes, transactions) {
  const entries = readZip(templateBytes);

  const sheet = entries.find((e) => e.path === SHEET_PART);
  if (!sheet) {
    throw new Error(`That workbook has no ${SHEET_PART} — is it the expense report template?`);
  }

  const written = transactions.slice(0, CAPACITY);
  const dropped = transactions.slice(CAPACITY);

  let xml = await entryText(sheet);
  written.forEach((t, i) => {
    xml = writeRow(xml, FIRST_ITEM_ROW + i, t);
  });
  // Clear any leftover sample data in the unused rows.
  for (let r = FIRST_ITEM_ROW + written.length; r <= LAST_ITEM_ROW; r++) {
    xml = clearRow(xml, r);
  }

  const replacements = new Map();
  replacements.set(SHEET_PART, await textEntry(SHEET_PART, xml));

  // The template caches formula results; ask Excel to recalculate on open so
  // SUBTOTAL, the balance check and the totals row reflect the new numbers.
  const workbook = entries.find((e) => e.path === WORKBOOK_PART);
  if (workbook) {
    const wbXml = forceRecalc(await entryText(workbook));
    replacements.set(WORKBOOK_PART, await textEntry(WORKBOOK_PART, wbXml));
  }

  const out = entries.map((e) => replacements.get(e.path) ?? e);
  return { bytes: writeZip(out), written: written.length, dropped };
}

/* ----------------------------------------------------------------- patching */

function writeRow(xml, rowNumber, t) {
  let next = xml;
  next = setCell(next, `B${rowNumber}`, numberCell(dateSerial(t)));
  next = setCell(next, `C${rowNumber}`, stringCell(t.description));
  next = setCell(next, `D${rowNumber}`, stringCell(describe(t)));
  next = setCell(next, `E${rowNumber}`, numberCell(round2(t.amount)));
  next = setCell(next, `F${rowNumber}`, numberCell(round2(t.tax)));
  return next;
}

function clearRow(xml, rowNumber) {
  let next = xml;
  for (const col of ['B', 'C', 'D', 'E', 'F']) {
    next = setCell(next, `${col}${rowNumber}`, () => ({}));
  }
  return next;
}

/**
 * Replace one cell's contents while keeping its attributes — crucially `s`,
 * the style index that carries the template's formatting for that column.
 *
 * `build` receives the existing attribute string and returns the inner XML
 * plus any extra attributes.
 */
function setCell(xml, ref, build) {
  // Matches both `<c r="B13" s="16"/>` and `<c r="B13" s="16">…</c>`.
  const pattern = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>.*?</c>)`, 's');
  const match = pattern.exec(xml);
  if (!match) {
    throw new Error(
      `Template cell ${ref} not found — the template layout differs from the one this app expects.`,
    );
  }

  // Drop any existing type attribute; the replacement sets its own.
  const attrs = match[1].replace(/\s+t="[^"]*"/g, '');
  const inner = build(attrs);
  const replacement = inner.body
    ? `<c r="${ref}"${attrs}${inner.attrs ?? ''}>${inner.body}</c>`
    : `<c r="${ref}"${attrs}/>`;

  return xml.slice(0, match.index) + replacement + xml.slice(match.index + match[0].length);
}

function numberCell(value) {
  return () => (value === null ? {} : { body: `<v>${value}</v>` });
}

/**
 * Written as an inline string so we never have to touch sharedStrings.xml —
 * adding entries there would mean renumbering every existing reference.
 */
function stringCell(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return () => ({});
  return () => ({
    attrs: ' t="inlineStr"',
    body: `<is><t xml:space="preserve">${escapeXml(clean)}</t></is>`,
  });
}

function forceRecalc(xml) {
  if (/<calcPr[^>]*\bfullCalcOnLoad="1"/.test(xml)) return xml;
  if (/<calcPr[^>]*\/>/.test(xml)) {
    return xml.replace(/<calcPr([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
  }
  return xml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
}

/* -------------------------------------------------------------------- values */

function dateSerial(t) {
  if (!t.transDate) return null;
  const [y, m, d] = t.transDate.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - EXCEL_EPOCH) / 86400000;
}

/** Description column: the statement's own category, plus any FX detail line. */
function describe(t) {
  return [t.category, t.details].filter(Boolean).join(' — ');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function round2(n) {
  return Math.round((n ?? 0) * 100) / 100;
}
