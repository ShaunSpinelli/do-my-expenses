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

> `.gitignore` excludes `*.pdf`. GitHub Pages serves repo contents publicly even
> when the repo is private, so a real statement committed here would be fetchable
> by anyone who guessed the filename. Keep statements local — the app reads them
> in your browser and never uploads them, so nothing needs to be committed.

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
- **CSV export** for either table.

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
src/app.js              UI: upload, filters, tables, selection, CSV
src/parser.js           PDF → transaction rows (no DOM dependencies)
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
