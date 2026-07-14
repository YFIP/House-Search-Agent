// perenium-scraper.js
//
// VERIFIED LIVE:
//   - https://www.perenium.eu/location.php (page 1) — "14 annonces" total,
//     tiny inventory, well under our 100-per-source cap.
//   - https://www.perenium.eu/location.php?Page=2 (page 2) — simple
//     URL-based pagination, same easy pattern as Book-a-Flat.
//   - Listing link pattern: /fiche-{type}-a-louer-{location}-ref-{id}.php
//     — clean, distinctive, e.g.
//     /fiche-studio-a-louer-levallois-perret-ref-3010737.php
//   - SUBURBS ALREADY INCLUDED: the single search combines Paris
//     arrondissements AND suburb towns (Levallois-Perret, Suresnes,
//     Saint-Germain-en-Laye all seen live) — same as Book-a-Flat, no
//     separate suburb-specific scraping needed.
//   - Room format: "T2", "T3", "T4", "T5" notation directly in the title
//     — already matches parse-listing.js's existing \bT(\d+)\b regex.
//   - Price format: "825 € charges comprises par mois" — NO slash before
//     "mois" (unlike Barnes/SeLoger's "€ /mois"). Won't match the rent-
//     specific regex, but correctly falls through to the generic
//     saleAfter/saleBefore price regex, which doesn't require a slash —
//     confirmed working via testing before this was built.
//   - Address format inconsistent by design: "PARIS 10EME ARRONDISSEMENT"
//     for Paris listings (already matches existing regex), but suburb-only
//     listings ("LEVALLOIS-PERRET", "SURESNES") have no "Paris" prefix at
//     all. Since this ONE page mixes many different locations together
//     (unlike SeLoger/Barnes suburbs, where we scrape one known town at a
//     time), we can't override with a known location here — text parsing
//     is the only option, same situation as Barnes/SeLoger's main Paris
//     scrapers. The fallback (first non-badge non-price line) should still
//     surface a readable location from the listing's own title text.

const parseListing = require('./parse-listing');
const { extractDetailFeatures } = require('./parse-listing');

const BASE_URL = 'https://www.perenium.eu/location.php';
const LISTING_SELECTOR = 'a[href*="/fiche-"]';
const MAX_PAGES = 5; // safety cap well above the ~2 pages actually observed

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
  const links = Array.from(document.querySelectorAll('a[href*="/fiche-"]'));

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

async function scrapePerenium(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageNum === 1 ? BASE_URL : `${BASE_URL}?Page=${pageNum}`;

      console.log(`[Perenium] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Perenium] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Perenium] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Perenium';
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

      if (newCount === 0) {
        console.log(`[Perenium] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    await browser.close();
    console.log(`[Perenium] Total unique listings: ${allListings.length}`);

    return { source: 'Perenium', searchType, listings: allListings, error: null };

  } catch (error) {
    console.error(`[Perenium] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Perenium', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapePerenium };
