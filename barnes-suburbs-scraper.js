// barnes-suburbs-scraper.js
//
// FIX (this pass): this file never called extractDetailFeatures() at
// all — elevator/balcony/furnished were simply absent from every listing
// it produced (not null, literally missing keys), meaning every Barnes
// suburb listing showed as "Not mentioned" for Furnished regardless of
// what the real listing said. Added a summary-card pass, same pattern
// already proven for Junot/DanielFeau/Book-a-Flat/Perenium. This does
// NOT add a detail-page visit (no new network cost/timeout risk) — it
// only reads text this scraper already fetches. Some listings that only
// state furnishing status on their own detail page (not the summary
// card) will still show "Not mentioned" after this fix; a future pass
// could add real detail-page enrichment here too, following the pattern
// in scrape-runner.js, if that's worth the added cost for this source.
//
// FIXED — real bug found via live evidence during testing: the original
// URL format (https://www.barnes-international.com/en/for-rent/france/
// {slug}.html) does NOT match Barnes' real URL pattern for most suburb
// towns. A live test run showed ALL 51 towns returning non-empty results
// (800 total) — implausible for a luxury agency across tiny villages —
// and a direct check confirmed the real URL for Marnes-la-Coquette is
// https://www.barnes-international.com/en/for-rent/france/marnes-la-coquette-92430/
// (WITH postal code, trailing slash, NO ".html"). The old wrong URL likely
// fell back to generic/all-France content for most towns, which is why
// none of them came back empty — they were probably all showing similar
// generic content, not real per-town data.
//
// Scoped to the same 13 verified western towns already confirmed for
// SeLoger's suburbs (not the full ~51), since fixing all 51 would require
// the same per-town URL verification SeLoger's geo-codes needed — this
// trades breadth for correctness, consistent with how SeLoger's suburb
// coverage was already handled.

const parseListing = require('./parse-listing');
const { extractDetailFeatures } = require('./parse-listing');

const SUBURB_TOWNS = [
  { slug: 'neuilly-sur-seine', postal: '92200', displayName: 'Neuilly-sur-Seine' },
  { slug: 'boulogne-billancourt', postal: '92100', displayName: 'Boulogne-Billancourt' },
  { slug: 'suresnes', postal: '92150', displayName: 'Suresnes' },
  { slug: 'levallois-perret', postal: '92300', displayName: 'Levallois-Perret' },
  { slug: 'rueil-malmaison', postal: '92500', displayName: 'Rueil-Malmaison' },
  { slug: 'puteaux', postal: '92800', displayName: 'Puteaux' },
  { slug: 'saint-cloud', postal: '92210', displayName: 'Saint-Cloud' },
  { slug: 'saint-germain-en-laye', postal: '78100', displayName: 'Saint-Germain-en-Laye' },
  { slug: 'le-vesinet', postal: '78110', displayName: 'Le Vésinet' },
  { slug: 'vaucresson', postal: '92420', displayName: 'Vaucresson' },
  { slug: 'garches', postal: '92380', displayName: 'Garches' },
  { slug: 'marnes-la-coquette', postal: '92430', displayName: 'Marnes-la-Coquette' },
  { slug: 'ville-d-avray', postal: '92410', displayName: "Ville-d'Avray" }
];

const LISTING_SELECTOR = 'a[href*="/ref-"]';
const NEXT_BUTTON_SELECTOR = 'a[href^="javascript:annonces_suivantes"]';
const MAX_LISTINGS_PER_TOWN_BY_TYPE = { rent: 100, sale: 250 };
const MAX_PAGE_CLICKS_BY_TYPE = { rent: 10, sale: 20 };
const TOWN_CONCURRENCY = 2;

function extractListings(townSlug) {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/ref-"]'))
    .filter(l => l.href.includes('/france/' + townSlug));

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
      if (text.includes('€')) break;
    }

    if (text.includes('€')) {
      results.push({ url: href, rawText: text.slice(0, 400) });
    }
  }

  return results;
}

async function countUniqueListings(page) {
  return page.evaluate((sel) => {
    const anchors = Array.from(document.querySelectorAll(sel));
    return new Set(anchors.map(a => a.href)).size;
  }, LISTING_SELECTOR);
}

async function collectWithPagination(page, townSlug, maxListings, maxPageClicks) {
  let previousCount = 0;
  let clicks = 0;

  while (clicks < maxPageClicks) {
    const currentCount = await countUniqueListings(page);
    if (currentCount >= maxListings) break;
    if (clicks > 0 && currentCount === previousCount) break;

    const nextButton = await page.$(NEXT_BUTTON_SELECTOR);
    if (!nextButton) break;

    previousCount = currentCount;

    const calledDirectly = await page.evaluate(() => {
      if (typeof window.annonces_suivantes === 'function') {
        try { window.annonces_suivantes(); return true; } catch (e) { return false; }
      }
      return false;
    });
    if (!calledDirectly) {
      await nextButton.click().catch(() => {});
    }

    try {
      await page.waitForFunction(
        (sel, prev) => new Set(Array.from(document.querySelectorAll(sel)).map(a => a.href)).size > prev,
        { timeout: 8000 },
        LISTING_SELECTOR,
        previousCount
      );
    } catch (e) {
      break;
    }

    clicks++;
  }

  return page.evaluate(extractListings, townSlug);
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

async function scrapeTown(browser, town, searchType) {
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(20000);
    const urlBase = searchType === 'sale'
      ? 'https://www.barnes-international.com/en/for-sale/france/'
      : 'https://www.barnes-international.com/en/for-rent/france/';
    const url = `${urlBase}${town.slug}-${town.postal}/`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    try {
      await page.waitForSelector(LISTING_SELECTOR, { timeout: 8000 });
    } catch (e) {
      // Genuinely zero listings for this town today — expected occasionally.
    }

    const maxListings = MAX_LISTINGS_PER_TOWN_BY_TYPE[searchType] || 100;
    const maxPageClicks = MAX_PAGE_CLICKS_BY_TYPE[searchType] || 10;

    const raw = await collectWithPagination(page, town.slug, maxListings, maxPageClicks);
    await page.close();
    return { slug: town.slug, listings: raw.slice(0, maxListings), error: null };

  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    return { slug: town.slug, listings: [], error: error.message };
  }
}

async function scrapeBarnesSuburbs(searchType = 'rent') {
  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1920, height: 1080 },
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
    });

    console.log(`[Barnes-Suburbs] Scraping ${SUBURB_TOWNS.length} suburb towns...`);
    let completed = 0;
    const start = Date.now();

    const results = await mapWithConcurrency(SUBURB_TOWNS, TOWN_CONCURRENCY, async (town) => {
      const result = await scrapeTown(browser, town, searchType);
      completed++;
      console.log(`[Barnes-Suburbs] Progress: ${completed}/${SUBURB_TOWNS.length} (${town.slug}: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''})`);
      return result;
    });

    await browser.close();

    const allListings = [];
    const failedSlugs = [];
    let zeroResultCount = 0;

    for (const r of results) {
      if (r.error) { failedSlugs.push(`${r.slug} (${r.error})`); continue; }
      if (r.listings.length === 0) { zeroResultCount++; continue; }
      const town = SUBURB_TOWNS.find(t => t.slug === r.slug);
      for (const item of r.listings) {
        const listing = parseListing(item.rawText);
        // NEW — was missing entirely before this fix. Runs directly on
        // the summary-card text already fetched above (no extra network
        // cost) — same pattern already proven for Junot/DanielFeau.
        const details = extractDetailFeatures(item.rawText);
        listing.url = item.url;
        listing.source = 'Barnes';
        listing.searchType = searchType;
        listing.isExactListing = true;
        listing.elevator = details.elevator;
        listing.balcony = details.balcony;
        listing.furnished = details.furnished;
        if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
        if (listing.bedrooms == null) listing.bedrooms = details.bedroomsFromDetail;
        if (town) listing.address = town.displayName;
        allListings.push(listing);
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[Barnes-Suburbs] Total listings: ${allListings.length} in ${elapsed}s`);
    console.log(`[Barnes-Suburbs] Zero-result towns: ${zeroResultCount}/${SUBURB_TOWNS.length}`);
    if (failedSlugs.length > 0) console.log(`[Barnes-Suburbs] Failed towns: ${failedSlugs.join(', ')}`);

    return { source: 'Barnes', searchType, listings: allListings, error: null, diagnostics: { zeroResultCount, failedSlugs } };

  } catch (error) {
    console.error(`[Barnes-Suburbs] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Barnes', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeBarnesSuburbs, SUBURB_TOWNS };
