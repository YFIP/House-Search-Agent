// seloger-arrondissements-scraper.js
//
// FIX (this pass): this file never called extractDetailFeatures() on the
// summary-card/search-result text at all — elevator/balcony/furnished
// only ever came from the detail-page fetch. Real evidence (live
// SeLoger search results fetched directly) shows this was a mistaken
// assumption: SeLoger's own search-result card text is frequently
// PACKED with "meublé" ("appartement meublé", "APPARTEMENT MEUBLE 4
// PIECES", "LOCATION MEUBLEE", etc.) — the file's original comment
// claiming furnished only lives in the detail page's "Caractéristiques"
// checklist was wrong, or at best incomplete. Given this source ALSO
// fights real anti-bot blocking on its detail-page fetches (see
// DETAIL_FETCH_CONCURRENCY's own comments on DataDome), relying solely
// on that fetch with no summary-card fallback means every blocked fetch
// produces a hard "Not mentioned" even when the answer was sitting right
// there in text already scraped. Added the same summary-pass +
// mergeFeature pattern already proven on every other source: the
// detail-page value still wins when the fetch succeeds (more complete),
// but a failed fetch now falls back to what the summary card already
// found instead of erasing it.
//
// Covers all 20 Paris arrondissements as separate isolated locations —
// same architecture as seloger-suburbs-scraper.js (each gets its own
// browser/session, meant to run as its own GitHub Actions matrix job).
//
// Goal: the all-Paris search (seloger-scraper.js) only returns ~30
// listings (one page load, and Paris' pagination is unsolved — see that
// file's own notes on 3 failed pagination strategies). Treating each
// arrondissement as its own "location" search sidesteps needing
// pagination at all, the same trick that fixed the suburb coverage.
//
// GEO-CODES: SeLoger's arrondissement geo-codes follow a confirmed
// pattern — ad09fr(25 + arrondissement number). Verified live for 3
// arrondissements (7th=ad09fr32, 15th=ad09fr40, 16th=ad09fr41, all
// matching the formula exactly). The other 17 are constructed from this
// formula, NOT individually verified — if the pattern breaks for a
// specific arrondissement, that job will show 0 results (see
// scrapeArrondissement's zero-result handling) rather than erroring, so
// a wrong code fails visibly, not silently as wrong data.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const PARIS_ARRONDISSEMENTS = Array.from({ length: 20 }, (_, i) => {
  const n = i + 1;
  const postal = `750${n.toString().padStart(2, '0')}`;
  const geoCode = `ad09fr${25 + n}`;
  const ordinal = n === 1 ? '1er' : `${n}eme`;
  const displayName = n === 1 ? 'Paris 1er' : `Paris ${n}ème`;
  return { arrondissement: n, slug: `paris-${ordinal}-arrondissement-${postal}`, postal, geoCode, displayName };
});

function getListingSelector(searchType) {
  return searchType === 'sale' ? 'a[href*="/annonces/achat/"]' : 'a[href*="/annonces/locations/"]';
}
const DETAIL_FETCH_CONCURRENCY = 2;

async function getBrowser() {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
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
      // FIXED: was `elevator: d.elevator, balcony: d.balcony, furnished:
      // d.furnished` unconditionally — overwrote whatever the NEW
      // summary-card pass (in scrapeArrondissement, below) had already
      // found with a failed fetch's null. mergeFeature keeps the
      // detail-page value when the fetch actually succeeded (still
      // preferred — more complete), falls back to the summary-card
      // value otherwise.
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

async function scrapeArrondissement(arr, searchType, shardIndex = 0, shardCount = 1) {
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
    let lastPageWasSuspiciouslyShort = false;

    for (let pageNum = 1; ; pageNum++) {
      const distributionType = searchType === 'sale' ? 'Buy' : 'Rent';
      const url = `https://www.seloger.com/classified-search?distributionTypes=${distributionType}&estateTypes=Apartment&locations=${arr.geoCode.toUpperCase()}&page=${pageNum}`;

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
            console.warn(`[SeLoger-${arr.slug}] Page ${pageNum}: attempt ${attempt}/${MAX_PAGE_ATTEMPTS} failed (status ${lastStatus}) — retrying after cooldown...`);
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
          }
        }
      }

      if (!pageLoadSucceeded) {
        if (lastStatus === 403 || lastStatus === 429) {
          console.warn(`[SeLoger-${arr.slug}] Page ${pageNum}: got HTTP ${lastStatus} (blocked) even after ${MAX_PAGE_ATTEMPTS} attempts — stopping here. This page's listings are likely missing from the count below.`);
        } else {
          console.warn(`[SeLoger-${arr.slug}] Page ${pageNum}: failed to load after ${MAX_PAGE_ATTEMPTS} attempts (status ${lastStatus}) — treating as end of results.`);
        }
        break;
      }

      const { results: raw, statedCount } = await page.evaluate(extractListings, searchType);
      if (statedCount != null) statedCountSeen = statedCount;
      lastPageWasSuspiciouslyShort = raw.length > 0 && raw.length < 10;

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'SeLoger';
        listing.searchType = searchType;
        listing.isExactListing = true;
        listing.address = arr.displayName;
        // NEW — same fix as every other source: check the search-result
        // card text directly, since real evidence shows it frequently
        // already states furnished status ("appartement meublé", etc.)
        // No extra network cost — this is text already fetched above.
        const details = extractDetailFeatures(item.rawText);
        listing.elevator = details.elevator;
        listing.balcony = details.balcony;
        listing.furnished = details.furnished;
        if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
        if (listing.bedrooms == null) listing.bedrooms = details.bedroomsFromDetail;
        allParsed.push(listing);
        newCount++;
      }

      console.log(`[SeLoger-${arr.slug}] Page ${pageNum}: ${newCount} new listing(s), ${allParsed.length} total so far`);

      if (newCount === 0) break;
    }

    const valid = allParsed.filter(l => l.price > 0 || l.priceOnRequest || l.address);

    const roomShareCount = valid.filter(l => l.isRoomShare).length;
    const willAppearInFinalOutput = valid.length - roomShareCount;
    if (statedCountSeen != null) {
      const pct = ((willAppearInFinalOutput / statedCountSeen) * 100).toFixed(1);
      console.log(`[SeLoger-${arr.slug}] SeLoger states ${statedCountSeen} total listings. We scraped ${allParsed.length} raw (${roomShareCount} are room-share/colocation, excluded downstream) -> ${willAppearInFinalOutput} will appear in final output (${pct}% of SeLoger's stated total).${lastPageWasSuspiciouslyShort ? ' Last page returned unusually few links — possible partial/blocked load.' : ''}`);
    } else {
      console.log(`[SeLoger-${arr.slug}] Could not read SeLoger's stated total (title/h1 didn't match). Scraped ${allParsed.length} raw, ${roomShareCount} room-share (excluded downstream), ${willAppearInFinalOutput} will appear in final output.`);
    }

    const shard = shardCount > 1 ? valid.filter((_, i) => i % shardCount === shardIndex) : valid;
    if (shardCount > 1) {
      console.log(`[SeLoger-${arr.slug}] Shard ${shardIndex}/${shardCount}: enriching ${shard.length}/${valid.length} listings`);
    }

    await page.close();
    await browser.close();
    browser = null;
    page = null;

    const enriched = await enrichWithDetails(shard, arr.slug);
    return { arrondissement: arr.arrondissement, listings: enriched, error: null };

  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { arrondissement: arr.arrondissement, listings: [], error: error.message };
  }
}

module.exports = { scrapeArrondissement, PARIS_ARRONDISSEMENTS };
