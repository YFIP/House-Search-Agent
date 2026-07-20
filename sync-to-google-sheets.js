// sync-to-google-sheets.js
//
// Syncs the freshly scraped listings (from listings.json) into a Google
// Sheet — WITHOUT losing anything the person has starred by hand. This is
// the whole point of moving to Sheets instead of a plain downloaded
// Excel file: the automation and the person can both read/write the same
// live document, so starring survives every future automated run.
//
// How preservation works:
//   1. Read whatever's currently in the Sheet first (before writing
//      anything), specifically the Starred column, keyed by each
//      listing's URL (a natural unique key — every listing has one).
//   2. For each freshly scraped listing: if its URL was already starred,
//      carry that forward. If it's new, it starts unstarred.
//   3. For anything that WAS starred but is no longer in the fresh
//      scrape (rented, sold, or delisted) — keep the row, but mark it
//      "No Longer Listed" instead of silently deleting it. A starred
//      listing never just disappears without the person seeing why.
//   4. Anything unstarred and no longer present is dropped, same as
//      before — this only changes behavior for starred listings.
//
// Requires GOOGLE_SHEETS_CREDENTIALS (the full service-account JSON, as
// a string) and GOOGLE_SHEET_ID as environment variables — passed in via
// GitHub Secrets in the workflow, never committed to the repo.

const fs = require('fs');
const { google } = require('googleapis');

const HEADER_ROW = ['Starred', 'Status', 'Source', 'Price (€)', 'Bedrooms', 'Bathrooms', 'm²', 'Area', 'Address', 'Elevator', 'Furnished', 'Balcony', 'URL'];
// Column index of each field, matching HEADER_ROW order (0-based)
const COL = { starred: 0, status: 1, source: 2, price: 3, bedrooms: 4, bathrooms: 5, sqm: 6, area: 7, address: 8, elevator: 9, furnished: 10, balcony: 11, url: 12 };
// Derived automatically from HEADER_ROW's length rather than
// hardcoded, after a real bug: adding the Bathrooms column (12 -> 13
// columns, A-L -> A-M) but leaving 3 separate hardcoded "L" range
// references unchanged caused a live failure ("tried writing to column
// [M]" — outside the declared A1:L1 range). Deriving this means adding
// another column in the future can't reintroduce the same class of bug.
const LAST_COL_LETTER = String.fromCharCode(64 + HEADER_ROW.length); // 65 = 'A', so 64 + length gives the right letter for lengths up to 26

async function ensureSheetExists(sheets, sheetId, sheetName) {
  // Rent and sale prices are wildly different scales (hundreds vs
  // millions of euros) — a separate tab per type keeps sorting/filtering
  // sane, rather than mixing both into one sheet with a Type column.
  // Auto-creates the tab if it doesn't exist yet, so this never depends
  // on a manual one-time setup step being remembered.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === sheetName);
  if (!exists) {
    console.log(`[Sheets] Tab "${sheetName}" doesn't exist yet — creating it.`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
    });
  }
}

function getAuth() {
  const credsJson = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!credsJson) {
    throw new Error('GOOGLE_SHEETS_CREDENTIALS environment variable is not set — check the GitHub Secret and the workflow step that passes it in.');
  }
  const credentials = JSON.parse(credsJson);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

function yesNoBlank(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return '';
}

async function readExistingStarred(sheets, sheetId, sheetName) {
  // Returns a Map from URL -> { starred, rowValues } for everything
  // currently in the sheet, so we know what to carry forward.
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A2:${LAST_COL_LETTER}`
    });
    const rows = res.data.values || [];
    const map = new Map();
    for (const row of rows) {
      const url = row[COL.url];
      if (!url) continue;
      map.set(url, { starred: row[COL.starred] || '', rowValues: row });
    }
    return map;
  } catch (error) {
    // Genuinely empty/new sheet (no data yet) is expected on the very
    // first run — don't treat that as a fatal error.
    if (error.message && error.message.includes('Unable to parse range')) {
      console.log('[Sheets] Sheet appears empty or newly created — starting fresh.');
      return new Map();
    }
    throw error;
  }
}

async function syncToGoogleSheets(listingsJsonPath, sheetName = 'Sheet1') {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    throw new Error('GOOGLE_SHEET_ID environment variable is not set.');
  }

  const data = JSON.parse(fs.readFileSync(listingsJsonPath, 'utf8'));
  const freshListings = data.listings || [];

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheets, sheetId, sheetName);

  console.log(`[Sheets] Reading existing "${sheetName}" tab in sheet ${sheetId}...`);
  const existingByUrl = await readExistingStarred(sheets, sheetId, sheetName);
  console.log(`[Sheets] Found ${existingByUrl.size} existing row(s), ${[...existingByUrl.values()].filter(v => v.starred).length} starred.`);

  const freshUrls = new Set(freshListings.map(l => l.url));
  const outputRows = [];

  // Fresh listings first, carrying forward star status where it existed
  for (const l of freshListings) {
    const existing = existingByUrl.get(l.url);
    outputRows.push([
      existing ? existing.starred : '',
      'Active',
      l.source || '',
      l.priceOnRequest ? 'On request' : (l.price || ''),
      l.bedrooms ?? '',
      l.bathrooms ?? '',
      l.sqm ?? '',
      (l.normalizedArea && l.normalizedArea.area) || '',
      l.address || '',
      yesNoBlank(l.elevator),
      yesNoBlank(l.furnished),
      yesNoBlank(l.balcony),
      l.url || ''
    ]);
  }

  // Starred listings that disappeared from the fresh scrape — keep them,
  // marked as no longer listed, instead of silently dropping them.
  let carriedOverCount = 0;
  for (const [url, entry] of existingByUrl) {
    if (freshUrls.has(url)) continue; // already included above
    if (!entry.starred) continue; // unstarred and gone — fine to drop
    const row = [...entry.rowValues];
    row[COL.status] = 'No Longer Listed';
    // Pad row to full width in case the sheet had fewer columns before
    while (row.length < HEADER_ROW.length) row.push('');
    outputRows.push(row);
    carriedOverCount++;
  }
  if (carriedOverCount > 0) {
    console.log(`[Sheets] Carried forward ${carriedOverCount} starred listing(s) no longer live, marked "No Longer Listed".`);
  }

  console.log(`[Sheets] Writing ${outputRows.length} total row(s)...`);

  // Clear the whole data range first, then write fresh — simpler and
  // safer than trying to diff/update individual rows, since row order
  // isn't meaningful here anyway (the person can sort/filter in Sheets).
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${sheetName}!A2:${LAST_COL_LETTER}`
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1:${LAST_COL_LETTER}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER_ROW] }
  });

  if (outputRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${sheetName}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: outputRows }
    });
  }

  console.log(`[Sheets] ✅ Synced ${outputRows.length} rows to Google Sheets.`);
}

async function main() {
  const rentPath = process.argv[2] || 'listings.json';
  const salePath = process.argv[3]; // optional - only sync sale if provided

  await syncToGoogleSheets(rentPath, 'Sheet1');

  if (salePath && fs.existsSync(salePath)) {
    await syncToGoogleSheets(salePath, 'Sale');
  } else if (salePath) {
    console.log(`[Sheets] Sale file "${salePath}" was specified but doesn't exist — skipping sale sync.`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error('[Sheets] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { syncToGoogleSheets };
