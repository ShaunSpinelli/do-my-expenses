# Do My Expenses

A static, no-build web page that parses a credit card statement PDF and shows the
expenses in a table. Parsing happens entirely in the browser — the PDF is never
uploaded anywhere.

**Live:** <https://shaunspinelli.github.io/do-my-expenses/>

## Running it locally

pdf.js ships as an ES module and runs its parser in a Web Worker, so the page has
to be served over HTTP — opening `index.html` as a `file://` URL will not work.

```sh
python3 -m http.server 8912
```

Then open <http://localhost:8912/index.html> and drop in a statement PDF.

> `.gitignore` excludes `*.pdf` and `*.xlsx`. GitHub Pages serves repo contents
> publicly, so a real statement or the expense report template committed here
> would be fetchable by anyone who guessed the filename. Keep both local — the app
> reads them in your browser and never uploads them, so nothing needs committing.

## What you get

- **All Expenses** — every transaction found in the statement.
- **Work Expenses** — tick a row's checkbox in *All Expenses* and it moves here;
  untick it to send it back. Each table totals its own rows.
- **Workday flag** — the `Day` column shows the weekday the transaction was made,
  as a green pill for Mon–Fri and a grey one for Sat/Sun. "Workdays only" in the
  filter bar hides weekend rows.
- **Tax** — a per-row column and a total, calculated as **13% of the amount**
  (see the note below).
- **Filters** — free-text search, spend category, workdays only, and a toggle to
  include statement payments (hidden by default, since they aren't expenses).
- **Fill template** for either table — writes your line items into your real
  expense report template (see below).

## Filling the expense report template

Drop your expense report template in the project root as **`template.xlsx`** and
the app loads it automatically as the default — no picking needed. Otherwise
**Choose template** picks one, and it's remembered on your device (a template you
pick yourself always wins over the bundled default, since yours may be newer).
Then **Fill template** on either table downloads a filled copy.

`template.xlsx` is **gitignored on purpose**, so the default only exists where you
put the file — locally. It is an internal document: besides the grid it carries the
GL chart of accounts, the department list, the finance process notes and the
original author's name in its metadata. This repo is public and its history is
permanent, so the file is not committed. The deployed site therefore asks you to
pick it once. The template's own instructions also say to always take the latest
copy from SharePoint, so a committed snapshot would go stale anyway.

The template is used *as-is*. The app opens its `.xlsx` package, rewrites only
`xl/worksheets/sheet1.xml` and `xl/workbook.xml`, and copies every other part of
the archive through byte for byte. Sheet protection, conditional formatting, data
validations, column widths, print setup, the pre-built `SUBTOTAL`/check/total
formulas, the GL-code rows and the other worksheets all survive exactly as the
template author left them.

Five cells are written per line item row:

| Column | Value |
|---|---|
| `B` Date | transaction date (Excel serial — the column is already date-formatted) |
| `C` Supplier | merchant string from the statement |
| `D` Description | the statement's own spend category |
| `E` TOTAL | amount |
| `F` HST/GST | tax |

Everything else is left to the template: `G` (SUBTOTAL), `Q`/`R` (the balance
check) and the totals row keep their own formulas, and the workbook is flagged to
recalculate on open so they pick up the new numbers. The per-category columns
(`H`–`P`), the GL-code row and the `Name`/`Department`/`Date` header fields are
not touched.

The template holds **33 line items** (rows 13–45). If a table has more rows than
that, the export fills what fits and tells you exactly how many were left out —
it never truncates silently.

New strings are written as inline strings rather than added to
`xl/sharedStrings.xml`, since appending there would mean renumbering every
existing reference.

Because the template is patched rather than regenerated, a revised template drops
straight in — no code change needed, as long as the line-item block still starts at
row 13 with `Date / Supplier / Description / TOTAL / HST/GST` in columns B–F. If it
doesn't, the export fails loudly naming the cell it couldn't find, rather than
writing values into the wrong columns.

> A spreadsheet library was the other option here, and it was rejected: reading
> and re-writing the workbook through one drops the features it doesn't model —
> sheet protection, conditional formatting, data validations, printer settings.
> Patching the archive in place is what makes "the exact template" true.

The template file is **not** committed — it is an internal document carrying
department numbers and GL account lookups, and this repo is public. It is read
from your machine at export time and never uploaded.

## A note on the tax column

The tax column is `amount × 0.13`, as specified.

Worth knowing: card statement amounts are what you actually paid, so they already
include sales tax. If you want the HST *contained in* a total rather than 13%
added on top, the arithmetic is `amount × 0.13 / 1.13` (≈ 11.5%) — on a $1,000
total that is $115.04 rather than $130.00. Change how `TAX_RATE` is applied in
`src/app.js` if you want that instead.

## Layout

```
index.html              markup
src/styles.css          styles (light + dark)
src/app.js              UI: upload, filters, tables, selection, export
src/parser.js           PDF → transaction rows (no DOM dependencies)
src/template.js         writes line items into the template's sheet XML
src/zip.js              minimal ZIP read/write, preserving untouched parts
vendor/pdfjs/           pdf.js 6.1.200, vendored so there's no CDN or install step
.nojekyll               stops GitHub Pages running the files through Jekyll
```

## How the parser works

`src/parser.js` reads pdf.js text items with their coordinates rather than a flat
text dump, because the statement prints two columns on shared baselines and a flat
read interleaves unrelated text.

For each page it looks for the transaction table's header row (`Description`,
`Spend Categories`, `Amount($)`) and derives the column boundaries from where
those labels sit — the continuation pages are indented about 36pt, so fixed
offsets would not survive page 3. Rows are then split into trans date / post date
/ description / category / amount by x-position.

It also handles the statement's quirks: barcode text in the left margin that
shares a baseline with a real row, the points-multiplier glyph printed in the
gutter before some merchant names, foreign-currency rows whose exchange-rate line
wraps onto a line of its own, credits printed with a trailing minus, and
transaction dates that carry no year (anchored to the statement date, rolling back
a year for rows that would otherwise land in the future).

Verified against a real CIBC Visa statement: every charge was extracted, and the
sum reconciled to the cent against the statement's own `Total for <card number>`
line, as did the payments section.
