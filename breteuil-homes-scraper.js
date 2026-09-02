// breteuil-homes-scraper.js
//
// NEW FILE. Breteuil Remarkable Homes — luxury agency with ~15 Paris
// shops plus Neuilly/Ouest Parisien, and international listings (London,
// Basque Coast, etc).
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://breteuilhomes.com/louer — a combined feed across
//     Paris, Ouest Parisien, AND London (no location filter applied by
//     default; the site's location picker is a client-side checkbox UI,
//     not a simple URL param, so it wasn't used here).
//   - Sale: https://breteuilhomes.com/achat (same site, "Acheter" nav
//     link) — not independently verified.
//   - Currency naturally separates markets: Paris/Ouest Parisien prices
//     are in "€", London prices in "£". Since the extractor only keeps
//     listings whose container text includes "€", London listings are
//     excluded automatically — no separate location filtering needed.
//   - Listing link pattern: a[href*="/proprietes/"] — e.g.
//     /proprietes/6pieces-parc-monceau-93191.
//   - Price format: "11 000 € par mois" (spaces around, no slash) —
//     doesn't match parse-listing.js's specific "€/mois" rentAfter
//     regex (no slash present), so it correctly falls through to the
//     generic saleAfter/saleBefore price regex, which only needs a
//     number immediately before "€" — same situation already confirmed
//     working for Perenium/Orpi.
//   - No numbered pagination markers seen (~24 listings on one fetch,
//     no "page 2" link) — probing a `?page=N` fallback defensively.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://breteuilhomes.com/louer';
const SALE_URL = 'https://breteuilhomes.com/achat';
const LISTING_SELECTOR = 'a[href*="/proprietes/"]';
const MAX_PAGES = 8; // safety cap; no pagination directly observed
const DETAIL_FETCH_CONCURRENCY = 2;

// BUG FIX (2026-09-02): switched to puppeteer-extra + stealth plugin,
// same fix that took AFR Immobilier from 0 to 18 listings. Confirmed
// live this site's listings ARE genuinely mostly "LOUÉ" (fixed
// separately, see the whole-word regex fix below) — but 1 remaining
// listing after that fix is still suspiciously low for a multi-office
// agency, so applying the same stealth fix as a next step.
async function getBrowser() {
  const puppeteerExtra = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());
  return puppeteerExtra.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function fetchListingDetails(browser, url, isRetry = false) {
  let page;
  try {
    await new Promise(r => setTimeout(r, 400 + Math.random() * 400));
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(20000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    await page.close();
    if (bodyText.length < 500 && !isRetry) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      return fetchListingDetails(browser, url, true);
    }
    return extractDetailFeatures(bodyText);
  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    return { elevator: null, balcony: null, furnished: null, bathroomsFromDetail: null, bedroomsFromDetail: null };
  }
}

async function enrichWithDetails(browser, listings) {
  if (listings.length === 0) return listings;
  const details = await mapWithConcurrency(listings, DETAIL_FETCH_CONCURRENCY, (listing) =>
    fetchListingDetails(browser, listing.url)
  );
  return listings.map((listing, i) => {
    const d = details[i];
    return {
      ...listing,
      elevator: mergeFeature(d.elevator, listing.elevator),
      balcony: mergeFeature(d.balcony, listing.balcony),
      furnished: mergeFeature(d.furnished, listing.furnished),
      bathrooms: listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail,
      bedrooms: listing.bedrooms != null ? listing.bedrooms : d.bedroomsFromDetail
    };
  });
}

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/proprietes/"]'));
  for (const link of links) {
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);
    let container = link;
    let text = '';
    for (let i = 0; i < 6; i++) {
      container = container.parentElement;
      if (!container) break;
      text = container.innerText || '';
      if (text.includes('€') || text.includes('£')) break;
    }
    // BUG FIX (2026-08-31): a live run confirmed every listing on
    // breteuilhomes.com/louer is currently stamped "LOUÉ" (already
    // rented) — this filter was entirely missing before, so all
    // reported listings were likely stale. Same check as Luxe Prestige
    // Immo / Palais Royal Immobilier.
    // BUG FIX (2026-08-31): the previous check used
    // lower.includes('loue') — a plain substring match. "loue" is also
    // the first 4 letters of "louer" ("to rent"/"for rent"), which
    // appears constantly in ordinary listing text ("Appartement à
    // louer..."). That was silently filtering out AVAILABLE listings,
    // not just already-rented ones — confirmed live: this source went
    // from 6 listings down to 1 after the filter was added. Fixed with
    // a whole-word regex: matches "loué"/"LOUÉ" (the status stamp,
    // accented) or an accent-stripped "loue" as a standalone word, but
    // NOT as the start of "louer"/"location"/etc.
    if (/\b(lou\u00e9|loue)(?![a-zA-Z\u00e0-\u00ff])/i.test(text) || /\bvendu(?![a-zA-Z\u00e0-\u00ff])/i.test(text)) continue;
    // Only keep € listings (Paris / Ouest Parisien) — £ listings are
    // London and get excluded here, no separate location filter needed.
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 600) });
  }
  return results;
}

async function scrapeBreteuilHomes(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;

      console.log(`[Breteuil Homes] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Breteuil Homes] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Breteuil Homes] Page ${pageNum}: ${raw.length} raw items (€ only)`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Breteuil Homes';
        listing.searchType = searchType;
        listing.isExactListing = true;
        const details = extractDetailFeatures(item.rawText);
        if (listing.elevator == null) listing.elevator = details.elevator;
        if (listing.balcony == null) listing.balcony = details.balcony;
        if (listing.furnished == null) listing.furnished = details.furnished;
        if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
        if (listing.bedrooms == null) listing.bedrooms = details.bedroomsFromDetail;
        allListings.push(listing);
        newCount++;
      }
      await page.close();

      if (newCount === 0) {
        console.log(`[Breteuil Homes] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Breteuil Homes] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Breteuil Homes] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Breteuil Homes', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Breteuil Homes] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Breteuil Homes', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeBreteuilHomes };
