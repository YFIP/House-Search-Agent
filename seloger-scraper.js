// seloger-scraper.js
// Production version of the SeLoger scraper — first page only (~31
// listings). Pagination was attempted via three different strategies
// (numbered buttons, click-based "next" button, URL parameters) and all
// three failed for specific, understood reasons — documented below for
// whoever revisits this later. First-page extraction itself is solid:
// verified correct across many live runs, zero bot-blocking encountered
// even under sustained interaction.
//
// PAGINATION — NOT SOLVED, kept here for whoever picks this back up:
//   1. Numbered page buttons (1, 2, 3, ...N): the bar shows a FIXED set
//      that doesn't reveal nearby numbers as you advance — there's no
//      literal "4" button to find/click after reaching page 3.
//   2. Icon-only "next" button (aria-label="page suivante"): found and
//      confirmed correctly targeted (not disabled, not covered by an
//      overlay after fixing a real click-interception bug), but clicking
//      it — even with Puppeteer's real mouse click — never advanced the
//      page. Root cause unconfirmed; the button uses React Aria
//      (data-react-aria-pressable="true"), which has known quirks around
//      what counts as a "real" interaction.
//   3. URL parameter (?LISTING-LISTpg=2): confirmed to exist for a
//      DIFFERENT SeLoger URL template (/immobilier/achat/...) via
//      external research, but produced 29/31 overlapping (i.e. not
//      actually different) results on the /recherche/location/... URL
//      template used here. Likely template-specific; untested on the
//      older URL style.
//
// Given the project's move to scheduled (not live on-demand) scraping,
// 31 fresh listings per run, twice daily, is a reasonable interim outcome
// — not exhaustive, but continuously sampling new listings over time.

const parseListing = require('./parse-listing');

const URL_RENT = 'https://www.seloger.com/recherche/location/appartement/ile-de-france/paris-75000/ad08fr31096';
const LISTING_SELECTOR = 'a[href*="/annonces/locations/"]';

async function getBrowser() {
  const puppeteer = require('puppeteer');
  return withTimeout(
    puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1920, height: 1080 },
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
    }),
    30000,
    'Launching local Chrome via Puppeteer (SeLoger)'
  );
}

// Same fix as scrape-runner.js — browser launch previously had no timeout
// protection at all, unlike every other wait in this file.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/annonces/locations/"]'));

  for (const link of links) {
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);

    let container = link;
    let text = '';
    for (let i = 0; i < 8; i++) {
      container = container.parentElement;
      if (!container) break;
      text = container.innerText || '';
      if (text.includes('€')) break;
    }

    if (text.includes('€')) {
      results.push({ url: href.split('?')[0], rawText: text.slice(0, 500) });
    }
  }

  return results;
}

async function scrapeSeLoger(searchType = 'rent') {
  let browser;
  let page;

  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(30000);

    const url = URL_RENT; // only rent URL confirmed working so far
    console.log(`[SeLoger] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(err => {
      console.warn(`[SeLoger] Navigation warning: ${err.message}`);
    });

    await new Promise(r => setTimeout(r, 3000)); // let consent banner / JS challenge settle

    try {
      await page.waitForSelector(LISTING_SELECTOR, { timeout: 15000 });
    } catch (e) {
      console.warn(`[SeLoger] Selector timeout — page may not have loaded listings.`);
    }

    const rawListings = await page.evaluate(extractListings);
    console.log(`[SeLoger] Raw extracted: ${rawListings.length}`);

    const parsed = rawListings.map(item => {
      const listing = parseListing(item.rawText);
      listing.url = item.url;
      listing.source = 'SeLoger';
      listing.searchType = searchType;
      listing.isExactListing = true;
      return listing;
    });

    const valid = parsed.filter(l => l.price > 0 || l.priceOnRequest || l.address);
    console.log(`[SeLoger] Valid listings: ${valid.length}`);

    await browser.close();
    return { source: 'SeLoger', searchType, listings: valid, error: null };

  } catch (error) {
    console.error(`[SeLoger] Error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'SeLoger', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeSeLoger };
