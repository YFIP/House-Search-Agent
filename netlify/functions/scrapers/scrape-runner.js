// Shared scraping engine — runs the SAME connection/navigation/retry logic
// for every source in source-config.js. This file should rarely need to
// change; per-site differences belong in source-config.js, not here.
//
// This logic was proven working against a real live site (Vielmon) in a
// standalone test before being adapted into this shared runner. The
// settle-delay and retry-on-navigation behavior below directly reflects
// what that real test run required.

const puppeteer = require('puppeteer-core');
const { SCRAPER_CONFIG } = require('./source-config');

const CDP_URL = process.env.CATALYST_CDP_URL;

// Scrape ONE source by name. Returns { source, listings, error }.
// Never throws — a failure on one source must not take down a search
// that includes other sources, scraped or AI-searched.
async function scrapeSource(sourceName) {
  const config = SCRAPER_CONFIG[sourceName];
  if (!config) {
    return { source: sourceName, listings: [], error: 'No scraper configured for this source.' };
  }
  if (!CDP_URL) {
    return { source: sourceName, listings: [], error: 'CATALYST_CDP_URL is not set in the environment.' };
  }

  let browser;
  try {
    // DIAGNOSTIC: confirm the URL's basic shape without logging the actual
    // secret value. A correct CDP URL should start with "wss://" and
    // contain no literal quote characters, leading/trailing whitespace,
    // or line breaks — all common results of a copy/paste mistake when
    // setting the Netlify environment variable.
    const urlDiagnostic = {
      length: CDP_URL.length,
      startsWithWss: CDP_URL.startsWith('wss://'),
      hasLeadingOrTrailingWhitespace: CDP_URL !== CDP_URL.trim(),
      containsQuoteChar: CDP_URL.includes('"') || CDP_URL.includes("'"),
      containsNewline: CDP_URL.includes('\n') || CDP_URL.includes('\r'),
      containsApiKeyParam: CDP_URL.includes('api-key='),
    };
    console.log('CDP_URL diagnostic:', JSON.stringify(urlDiagnostic));

    browser = await puppeteer.connect({ browserWSEndpoint: CDP_URL.trim() });
  } catch (err) {
    return { source: sourceName, listings: [], error: `Could not connect to headless browser: ${err.message}` };
  }

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);

    try {
      await page.goto(config.url, { waitUntil: 'networkidle2' });
    } catch (err) {
      return { source: sourceName, listings: [], error: `Page failed to load: ${err.message}` };
    }

    // Real sites (confirmed with Vielmon) can redirect/reload shortly
    // after the initial load completes. Give it a moment to settle
    // before reading anything from the DOM.
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (config.waitForSelector) {
      try {
        await page.waitForSelector(config.waitForSelector, { timeout: 15000 });
      } catch {
        // Not fatal — proceed and let extraction return an empty/partial
        // result rather than failing the whole source outright.
      }
    }

    const runExtract = () => page.evaluate(config.extract);

    let listings;
    try {
      listings = await runExtract();
    } catch (err) {
      if (err.message.includes('Execution context was destroyed')) {
        // Page navigated again right as we tried to read it — wait a
        // little longer and retry exactly once, same as the proven
        // standalone test.
        await new Promise(resolve => setTimeout(resolve, 3000));
        listings = await runExtract();
      } else {
        throw err;
      }
    }

    return { source: sourceName, listings, error: null };
  } catch (err) {
    return { source: sourceName, listings: [], error: `Extraction failed: ${err.message}` };
  } finally {
    await browser.close();
  }
}

// Scrape multiple sources concurrently. Sources without a config entry
// are skipped (not errored loudly) — the caller is expected to route
// those to the existing web_search path instead.
async function scrapeSources(sourceNames) {
  const scrapable = sourceNames.filter(name => SCRAPER_CONFIG[name]);
  const results = await Promise.all(scrapable.map(scrapeSource));
  return results;
}

module.exports = { scrapeSource, scrapeSources, SCRAPER_CONFIG };
