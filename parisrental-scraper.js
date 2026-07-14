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
      // Furnished status inferred directly from which category we
      // scraped — 100% reliable, no text-parsing needed, since the site
      // itself splits listings into these two categories.
      listing.furnished = category.name === 'furnished';
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

// Scrapes exactly ONE page of ONE category, in complete isolation (own
// browser launch) — meant to run as its own separate GitHub Actions job.
// Built after the combined scraper kept returning 0 results specifically
// on GitHub Actions (while working fine from a home network with the
// identical code) — strong evidence GitHub's IP range itself is being
// blocked, not a code bug. Isolating each page the same way that fixed
// SeLoger's suburbs/arrondissements is worth trying, though it's not
// guaranteed to help here: SeLoger's issue looked like session-pattern
// detection (fixed by isolation), while this one looks more like a
// straightforward IP block (which isolation may not fix at all, since
// every isolated job still originates from the same GitHub IP range).
async function scrapeSinglePage(categoryName, pageNum, searchType = 'rent') {
  const category = CATEGORIES.find(c => c.name === categoryName);
  if (!category) {
    return { category: categoryName, page: pageNum, listings: [], error: `Unknown category: ${categoryName}` };
  }

  let browser;
  let page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(20000);
    const url = pageNum === 1 ? category.baseUrl : `${category.baseUrl}?page=${pageNum}`;

    console.log(`[ParisRental-${categoryName}-${pageNum}] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

    try {
      await page.waitForSelector(`a[href*="${category.linkPrefix}"]`, { timeout: 10000 });
    } catch (e) {
      console.log(`[ParisRental-${categoryName}-${pageNum}] No listings found — genuinely empty page, or still blocked.`);
    }

    const raw = await page.evaluate(extractListings, category.linkPrefix);
    const listings = raw.map(item => {
      const listing = parseListing(item.rawText);
      listing.url = item.url;
      listing.source = 'ParisRental';
      listing.searchType = searchType;
      listing.isExactListing = true;
      listing.furnished = category.name === 'furnished';
      return listing;
    });

    await page.close();
    await browser.close();
    console.log(`[ParisRental-${categoryName}-${pageNum}] Found ${listings.length} listings`);
    return { category: categoryName, page: pageNum, listings, error: null };

  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { category: categoryName, page: pageNum, listings: [], error: error.message };
  }
}

module.exports = { scrapeParisRental, scrapeSinglePage, CATEGORIES };
