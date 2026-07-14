// bookaflat-scraper.js
//
// VERIFIED LIVE:
//   - https://www.book-a-flat.com/en/search.html (page 1, ~30 listings)
//   - https://www.book-a-flat.com/en/search-2.html (page 2, ~7 listings,
//     one confirmed duplicate of a page-1 listing within page 2 itself —
//     good real test case for URL-based dedup)
//   - Only 2 total pages seen — pagination footer showed "1 | 2" with no
//     page 3, so this covers the site's entire current rental inventory
//     (~36 unique listings), well under our 100-per-source cap.
//   - Listing link pattern: a[href*="/apartment-paris-"] — clean, distinct.
//   - SUBURBS ALREADY INCLUDED: the default search combines Paris
//     arrondissements AND suburb departments (92, 93, 94) in one result
//     set — confirmed by a real listing showing "rue Gutenberg 92" (a
//     Hauts-de-Seine department code, not an arrondissement). Unlike
//     Barnes/SeLoger, no separate suburb-specific scraping needed at all.
//   - Price format: "50000 €/MONTH" (digits-then-€-then-/MONTH, English,
//     uppercase) — already matches the existing parse-listing.js regex
//     (case-insensitive, "month" already an accepted rent-suffix).
//   - Address format: "rue Newton Paris 16th" (English ordinals: 16th,
//     6th, 8th) — already matches the existing Paris-arrondissement
//     regex. The rare suburb-only case ("rue Gutenberg 92", no
//     arrondissement) isn't perfectly parsed by that regex — a known,
//     low-volume edge case (1 out of ~36 seen), not fixed here since it's
//     minor compared to the widespread issues found on other sources.
//   - Whole-card-is-a-link pattern observed: the entire listing's text
//     (address, price, ref, availability) appears to live inside ONE <a>
//     tag, not spread across a separate wrapping container. Extraction
//     tries the link's own text first, falling back to walking up parents
//     only if that doesn't contain a price (defensive, in case the real
//     DOM differs from what a markdown-converted fetch implied).

const parseListing = require('./parse-listing');
const { extractDetailFeatures } = require('./parse-listing');

const BASE_URL = 'https://www.book-a-flat.com/en/search';
const LISTING_SELECTOR = 'a[href*="/apartment-paris-"]';
const MAX_PAGES = 5; // safety cap well above the 2 pages actually observed

async function getBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/apartment-paris-"]'));

  for (const link of links) {
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);

    // Try the link's own text first (whole-card-is-a-link pattern
    // observed) — only walk up to a parent container if that doesn't
    // contain a price, as a defensive fallback.
    let text = link.innerText || '';
    if (!text.includes('€')) {
      let container = link;
      for (let i = 0; i < 6; i++) {
        container = container.parentElement;
        if (!container) break;
        text = container.innerText || '';
        if (text.includes('€')) break;
      }
    }

    if (text.includes('€')) {
      results.push({ url: href.split('?')[0], rawText: text.slice(0, 500) });
    }
  }

  return results;
}

async function scrapeBookAFlat(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const allListings = [];
    const seenUrls = new Set();
    let page;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageNum === 1 ? `${BASE_URL}.html` : `${BASE_URL}-${pageNum}.html`;

      console.log(`[Book-a-Flat] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Book-a-Flat] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Book-a-Flat] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Book-a-Flat';
        listing.searchType = searchType;
        listing.isExactListing = true;
      // Applying the same detail-feature extraction directly on the raw
      // summary text (same pattern proven for Junot/Eiffel Housing) -
      // returns null honestly for fields not present in the text, picks
      // up real data for fields that are.
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

      // Stop once a page contributes nothing new — either genuinely out
      // of pages, or (defensively) a page is somehow repeating content.
      if (newCount === 0) {
        console.log(`[Book-a-Flat] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    await browser.close();
    console.log(`[Book-a-Flat] Total unique listings: ${allListings.length}`);

    return { source: 'Book-a-Flat', searchType, listings: allListings, error: null };

  } catch (error) {
    console.error(`[Book-a-Flat] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Book-a-Flat', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeBookAFlat };
