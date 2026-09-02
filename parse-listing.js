// netlify/functions/parse-listing.js
//
// FIXED vs original price regex bug (unchanged from earlier fix):
//   Real listing text is "12 000 000 €" / "€ 17,000 / month" — digits
//   before OR after the symbol depending on rent vs buy phrasing on this
//   site. Both are handled below.
//
// NEW this pass: "Price upon request" / "Prix sur demande" listings.
//   These are legitimate ultra-high-end properties with no public price —
//   NOT a parsing failure. They must be distinguished from a genuine
//   parse miss (price: 0 because the regex didn't match) so a future
//   debugging pass doesn't waste time "fixing" something that isn't broken.

const PRICE_ON_REQUEST_PATTERNS = [
  /price\s+upon\s+request/i,
  /prix\s+sur\s+demande/i,
];

function parseListing(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return emptyListing();
  }

  const text = rawText.trim();

  const isPriceOnRequest = PRICE_ON_REQUEST_PATTERNS.some(p => p.test(text));

  // Room-share listings ("Colocation à louer" — real confirmed SeLoger
  // phrasing, seen live) are a single room within a shared apartment, not
  // a full unit — a different category than what this tool is meant to
  // find. Detected here in the shared parser so it applies uniformly
  // across every source, not just SeLoger.
  const isRoomShare = /\bcolocation\b|\bcoloc\b|\bcolocataires?\b|\broommate\b|\bshared\s+room\b|\bcoliving\b/i.test(text);

  // ---- PRICE -----------------------------------------------------------
  let price = 0;

  const SEP = ' \u00A0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u200B\uFEFF.,';
  const PRICE_NUMBER = `(?:\\d{1,3}(?:[${SEP}]\\d{3})+|\\d+)`;
  const NO_DIGIT_BEFORE = '(?<!\\d)';
  const SL = '[ \\t\\u00A0\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200A\\u202F\\u205F\\u3000\\u200B\\uFEFF]*';

  if (!isPriceOnRequest) {
    const rentAfter = text.match(new RegExp(`${NO_DIGIT_BEFORE}(${PRICE_NUMBER})${SL}€${SL}\\/${SL}(mois|month)`, 'i'));
    const rentBefore = text.match(new RegExp(`€${SL}${NO_DIGIT_BEFORE}(${PRICE_NUMBER})${SL}\\/${SL}(mois|month)`, 'i'));
    const saleAfter = text.match(new RegExp(`${NO_DIGIT_BEFORE}(${PRICE_NUMBER})${SL}€`));
    const saleBefore = text.match(new RegExp(`€${SL}${NO_DIGIT_BEFORE}(${PRICE_NUMBER})(?!${SL}(?:AED|\\$|USD|CHF|£|₪|¥))`, 'i'));

    const toInt = (s) => parseInt(s.replace(new RegExp(`[${SEP}]`, 'g'), ''), 10);

    if (rentAfter) price = toInt(rentAfter[1]);
    else if (rentBefore) price = toInt(rentBefore[1]);
    else if (saleAfter) price = toInt(saleAfter[1]);
    else if (saleBefore) price = toInt(saleBefore[1]);

    if (!Number.isFinite(price) || price <= 0 || price > 100000000) price = 0;
  }

  // ---- ROOMS / BEDROOMS ----------------------------------------------------
  const bedroomsMatch = text.match(/(\d+)\s*(?:bedrooms?|chambres?)(?![a-zA-Z])/i);
  let bedrooms = bedroomsMatch ? parseInt(bedroomsMatch[1], 10) : null;

  const roomsMatch = text.match(/\bT(\d+)\b|\b(\d+)\s*(?:pi[eè]ces?|rooms?)(?![a-zA-Z])/i);
  const rooms = roomsMatch ? parseInt(roomsMatch[1] || roomsMatch[2], 10) : bedrooms;

  if (bedrooms === null && rooms === 1) {
    bedrooms = 1;
  }

  const bathroomsMatch = text.match(/(\d+|une?)\s*(?:bathrooms?|salles?\s+de\s+bains?|salles?\s+d'eau|wc|toilettes?)(?![a-zA-Z])/i);
  const bathrooms = bathroomsMatch ? (/^une?$/i.test(bathroomsMatch[1]) ? 1 : parseInt(bathroomsMatch[1], 10)) : null;

  // ---- SURFACE -------------------------------------------------------------
  const SQ_SPACES = ' \\t\\u00A0\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200A\\u202F\\u205F\\u3000\\u200B\\uFEFF';
  const sqmMatch = text.match(new RegExp(`(?<!\\d)(\\d[\\d${SQ_SPACES}]*(?:[.,]\\d+)?)[${SQ_SPACES}]*(?:m²|m2|sqm)\\b(?!\\w)`, 'i')) ||
                    text.match(new RegExp(`(?<!\\d)(\\d[\\d${SQ_SPACES}]*(?:[.,]\\d+)?)[${SQ_SPACES}]*(?:m²|m2|sqm)`, 'i'));
  const sqm = sqmMatch ? parseFloat(sqmMatch[1].replace(new RegExp(`[${SQ_SPACES}]`, 'g'), '').replace(',', '.')) : null;

  // ---- ADDRESS / ARRONDISSEMENT --------------------------------------------
  let address = '';
  const ARR_NUM = '(?:[1-9]|1[0-9]|20)';
  // BUG FIX (2026-09-02): (?!\s*\d) treats a newline as whitespace, so
  // it looks PAST a line break into the next line to check for a
  // following digit. This silently rejected valid arrondissement
  // matches whenever the very next line happened to start with a
  // number — e.g. "PARIS 17\n13.07 m²" was rejected because "13"
  // starts the next line, even though "17" is clearly its own number
  // terminated by the line break. Confirmed live: this was the root
  // cause of garbage addresses/areas for Patrimoine Immo, Dynagest, and
  // others whose cards put the arrondissement on its own line right
  // before the specs line. Restricted the lookahead to [ \t]* (same
  // line only) so a newline correctly terminates the number.
  const parisMatch = text.match(new RegExp(`Paris\\s*${ARR_NUM}\\s*(?:er|ème|eme|e|th|st|nd|rd)\\b|Paris\\s*${ARR_NUM}(?![ \\t]*\\d)\\b`, 'i'));
  if (parisMatch) {
    address = parisMatch[0].trim();
  } else {
    const addressPatterns = [
      /(?<![a-zA-Z])(\d+[ \t]+(?:rue|avenue|boulevard|place|square|allée|chemin|quai)[^,\n|]*)/i,
      /(\b7\d{4}\b[^,\n|]*)/
    ];
    for (const pattern of addressPatterns) {
      const match = text.match(pattern);
      if (match) { address = match[1].trim(); break; }
    }
  }
  if (!address) {
    const badgeWords = /^(exclusivit[ée]|nouveau|appartement|maison|studio|duplex|loft|new|price on request|furnished apartment for rent|unfurnished apartment for rent)$/i;
    // BUG FIX (2026-09-02): this filter only recognized "X €/mois"
    // (with a slash). Sources that write "X € par mois" instead (Orpi,
    // Breteuil Homes, others) — no slash — slipped straight through
    // this filter and got picked as the "address", which is exactly
    // why Orpi rows showed a repeated price string as both area and
    // address in the live dashboard.
    const priceOnlyLine = /^\d[\d\s.,]*\s*€\s*((\/|par)\s*(mois|month))?\s*(charges? (comprises?|incluses?)|hors charges)?\s*$/i;
    const refNumberLine = /^ref\.?\s*\d+$/i;
    const photoCounterLine = /^\d+\s*\/\s*\d+$/;
    // NEW (2026-09-02): defensive filter for specs-only lines like
    // "13.07 m² | 1 pièce" or "4 Bedrooms · 243 m² · 4 bathrooms" —
    // never explicitly excluded before, so if the arrondissement match
    // above ever fails, this stops a specs line from being mistaken for
    // the address. Strips every recognized spec token/number/separator
    // and checks whether anything real is left, rather than a rigid
    // regex shape (which missed "pièce(s)" parens, bullet separators,
    // etc. in testing).
    function isSpecsOnlyLine(line) {
      const stripped = line
        .replace(/m²|m2|sqm|sq\s*ft/gi, ' ')
        .replace(/pi[eè]ces?(\(s\))?/gi, ' ')
        .replace(/chambres?/gi, ' ')
        .replace(/bedrooms?/gi, ' ')
        .replace(/bathrooms?/gi, ' ')
        .replace(/salles?\s*de\s*bains?/gi, ' ')
        .replace(/[\d.,|·/\-()\s]+/g, ' ')
        .trim();
      return stripped.length === 0;
    }
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5 && !photoCounterLine.test(l));
    const usableLine = lines.find(l => !badgeWords.test(l) && !priceOnlyLine.test(l) && !refNumberLine.test(l) && !isSpecsOnlyLine(l));
    address = usableLine || lines[0] || '';
  }

  // ---- DERIVED FIELDS -----------------------------------------------------
  const pricePerSqm = (price > 0 && sqm > 0) ? Math.round(price / sqm) : null;
  const sqft = (sqm > 0) ? Math.round(sqm * 10.764) : null;

  let matchScore = 0;
  if (price > 0 || isPriceOnRequest) matchScore += 25;
  if (rooms !== null) matchScore += 25;
  if (sqm !== null) matchScore += 25;
  if (address && address.length > 3) matchScore += 25;

  return {
    price,
    priceOnRequest: isPriceOnRequest,
    pricePerSqm,
    rooms,
    bedrooms,
    bathrooms,
    sqm,
    sqft,
    address: address.substring(0, 200),
    matchScore,
    isExactListing: matchScore >= 75,
    isRoomShare
  };
}

function emptyListing() {
  return {
    price: 0,
    priceOnRequest: false,
    pricePerSqm: null,
    rooms: null,
    bedrooms: null,
    bathrooms: null,
    sqm: null,
    sqft: null,
    address: '',
    matchScore: 0,
    isExactListing: false,
    isRoomShare: false
  };
}

// Extracts elevator/balcony/furnished from an individual listing's text
// (either a detail page's full body text, or — for sources whose summary
// card already states this — the summary card text itself). Deliberately
// text-based rather than selector-based: we can't inspect every source's
// actual CSS classes/DOM structure from outside, so matching on words in
// the rendered text is more robust to markup changes than guessing at
// selectors we can't verify.
function extractDetailFeatures(pageText) {
  const text = (pageText || '');

  let elevator = false;
  if (!/\bsans\s+ascenseur\b/i.test(text) && !/\bno\s+lift\b/i.test(text)) {
    elevator = /\b(lift|elevator|ascenseur)\b/i.test(text);
  }

  const balcony = /\b(balcony|balcon)\b/i.test(text);

  let furnished = null;
  if (/\bunfurnished\b/i.test(text) || /\bnon[\s-]?meubl[é]/i.test(text)) {
    furnished = false;
  } else if (/\bfurnished\b/i.test(text) || /\bmeubl[é]/i.test(text)) {
    furnished = true;
  }

  let bathroomsFromDetail = null;
  const bathMatch = text.match(/(\d+|une?)\s*salles?\s*(?:de)?\s*(?:bain|douche|d'eau)s?/i)
    || text.match(/(\d+|une?)\s*(?:bathrooms?|wc|toilettes?|sdb)\b/i);
  if (bathMatch) {
    bathroomsFromDetail = /^une?$/i.test(bathMatch[1]) ? 1 : parseInt(bathMatch[1], 10);
  }

  let bedroomsFromDetail = null;
  const bedroomDetailMatch = text.match(/(\d+)\s*(?:chambres?|bedrooms?)(?![a-zA-Z])/i);
  if (bedroomDetailMatch) {
    bedroomsFromDetail = parseInt(bedroomDetailMatch[1], 10);
  }

  return { elevator, balcony, furnished, bathroomsFromDetail, bedroomsFromDetail };
}

// Merges a possibly-better value from a second pass (e.g. a detail-page
// fetch) onto an existing value (e.g. one already found from a cheaper
// summary-card pass). A second pass can CONFIRM or ADD information, but a
// FAILED fetch (which returns null, not false) must never erase a value a
// cheaper earlier pass already found — that was the root cause of several
// real bugs across this codebase (DanielFeau, Book-a-Flat, Perenium all
// had a variant of "detail-page enrichment silently wipes a good
// summary-card value back to null on any fetch failure").
//
// Usage: mergeFeature(preferred, fallback) — pass whichever value you
// trust MORE first. For most sources that's the summary-card value being
// preferred over an as-yet-unconfirmed detail fetch is WRONG — you
// generally want the detail-page value to win when it's actually present
// (it's usually the more complete source), and only fall back to the
// summary-card value when the detail fetch failed (returned null).
// Concretely: mergeFeature(detailPageValue, summaryCardValue).
function mergeFeature(preferred, fallback) {
  return preferred != null ? preferred : fallback;
}

module.exports = parseListing;
module.exports.extractDetailFeatures = extractDetailFeatures;
module.exports.mergeFeature = mergeFeature;
