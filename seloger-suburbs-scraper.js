// seloger-suburbs-scraper.js
//
// FIX (this pass): same fix as seloger-arrondissements-scraper.js — this
// file never called extractDetailFeatures() on the summary-card/
// search-result text at all, relying 100% on the detail-page fetch for
// elevator/balcony/furnished. Real evidence (live SeLoger search results)
// shows the search-result card text is frequently already packed with
// "meublé" directly ("appartement meublé", "LOCATION MEUBLEE", etc.),
// contradicting this file's earlier assumption that furnished only lives
// in the detail page's "Caractéristiques" checklist. Combined with this
// source's real, documented anti-bot blocking on detail-page fetches
// (DataDome), having no summary-card fallback meant every blocked fetch
// produced a hard "Not mentioned" even when the answer was already
// sitting in text already scraped. Added the same summary-pass +
// mergeFeature pattern proven on every other source.
//
// Covers 13 western Paris suburb towns — the same corridor Junot itself
// defines as its western coverage area (Neuilly-sur-Seine, Levallois-
// Perret, Boulogne-Billancourt, Rueil-Malmaison, Suresnes, Puteaux,
// Saint-Cloud, Garches, Vaucresson, Marnes-la-Coquette, Ville-d'Avray,
// Le Vésinet, Saint-Germain-en-Laye) — NOT the full ~51 towns used for
// Junot/Barnes, because SeLoger requires an individually verified geo-code
// per town (not a simple slug pattern like Junot/Barnes).

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

function getListingSelector(searchType) {
  return searchType === 'sale' ? 'a[href*="/annonces/achat/"]' : 'a[href*="/annonces/locations/"]';
}
const DETAIL_FETCH_CONCURRENCY = 2;
const TOWN_CONCURRENCY = 1;

const SUBURB_TOWNS = [
  { slug: 'neuilly-sur-seine', postal: '92200', geoCode: 'ad08fr36623', displayName: 'Neuilly-sur-Seine' },
  { slug: 'boulogne-billancourt', postal: '92100', geoCode: 'ad08fr36603', displayName: 'Boulogne-Billancourt' },
  { slug: 'suresnes', postal: '92150', geoCode: 'ad08fr36630', displayName: 'Suresnes' },
  { slug: 'levallois-perret', postal: '92300', geoCode: 'ad08fr36617', displayName: 'Levallois-Perret' },
  { slug: 'rueil-malmaison', postal: '92500', geoCode: 'ad08fr36626', displayName: 'Rueil-Malmaison' },
  { slug: 'puteaux', postal: '92800', geoCode: 'ad08fr36625', displayName: 'Puteaux' },
  { slug: 'saint-cloud', postal: '92210', geoCode: 'ad08fr36627', displayName: 'Saint-Cloud' },
  { slug: 'saint-germain-en-laye', postal: '78100', geoCode: 'ad08fr37122', displayName: 'Saint-Germain-en-Laye' },
  { slug: 'le-vesinet', postal: '78110', geoCode: 'ad08fr32613', displayName: 'Le Vésinet' },
  { slug: 'vaucresson', postal: '92420', geoCode: 'ad08fr36632', displayName: 'Vaucresson' },
  { slug: 'garches', postal: '92380', geoCode: 'ad08fr36613', displayName: 'Garches' },
  { slug: 'marnes-la-coquette', postal: '92430', geoCode: 'ad08fr36619', displayName: 'Marnes-la-Coquette' },
  { slug: 'ville-d-avray', postal: '92410', geoCode: 'ad08fr36633', displayName: "Ville-d'Avray" },
  { slug: 'courbevoie', postal: '92400', geoCode: 'ad08fr36611', displayName: 'Courbevoie' },
  { slug: 'versailles', postal: '78000', geoCode: 'ad08fr32611', displayName: 'Versailles' },
  { slug: 'issy-les-moulineaux', postal: '92130', geoCode: 'ad08fr36616', displayName: 'Issy-les-Moulineaux' },
  { slug: 'colombes', postal: '92700', geoCode: 'ad08fr36610', displayName: 'Colombes' },
  { slug: 'nanterre', postal: '92000', geoCode: 'ad08fr36622', displayName: 'Nanterre' },
  { slug: 'chatou', postal: '78400', geoCode: 'ad08fr32414', displayName: 'Chatou' },
  { slug: 'croissy-sur-seine', postal: '78290', geoCode: 'ad08fr32429', displayName: 'Croissy-sur-Seine' },
  { slug: 'la-celle-saint-cloud', postal: '78170', geoCode: 'ad08fr32408', displayName: 'La Celle-Saint-Cloud' }
];

async function getBrowser() {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  return withTimeout(
    puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1920, height: 1080 },
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
    }),
    30000,
    'Launching local Chrome via Puppeteer (SeLoger suburbs)'
  );
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

function extractListings(searchType) {
  const results = [];
  const seen = new Set();
  const linkSelector = searchType === 'sale' ? 'a[href*="/annonces/achat/"]' : 'a[href*="/annonces/locations/"]';
  const links = Array.from(document.querySelectorAll(linkSelector));

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

  const h1Text = document.querySelector('h1') ? document.querySelector('h1').innerText : '';
  const countMatch = h1Text.match(/^\s*(\d[\d\s]*?)\s*(?:annonces|appartements|maisons)/i);
  const statedCount = countMatch ? parseInt(countMatch[1].replace(/\s/g, ''), 10) : null;

  if (statedCount !== null && statedCount < results.length) {
    return { results: results.slice(0, statedCount), statedCount };
  }
  return { results, statedCount };
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
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(20000);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const bodyText = await page.evaluate(() => {
      const visible = document.body.innerText || '';
      const all = document.body.textContent || '';
      const spaced = all.replace(/([a-z])([A-Z])/g, '$1 $2');
      return visible + ' ' + spaced;
    });

    await page.close();

    const status = response ? response.status() : null;
    const isBlocked = status === 403 || status === 429 || bodyText.length < 2000;
    if (isBlocked && !isRetry) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      return fetchListingDetails(browser, url, true);
    }

    const result = extractDetailFeatures(bodyText);
    result._wasBlocked = isBlocked;
    return result;
  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    return { elevator: null, balcony: null, furnished: null, bathroomsFromDetail: null, bedroomsFromDetail: null, _wasBlocked: true };
  }
}

async function enrichWithDetails(listings, label) {
  if (listings.length === 0) return listings;
  const freshBrowser = await getBrowser();
  try {
    const details = await mapWithConcurrency(listings, DETAIL_FETCH_CONCURRENCY, (listing) =>
      fetchListingDetails(freshBrowser, listing.url)
    );
    const blocked = details.filter(d => d._wasBlocked).length;
    console.log(`[SeLoger-${label}] Detail enrichment: ${listings.length - blocked}/${listings.length} succeeded, ${blocked} blocked/failed`);
    return listings.map((listing, i) => {
      const d = details[i];
      const bathrooms = listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail;
      let bedroomsFromDetail = d.bedroomsFromDetail;
      if (bedroomsFromDetail != null && listing.rooms != null && bedroomsFromDetail > listing.rooms) {
        bedroomsFromDetail = null;
      }
      const bedrooms = listing.bedrooms != null ? listing.bedrooms : bedroomsFromDetail;
      // FIXED: same mergeFeature fix as seloger-arrondissements-scraper.js
      // — was unconditional `d.elevator`/`d.balcony`/`d.furnished`.
      return {
        ...listing,
        elevator: mergeFeature(d.elevator, listing.elevator),
        balcony: mergeFeature(d.balcony, listing.balcony),
        furnished: mergeFeature(d.furnished, listing.furnished),
        bathrooms,
        bedrooms
      };
    });
  } finally {
    await freshBrowser.close();
  }
}

async function scrapeTown(town, searchType, shardIndex = 0, shardCount = 1) {
  let browser;
  let page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(20000);

    const allParsed = [];
    const seenUrls = new Set();
    let statedCountSeen = null;

    for (let pageNum = 1; ; pageNum++) {
      const distributionType = searchType === 'sale' ? 'Buy' : 'Rent';
      const url = `https://www.seloger.com/classified-search?distributionTypes=${distributionType}&estateTypes=Apartment&locations=${town.geoCode.toUpperCase()}&page=${pageNum}`;

      const MAX_PAGE_ATTEMPTS = 3;
      let pageLoadSucceeded = false;
      let lastStatus = null;
      for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
        await new Promise(r => setTimeout(r, 2000));
        lastStatus = response ? response.status() : null;
        try {
          await page.waitForSelector(getListingSelector(searchType), { timeout: 10000 });
          pageLoadSucceeded = true;
          break;
        } catch (e) {
          if (attempt < MAX_PAGE_ATTEMPTS) {
            console.warn(`[SeLoger-${town.slug}] Page ${pageNum}: attempt ${attempt}/${MAX_PAGE_ATTEMPTS} failed (status ${lastStatus}) — retrying after cooldown...`);
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
          }
        }
      }

      if (!pageLoadSucceeded) {
        if (lastStatus === 403 || lastStatus === 429) {
          console.warn(`[SeLoger-${town.slug}] Page ${pageNum}: got HTTP ${lastStatus} (blocked) even after ${MAX_PAGE_ATTEMPTS} attempts — stopping here. This page's listings are likely missing from the count below.`);
        }
        break;
      }

      const { results: raw, statedCount } = await page.evaluate(extractListings, searchType);
      if (statedCount != null) statedCountSeen = statedCount;
      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'SeLoger';
        listing.searchType = searchType;
        listing.isExactListing = true;
        listing.address = town.displayName;
        // NEW — same fix as every other source and as
        // seloger-arrondissements-scraper.js: check the search-result
        // card text directly before relying solely on the (often
        // blocked) detail-page fetch.
        const details = extractDetailFeatures(item.rawText);
        listing.elevator = details.elevator;
        listing.balcony = details.balcony;
        listing.furnished = details.furnished;
        if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
        if (listing.bedrooms == null) listing.bedrooms = details.bedroomsFromDetail;
        allParsed.push(listing);
        newCount++;
      }

      console.log(`[SeLoger-${town.slug}] Page ${pageNum}: ${newCount} new listing(s), ${allParsed.length} total so far`);

      if (newCount === 0) break;
    }

    const valid = allParsed.filter(l => l.price > 0 || l.priceOnRequest || l.address);

    const roomShareCount = valid.filter(l => l.isRoomShare).length;
    const willAppearInFinalOutput = valid.length - roomShareCount;
    if (statedCountSeen != null) {
      const pct = ((willAppearInFinalOutput / statedCountSeen) * 100).toFixed(1);
      console.log(`[SeLoger-${town.slug}] SeLoger states ${statedCountSeen} total listings. We scraped ${allParsed.length} raw (${roomShareCount} are room-share/colocation, excluded downstream) -> ${willAppearInFinalOutput} will appear in final output (${pct}% of SeLoger's stated total).`);
    } else {
      console.log(`[SeLoger-${town.slug}] Could not read SeLoger's stated total (h1 didn't match). Scraped ${allParsed.length} raw, ${roomShareCount} room-share (excluded downstream), ${willAppearInFinalOutput} will appear in final output.`);
    }

    const shard = shardCount > 1 ? valid.filter((_, i) => i % shardCount === shardIndex) : valid;
    if (shardCount > 1) {
      console.log(`[SeLoger-${town.slug}] Shard ${shardIndex}/${shardCount}: enriching ${shard.length}/${valid.length} listings`);
    }

    await page.close();
    await browser.close();
    browser = null;
    page = null;

    const enriched = await enrichWithDetails(shard, town.slug);
    return { slug: town.slug, listings: enriched, error: null };

  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { slug: town.slug, listings: [], error: error.message };
  }
}

async function scrapeSeLogerSuburbs(searchType = 'rent') {
  try {
    console.log(`[SeLoger-Suburbs] Scraping ${SUBURB_TOWNS.length} suburb towns...`);

    let completed = 0;
    const start = Date.now();
    const DELAY_BETWEEN_TOWNS_MS = 15000;
    let isFirst = true;
    const results = await mapWithConcurrency(SUBURB_TOWNS, TOWN_CONCURRENCY, async (town) => {
      if (!isFirst) {
        console.log(`[SeLoger-Suburbs] Waiting ${DELAY_BETWEEN_TOWNS_MS / 1000}s before next town (testing rate-limit theory)...`);
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_TOWNS_MS));
      }
      isFirst = false;
      const result = await scrapeTown(town, searchType);
      completed++;
      console.log(`[SeLoger-Suburbs] Progress: ${completed}/${SUBURB_TOWNS.length} (${town.slug}: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''})`);
      return result;
    });

    const allListings = [];
    const failedSlugs = [];
    let zeroResultCount = 0;

    for (const r of results) {
      if (r.error) { failedSlugs.push(`${r.slug} (${r.error})`); continue; }
      if (r.listings.length === 0) { zeroResultCount++; continue; }
      allListings.push(...r.listings);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[SeLoger-Suburbs] Total listings: ${allListings.length} in ${elapsed}s`);
    console.log(`[SeLoger-Suburbs] Zero-result towns: ${zeroResultCount}/${SUBURB_TOWNS.length}`);
    if (failedSlugs.length > 0) console.log(`[SeLoger-Suburbs] Failed towns: ${failedSlugs.join(', ')}`);

    return {
      source: 'SeLoger',
      searchType,
      listings: allListings,
      error: null,
      diagnostics: { zeroResultCount, failedSlugs }
    };

  } catch (error) {
    console.error(`[SeLoger-Suburbs] Fatal error: ${error.message}`);
    return { source: 'SeLoger', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeSeLogerSuburbs, SUBURB_TOWNS, scrapeTown };
