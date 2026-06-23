// Per-source scraper configuration.
//
// Each entry describes ONE agency website: its listing-search URL, and a
// function that knows how to extract listings from that specific site's
// HTML structure. This is the only place that needs to change when:
//   - adding a new source to scrape
//   - fixing a source whose site layout changed
//
// The actual browser automation (connecting to Catalyst, navigating,
// waiting, retrying) lives in scrape-runner.js and is shared by every
// source — it never needs to change just because a site's HTML changed.
//
// HOW TO ADD A NEW SOURCE:
//   1. Add a new key to SCRAPER_CONFIG below, named exactly like the
//      source name used elsewhere in Prospector (index.html's
//      ALL_SOURCES list), so the two stay in sync.
//   2. Set `url` to that source's real listing-search page.
//   3. Write an `extract` function — it runs INSIDE the browser page via
//      page.evaluate(), so it can only use plain DOM APIs (no Node.js
//      code, no imports). Copy the Vielmon entry below as a starting
//      template; most of the Orisha/Poliris-platform sources we
//      confirmed this session (Cabinet Montoro, AFR Immobilier,
//      Patrimoine Ouest Parisien) share nearly identical HTML structure,
//      since they're built on the same agency-website platform.
//   4. Test it standalone first with test-vielmon.js-style script before
//      wiring it into the live function — a broken extractor for one
//      source should never break search results for the other sources.

const SCRAPER_CONFIG = {
  Vielmon: {
    url: 'https://www.vielmon.fr/annonces/transaction/Location.html',
    // Listing links match this pattern; selector confirmed working
    // against the live site as of this session.
    waitForSelector: 'a[href*="/fiches/"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/fiches/"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);

        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 30; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';

        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  // Cabinet Montoro, AFR Immobilier, and Patrimoine Ouest Parisien — all
  // confirmed this session via direct fetch to run on the same
  // Orisha/Poliris platform as Vielmon: identical "/fiches/.../*.html"
  // listing link pattern, identical "Loyer X €/mois ... X pièce(s) ...
  // Réf : X" text structure. The Vielmon extract function works
  // unchanged for all three — verified by reading live page content,
  // not assumed from the platform match alone.
  'Cabinet Montoro': {
    url: 'https://www.cabinet-montoro.fr/annonces/transaction/Location.html',
    waitForSelector: 'a[href*="/fiches/"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/fiches/"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 30; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  'AFR Immobilier': {
    url: 'https://www.afr-immobilier.com/annonces/transaction/Location.html',
    waitForSelector: 'a[href*="/fiches/"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/fiches/"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 30; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  'Patrimoine Ouest Parisien': {
    url: 'https://www.patrimoineouestparisien.fr/annonces/transaction/Location.html',
    waitForSelector: 'a[href*="/fiches/"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/fiches/"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 30; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  // Paris Seine Immobilier — confirmed this session: also Orisha/Poliris
  // (same /fiches/.../*.html pattern), BUT its listing text is verbose,
  // multi-paragraph marketing copy with price/rooms/surface appearing as
  // trailing lines, not Vielmon's compact inline format. parseListingText
  // (regex-based, searches the whole block) was tested against this real
  // format and correctly extracts price/rooms/sqm/meuble — only the
  // address field is unreliable here, which is an acceptable tradeoff.
  // Raising the text cutoff from 300 to 500 chars since these listings
  // run longer before the price/specs lines appear.
  'Paris Seine Immobilier': {
    url: 'https://www.paris-seine-immobilier.com/annonces/transaction/Location.html',
    waitForSelector: 'a[href*="/fiches/"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/fiches/"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 4 && container && container.innerText.length < 60; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 500) });
      }
      return results;
    },
  },

  // Fredelion — confirmed this session: built on the Billie.immo platform,
  // NOT Orisha. Different link pattern: /fr/immobilier/location/{type}/
  // {city}/{slug}/{id}. Text is cleanly separated: title, then
  // "Appartement X pièce(s)", then "X €/mois CC honoraires inclus", then
  // "Xm²", then "X chambre(s)". Confirmed via live fetch — 30 real
  // listings visible directly in server-rendered HTML, no JS needed.
  Fredelion: {
    url: 'https://www.fredelion.com/fr/immobilier/location',
    waitForSelector: 'a[href*="/fr/immobilier/location/"]',
    extract: () => {
      const results = [];
      // Fredelion's listing links include a trailing numeric ID segment
      // (e.g. /appartement/paris/paris-16-rue-claude-lorrain/87044) —
      // filter out the bare category links (which lack that trailing ID)
      // to avoid treating navigation links as listings.
      const links = Array.from(document.querySelectorAll('a[href*="/fr/immobilier/location/"]'))
        .filter(a => /\/\d+$/.test(a.href));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 30; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  // Perenium — confirmed this session: built on Pilotim platform. Link
  // pattern: /fiche-{type}-a-louer-{city}-ref-{id}.php (note: "fiche"
  // singular, NOT Orisha's "/fiches/" plural — different platform,
  // coincidentally similar word). Text is compact and appears directly
  // in/near the link itself: "APPARTEMENT T2 A LOUER SURESNES 1 198 €
  // charges comprises par mois". Confirmed via live fetch.
  Perenium: {
    url: 'https://www.perenium.eu/location.php',
    waitForSelector: 'a[href*="/fiche-"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/fiche-"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 20; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  // Helix Immobilier — confirmed this session: built on JALIS platform.
  // Link pattern: /details-{slug}-{id} (no file extension, no /fiches/).
  // Text includes title, short description, and price as separate
  // visible text near the link. Confirmed via live fetch on the
  // homepage — using the dedicated rental category page for actual
  // scraping since the homepage mixes sale ("Acheter") and rental
  // ("Louer") listings together.
  'Helix Immobilier': {
    url: 'https://www.heliximmobilier.com/location-appartements-w1',
    waitForSelector: 'a[href*="/details-"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/details-"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 4 && container && container.innerText.length < 30; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  // Breteuil Homes — confirmed this session: custom platform (Sentry-
  // instrumented, custom CDN cdn.bre.im). Link pattern: /proprietes/
  // {rooms}pieces-{slug}-{id}. Uses the dedicated /louer page, NOT the
  // homepage (which mixes Acheter/Louer/Location Saisonnière). Confirmed
  // a "Loué" badge appears as a SEPARATE sibling element next to the
  // listing link, not inline within it — verified via a real DOM test
  // (jsdom) that the shared isAlreadyRented filter in scrape-runner.js
  // still catches this correctly because the container-walk picks up
  // the sibling badge into the same text block. Also lists international
  // properties (London in GBP) alongside French ones — fine to leave
  // in, as currency symbol differs and parseListingText's price regex
  // is € specific, so GBP listings will simply have a null price rather
  // than a wrong one.
  'Breteuil Homes': {
    url: 'https://breteuilhomes.com/louer',
    waitForSelector: 'a[href*="/proprietes/"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/proprietes/"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 20; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  // Patrimoine Immo — confirmed this session: WordPress platform.
  // Link pattern: /annonce-immobiliere/{id}-{slug}/. Confirmed via live
  // fetch: 44 real listings, server-rendered (no JS needed), clean
  // consistent text format throughout — "Location Appartement {size}m2
  // {city} {sqm} m² | {rooms} pièce(s) [| {bedrooms} chambre(s)]
  // {price}€ / mois". No "already-rented" trap observed on this page
  // (unlike Palais Royal / Nicolas Devillard / Luxe Prestige Immo) —
  // the universal isAlreadyRented filter in scrape-runner.js still
  // applies as a safety net regardless.
  'Patrimoine Immo': {
    url: 'https://patrimoine-immo.com/annonce-immobiliere/?contract-type=rental',
    waitForSelector: 'a[href*="/annonce-immobiliere/"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/annonce-immobiliere/"]'))
        .filter(a => /\/annonce-immobiliere\/\d+-/.test(a.href)); // exclude the bare category link itself
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);
        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 20; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },
};

module.exports = { SCRAPER_CONFIG };
