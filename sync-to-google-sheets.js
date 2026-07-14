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

const SHEET_NAME = 'Sheet1';
const HEADER_ROW = ['Starred', 'Status', 'Source', 'Price (€)', 'Rooms', 'm²', 'Area', 'Address', 'Elevator', 'Furnished', 'Balcony', 'URL'];
// Column index of each field, matching HEADER_ROW order (0-based)
const COL = { starred: 0, status: 1, source: 2, price: 3, rooms: 4, sqm: 5, area: 6, address: 7, elevator: 8, furnished: 9, balcony: 10, url: 11 };

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

async function readExistingStarred(sheets, sheetId) {
  // Returns a Map from URL -> { starred, rowValues } for everything
  // currently in the sheet, so we know what to carry forward.
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${SHEET_NAME}!A2:L`
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

async function syncToGoogleSheets(listingsJsonPath) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    throw new Error('GOOGLE_SHEET_ID environment variable is not set.');
  }

  const data = JSON.parse(fs.readFileSync(listingsJsonPath, 'utf8'));
  const freshListings = data.listings || [];

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`[Sheets] Reading existing sheet ${sheetId}...`);
  const existingByUrl = await readExistingStarred(sheets, sheetId);
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
      l.rooms ?? '',
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
    range: `${SHEET_NAME}!A2:L`
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A1:L1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER_ROW] }
  });

  if (outputRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_NAME}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: outputRows }
    });
  }

  console.log(`[Sheets] ✅ Synced ${outputRows.length} rows to Google Sheets.`);
}

async function main() {
  const jsonPath = process.argv[2] || 'listings.json';
  await syncToGoogleSheets(jsonPath);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error('[Sheets] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { syncToGoogleSheets };
