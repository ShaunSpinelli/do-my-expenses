/**
 * Remembers which template expense category you chose for a given merchant or
 * statement category, so the choice only has to be made once.
 *
 * Two maps are kept, and looked up in this order:
 *   1. by merchant  — precise: "this shop is always MEALS"
 *   2. by statement category — the fallback: "anything Restaurants is MEALS"
 * A miss in both leaves the row for you to pick.
 *
 * Persisted in localStorage; never leaves the browser.
 */

const STORAGE_KEY = 'expense-category-mappings';

/**
 * Statement descriptions embed a per-transaction reference — every PRESTO fare
 * reads "PRESTO FARE/<unique id> TORONTO ON" — so matching the raw string would
 * never hit twice for the same merchant. Reduce it to a stable merchant key by
 * dropping phone numbers and id-looking tokens.
 */
export function merchantKey(description) {
  const raw = String(description ?? '').toUpperCase();
  const key = raw
    // Phone numbers, whether grouped "866-216-1072" or "844-5052993".
    .replace(/\b\d{3}[-.]\d{3}[-.]?\d{4}\b|\b\d{3}[-.]\d{4,7}\b/g, ' ')
    // Reference tokens, 6+ chars, either mixing letters and digits...
    .replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\b/g, ' ')
    // ...or all letters with no vowel, which no real merchant word is
    // ("RZKRRLKSZG" goes, "BANTSYROOST" stays).
    .replace(/\b(?![A-Z]*[AEIOU])[A-Z]{6,}\b/g, ' ')
    .replace(/[^A-Z0-9#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If normalising ate almost everything, the key would over-match unrelated
  // merchants — keep the original instead.
  return key.length >= 3 ? key : raw.replace(/\s+/g, ' ').trim();
}

export function emptyMappings() {
  return { byMerchant: {}, byCategory: {} };
}

export function loadMappings() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return emptyMappings();
    const parsed = JSON.parse(stored);
    return {
      byMerchant: parsed?.byMerchant ?? {},
      byCategory: parsed?.byCategory ?? {},
    };
  } catch {
    return emptyMappings();
  }
}

export function saveMappings(mappings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings));
  } catch {
    // Storage blocked or full: mappings still apply for this session.
  }
}

export function clearMappings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing cached to clear */
  }
  return emptyMappings();
}

/** Merchant first, then statement category, then nothing. */
export function suggestCategory(mappings, transaction) {
  const byMerchant = mappings.byMerchant[merchantKey(transaction.description)];
  if (byMerchant) return byMerchant;
  const byCategory = mappings.byCategory[transaction.category];
  return byCategory ?? null;
}

/**
 * Record a choice against both the merchant and the statement category.
 *
 * The category map holds the most recent choice for that statement category. It
 * is only ever a fallback — a merchant entry wins — so a one-off (say a client
 * dinner booked to SALES EXPENSE) still leaves that merchant pinned correctly.
 */
export function rememberCategory(mappings, transaction, label) {
  mappings.byMerchant[merchantKey(transaction.description)] = label;
  if (transaction.category) mappings.byCategory[transaction.category] = label;
  saveMappings(mappings);
}

/** Clearing a row's category forgets the merchant rule it taught. */
export function forgetMerchant(mappings, transaction) {
  delete mappings.byMerchant[merchantKey(transaction.description)];
  saveMappings(mappings);
}

export function countMappings(mappings) {
  return (
    Object.keys(mappings.byMerchant).length + Object.keys(mappings.byCategory).length
  );
}
