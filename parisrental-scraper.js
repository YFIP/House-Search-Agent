// parisrental-scraper.js
//
// VERIFIED LIVE:
//   - Furnished: https://en.parisrental.com/furnished-apartments/ — "92
//     results match your search". Individual listings live under
//     /furnished-apartments/{slug}-{numeric-ref}.
//   - Unfurnished: https://en.parisrental.com/rent-unfurnished-apartments-paris/
//     — only "1 results match your search" (tiny category). IMPORTANT:
//     individual listings here live under a DIFFERENT prefix,
//     /empty-apartments/{slug}-{numeric-ref} — e.g.
//     /empty-apartments/3-bedrooms-unfurnished-rental-paris-luxembourg-62940.
//     Confirmed by directly checking the page rather than assuming the
//     same prefix as furnished — it would have silently returned 0.
//   - Pagination: simple URL-based (?page=2 etc.), same for both categories.
//   - SUBURBS ALREADY INCLUDED in both categories (Boulogne-Billancourt,
//     Neuilly-sur-Seine, Levallois-Perret, Puteaux, Issy-les-Moulineaux,
//     Versailles, Courbevoie all appear as filter options).
//   - Address format: "Paris 16e - Avenue Victor Hugo" — bare "e" ordinal,
//     already handled by the shared parser.
//   - Price format: "Monthly rent €7,900" — falls through correctly to
//     the generic price regex.
//   - Room/sqm formats identical between furnished and unfurnished
//     categories, confirmed via the real unfurnished listing snippet.
//   - Fixed a real 403 block found via live testing: Puppeteer's default
//     User-Agent contains "HeadlessChrome", which this site's basic
//     bot-blocking rule rejects outright — even from a home IP, ruling
//     out simple IP-based blocking. A realistic User-Agent override
//     fixes it (confirmed live).

const parseListing = require('./parse-listing');

const CATEGORIES = [
  {
    name: 'furnished',
    baseUrl: 'https://en.parisrental.com/furnished-apartments/',
    linkPrefix: '/furnished-apartments/'
  },
  {
    name: 'unfurnished',
    baseUrl: 'https://en.parisrental.com/rent-unfurnished-apartments-paris/',
    linkPrefix: '/empty-apartments/'
  }
];

const MAX_PAGES = 8; // safety margin above the ~6-7 pages actually observed for furnished

async function getBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

// linkPrefix passed as an argument (not captured from outer scope) — a
// real Puppeteer serialization lesson learned earlier this project:
// page.evaluate(fn) only sends fn's own source, not any outer-scope
// variables it references, unless passed explicitly as an argument.
function extractListings(linkPrefix) {
  const results = [];
  const seen = new Set();
  const escapedPrefix = linkPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escapedPrefix.replace(/\\\//g, '/') + '.+-\\d+/?$');
  const links = Array.from(document.querySelectorAll(`a[href*="${linkPrefix}"]`))
    .filter(l => pattern.test(l.href));

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

async function scrapeCategory(browser, category, searchType, seenUrls, allListings) {
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'); // fixes 403 blocks from bot-detection checking for the default 'HeadlessChrome' signature (confirmed root cause via live ParisRental testing)
    await page.setDefaultNavigationTimeout(20000);
    const url = pageNum === 1 ? category.baseUrl : `${category.baseUrl}?page=${pageNum}`;

    console.log(`[ParisRental] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

    try {
      await page.waitForSelector(`a[href*="${category.linkPrefix}"]`, { timeout: 10000 });
    } catch (e) {
      console.log(`[ParisRental] [${category.name}] No listings found on page ${pageNum} — assuming end of results.`);
      await page.close();
      break;
    }

    const raw = await page.evaluate(extractListings, category.linkPrefix);
    console.log(`[ParisRental] [${category.name}] Page ${pageNum}: ${raw.length} raw items`);

    let newCount = 0;
    for (const item of raw) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      const listing = parseListing(item.rawText);
      listing.url = item.url;
      listing.source = 'ParisRental';
      listing.searchType = searchType;
      listing.isExactListing = true;
      allListings.push(listing);
      newCount++;
    }
    await page.close();

    if (newCount === 0) {
      console.log(`[ParisRental] [${category.name}] Page ${pageNum} had no new listings — stopping this category.`);
      break;
    }
    if (allListings.length >= 100) {
      console.log(`[ParisRental] Reached 100-listing cap — stopping.`);
      return;
    }
  }
}

async function scrapeParisRental(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const allListings = [];
    const seenUrls = new Set();

    for (const category of CATEGORIES) {
      if (allListings.length >= 100) break;
      await scrapeCategory(browser, category, searchType, seenUrls, allListings);
    }

    await browser.close();
    console.log(`[ParisRental] Total unique listings: ${allListings.length}`);

    return { source: 'ParisRental', searchType, listings: allListings, error: null };

  } catch (error) {
    console.error(`[ParisRental] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'ParisRental', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeParisRental };
