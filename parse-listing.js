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

  // ---- PRICE -----------------------------------------------------------
  let price = 0;

  if (!isPriceOnRequest) {
    const rentAfter = text.match(/(\d[\d\s.,]*\d|\d)\s*€\s*\/\s*(mois|month)/i);
    const rentBefore = text.match(/€\s*(\d[\d\s.,]*\d|\d)\s*\/\s*(mois|month)/i);
    const saleAfter = text.match(/(\d[\d\s.,]*\d|\d)\s*€(?!\s*\d)/);
    const saleBefore = text.match(/€\s*(\d[\d\s.,]*\d|\d)(?!\s*(?:AED|\$|USD|CHF|£|₪|¥))/i);

    const toInt = (s) => parseInt(s.replace(/[\s.,]/g, ''), 10);

    if (rentAfter) price = toInt(rentAfter[1]);
    else if (rentBefore) price = toInt(rentBefore[1]);
    else if (saleAfter) price = toInt(saleAfter[1]);
    else if (saleBefore) price = toInt(saleBefore[1]);

    if (!Number.isFinite(price) || price <= 0 || price > 100000000) price = 0;
  }

  // ---- ROOMS / BEDROOMS ----------------------------------------------------
  const bedroomsMatch = text.match(/(\d+)\s*(?:bedrooms?|chambres?)\b/i);
  const bedrooms = bedroomsMatch ? parseInt(bedroomsMatch[1], 10) : null;

  const roomsMatch = text.match(/\bT(\d+)\b|\b(\d+)\s*(?:pi[eè]ces?|rooms?)\b/i);
  const rooms = roomsMatch ? parseInt(roomsMatch[1] || roomsMatch[2], 10) : bedrooms;

  const bathroomsMatch = text.match(/(\d+)\s*(?:bathrooms?|salles?\s+de\s+bains?)\b/i);
  const bathrooms = bathroomsMatch ? parseInt(bathroomsMatch[1], 10) : null;

  // ---- SURFACE -------------------------------------------------------------
  const sqmMatch = text.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*m(?:²|2)\b(?!\w)/i) ||
                    text.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*m(?:²|2)/i);
  const sqm = sqmMatch ? parseFloat(sqmMatch[1].replace(/\s/g, '').replace(',', '.')) : null;

  // ---- ADDRESS / ARRONDISSEMENT --------------------------------------------
  // Added bare "e" (e.g. "Paris 6e") after real evidence: Junot writes
  // arrondissements this way, not "ème"/"eme" like Barnes/SeLoger. Without
  // it, this regex failed on most Junot listings, falling through to the
  // "first line" fallback below — which for Junot's raw text is usually a
  // listing badge ("EXCLUSIVITÉ") or property type ("APPARTEMENT"), not a
  // location at all.
  let address = '';
  const parisMatch = text.match(/Paris\s*\d{1,2}(?:er|ème|eme|e|th|st|nd|rd)\b/i);
  if (parisMatch) {
    address = parisMatch[0];
  } else {
    const addressPatterns = [
      /(\d+\s+(?:rue|avenue|boulevard|place|square|allée|chemin|quai)[^,\n|]*)/i,
      /(\b7\d{4}\b[^,\n|]*)/
    ];
    for (const pattern of addressPatterns) {
      const match = text.match(pattern);
      if (match) { address = match[1].trim(); break; }
    }
  }
  if (!address) {
    // Fallback of last resort — skip lines that are clearly NOT an address:
    // all-caps badges (EXCLUSIVITÉ, NOUVEAU), common property-type words,
    // or a line that's PURELY a price fragment (not just "contains a €",
    // since real address lines often mix location and price together —
    // over-filtering on that basis was tested and found to wrongly reject
    // legitimate lines).
    const badgeWords = /^(exclusivit[ée]|nouveau|appartement|maison|studio|duplex|loft|new|price on request)$/i;
    const priceOnlyLine = /^\d[\d\s.,]*\s*€\s*(\/\s*(mois|month))?\s*(charges? (comprises?|incluses?)|hors charges)?\s*$/i;
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);
    const usableLine = lines.find(l => !badgeWords.test(l) && !priceOnlyLine.test(l));
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
    isExactListing: matchScore >= 75
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
    isExactListing: false
  };
}

// Extracts elevator/balcony/furnished from an individual listing DETAIL
// page's full body text (not the summary card — this data only exists on
// the detail page). Deliberately text-based rather than selector-based:
// we can't inspect Barnes' actual CSS classes/DOM structure from outside,
// so matching on words in the rendered text is more robust to markup
// changes than guessing at selectors we can't verify.
function extractDetailFeatures(pageText) {
  const text = (pageText || '');

  // Order matters: "sans ascenseur" (no elevator) contains "ascenseur" as a
  // substring — checking the positive pattern first would wrongly read a
  // NEGATED mention as elevator:true. This is a real bug caught during
  // review before it shipped: Barnes' Amenities list never has this
  // problem (a checklist either lists "Lift" or omits it, never states
  // "no lift" in prose), but SeLoger's AI-generated characteristics list
  // is closer to a checklist than prose, so this may be rare there too —
  // still worth guarding since we can't verify every listing's phrasing.
  let elevator = false;
  if (!/\bsans\s+ascenseur\b/i.test(text) && !/\bno\s+lift\b/i.test(text)) {
    elevator = /\b(lift|elevator|ascenseur)\b/i.test(text);
  }

  const balcony = /\b(balcony|balcon)\b/i.test(text);

  // Order matters: "unfurnished" contains "furnished" as a substring.
  // NOTE: no trailing \b after the accented "é" in meubl[ée] — JS regex's
  // \b only recognizes ASCII word characters by default, so a trailing \b
  // right after "é" fails to match even on a clean word boundary (same
  // class of bug found earlier in this file with "m²"). Leading \b is
  // fine since it's before an ASCII "m".
  let furnished = null;
  if (/\bunfurnished\b/i.test(text) || /\bnon[\s-]?meubl[ée]/i.test(text)) {
    furnished = false;
  } else if (/\bfurnished\b/i.test(text) || /\bmeubl[ée]/i.test(text)) {
    furnished = true;
  }

  // Bathroom count from a checklist-style mention (SeLoger's "1 salle de
  // douches" / "2 salles de bain" characteristics format). Distinct from
  // parseListing()'s own bathroom field, which reads the summary card —
  // this is specifically for sources where bathroom count only appears
  // on the detail page.
  let bathroomsFromDetail = null;
  const bathMatch = text.match(/(\d+)\s*salles?\s*(?:de)?\s*(?:bain|douche)s?/i)
    || text.match(/(\d+)\s*bathrooms?\b/i);
  if (bathMatch) {
    bathroomsFromDetail = parseInt(bathMatch[1], 10);
  }

  return { elevator, balcony, furnished, bathroomsFromDetail };
}

module.exports = parseListing;
module.exports.extractDetailFeatures = extractDetailFeatures;
