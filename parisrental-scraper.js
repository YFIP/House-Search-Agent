// parisrental-scraper.js
//
// FIX (this pass): `listing.furnished = category.name === 'furnished'`
// ran unconditionally, including for the 'sale' category — meaning every
// ParisRental SALE listing got `furnished: false` (a confident "No"),
// when the honest answer is "not applicable / not stated" (furnishing
// status isn't a real category distinction for a sale listing the way it
// is for a rental). Changed to a 3-way ternary so sale listings get
// `null` ("Not mentioned") instead of a false "No".
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

const RENT_CATEGORIES = [
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

const SALE_CATEGORIES = [
  {
    name: 'sale',
    baseUrl: 'https://en.parisrental.com/apartments-for-sale/',
    linkPrefix: '/apartments-for-sale/'
  }
];

const CATEGORIES = RENT_CATEGORIES;

const MAX_PAGES = 8;

// Shared helper: furnished status is inferred directly from which
// category we scraped — 100% reliable, no text-parsing needed, for the
// two RENT categories. The 'sale' category isn't a furnishing
// distinction at all, so it must resolve to null ("not stated"), not a
// false "unfurnished".
function furnishedFromCategory(categoryName) {
  if (categoryName === 'furnished') return true;
  if (categoryName === 'unfurnished') return false;
  return null; // 'sale' — furnishing status isn't a real category here
}

async function getBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

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
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
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
      // FIXED: was `category.name === 'furnished'` unconditionally,
      // which meant sale listings got `false` (a confident "No") instead
      // of `null` ("not stated") — see file header note.
      listing.furnished = furnishedFromCategory(category.name);
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

    const categories = searchType === 'sale' ? SALE_CATEGORIES : RENT_CATEGORIES;
    for (const category of categories) {
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

async function scrapeSinglePage(categoryName, pageNum, searchType = 'rent') {
  const category = [...RENT_CATEGORIES, ...SALE_CATEGORIES].find(c => c.name === categoryName);
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
      // FIXED: same sale-category fix as scrapeCategory above.
      listing.furnished = furnishedFromCategory(category.name);
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

module.exports = { scrapeParisRental, scrapeSinglePage, CATEGORIES, RENT_CATEGORIES, SALE_CATEGORIES };
