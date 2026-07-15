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

  // PRICE_NUMBER requires PROPERLY grouped digits: 1-3 digits, then zero
  // or more groups of EXACTLY 3 digits separated by space/period/comma.
  // Real bug found via Book-a-Flat: the old pattern (\d[\d\s.,]*\d)
  // allowed ANY amount of internal whitespace, so "92 1131 €/MONTH" (a
  // department code "92" sitting directly next to the real price "1131",
  // no separator between them) got fused into "921131". Requiring exactly
  // 3-digit subsequent groups rejects that fusion (since "1131" is 4
  // digits, not a valid group) while still matching real thousands
  // groupings like "12 000", "17,000", "1 131".
  // PRICE_NUMBER accepts EITHER a plain digit run with no internal
  // separators ("50000") OR a properly-grouped number ("12 000",
  // "17,000") — but NOT an improperly-fused pair like "92 1131" (a
  // department code sitting right next to a price with a space but no
  // valid 3-digit grouping). A real regression was caught while fixing
  // this: requiring ONLY the grouped form broke plain numbers like
  // "50000 €/MONTH" (Book-a-Flat's actual format) entirely.
  //
  // IMPORTANT: the separator includes literal space (" "), non-breaking
  // space (U+00A0), and narrow no-break space (U+202F) — NOT the general
  // \s whitespace class (see the newline-fusion bug note below for why).
  // Real bug found via DanielFeau/SeLoger/Junot/Perenium simultaneously:
  // French sites commonly render thousands separators as U+00A0 or
  // U+202F for typographic reasons (preventing numbers from breaking
  // across a line), not a plain ASCII space. Since the old character
  // class only recognized literal " ", the "properly grouped" alternative
  // silently failed to recognize "4\u00A0049" as one grouped number,
  // falling through to the plain-digit-run alternative — which only
  // matches the LAST group before €, discarding everything before it
  // (reported as "4049 shows as 49"). This one shared-parser fix
  // resolves the same bug across all 4 affected sources at once.
  //
  // A second real bug was found via Perenium: the general \s class
  // matches newlines too, so "...17.13 m2\n825 €..." (the trailing "2" of
  // "m2", a genuine line break, then the real price "825" on the next
  // line) satisfied the grouping pattern as "2\n825" — treating a line
  // break between two completely unrelated numbers as a thousands
  // separator. Real separators are always same-line, hence the specific
  // character list here rather than \s.
  const SEP = ' \u00A0\u202F.,';
  const PRICE_NUMBER = `(?:\\d{1,3}(?:[${SEP}]\\d{3})+|\\d+)`;
  const NO_DIGIT_BEFORE = '(?<!\\d)';
  // Same-line-only whitespace for the connective tissue immediately
  // around € (NOT \s, which matches newlines). Real bug found via live
  // testing on Junot/SeLoger/Perenium/DanielFeau: text like
  // "15 000 €\n\n120,00 m²" (price on one line, sqm on the next,
  // separated by a blank line) let saleBefore's old \s* reach straight
  // across that gap and grab "120" (the unrelated sqm value) as if it
  // were "the price following this €". A genuine price and its currency
  // symbol are always on the same visual line — restricting to
  // space/tab only prevents reaching into a completely different field.
  const SL = '[ \\t]*';

  if (!isPriceOnRequest) {
    const rentAfter = text.match(new RegExp(`${NO_DIGIT_BEFORE}(${PRICE_NUMBER})${SL}€${SL}\\/${SL}(mois|month)`, 'i'));
    const rentBefore = text.match(new RegExp(`€${SL}${NO_DIGIT_BEFORE}(${PRICE_NUMBER})${SL}\\/${SL}(mois|month)`, 'i'));
    const saleAfter = text.match(new RegExp(`${NO_DIGIT_BEFORE}(${PRICE_NUMBER})${SL}€(?!${SL}\\d)`));
    const saleBefore = text.match(new RegExp(`€${SL}${NO_DIGIT_BEFORE}(${PRICE_NUMBER})(?!${SL}(?:AED|\\$|USD|CHF|£|₪|¥))`, 'i'));

    const toInt = (s) => parseInt(s.replace(new RegExp(`[${SEP}]`, 'g'), ''), 10);

    if (rentAfter) price = toInt(rentAfter[1]);
    else if (rentBefore) price = toInt(rentBefore[1]);
    else if (saleAfter) price = toInt(saleAfter[1]);
    else if (saleBefore) price = toInt(saleBefore[1]);

    if (!Number.isFinite(price) || price <= 0 || price > 100000000) price = 0;
  }

  // ---- ROOMS / BEDROOMS ----------------------------------------------------
  // Trailing \b replaced with (?![a-zA-Z]) after a real bug found via
  // DanielFeau: their text concatenates adjacent counts with no space
  // ("4 pièces2 chambres" — no space between "pièces" and "2"). A \b
  // boundary doesn't exist between a letter and a following digit (both
  // count as "word" characters to regex), so the old pattern silently
  // failed to match "4 pièces" here at all — and since roomsMatch failing
  // makes the code fall back to using the BEDROOM count as a stand-in for
  // rooms, the real room count was silently lost, not just misparsed.
  // (?![a-zA-Z]) still rejects false matches like "piecework" (followed by
  // a letter) while allowing a following digit or space through.
  const bedroomsMatch = text.match(/(\d+)\s*(?:bedrooms?|chambres?)(?![a-zA-Z])/i);
  const bedrooms = bedroomsMatch ? parseInt(bedroomsMatch[1], 10) : null;

  const roomsMatch = text.match(/\bT(\d+)\b|\b(\d+)\s*(?:pi[eè]ces?|rooms?)(?![a-zA-Z])/i);
  const rooms = roomsMatch ? parseInt(roomsMatch[1] || roomsMatch[2], 10) : bedrooms;

  const bathroomsMatch = text.match(/(\d+)\s*(?:bathrooms?|salles?\s+de\s+bains?|salles?\s+d'eau|wc|toilettes?)(?![a-zA-Z])/i);
  const bathrooms = bathroomsMatch ? parseInt(bathroomsMatch[1], 10) : null;

  // ---- SURFACE -------------------------------------------------------------
  // Added 'sqm' after finding Eiffel Housing uses this English
  // abbreviation exclusively ("263 sqm") — the old pattern only
  // recognized 'm²'/'m2', silently returning null for every listing from
  // this source.
  //
  // Same-line-only whitespace fix (same class of bug as the price regex
  // above): "...SAINT-VINCENT DE PAUL 5\n42.59 M2" (a street number "5"
  // on one line, the real sqm "42.59" on the next) was matching as
  // "5\n42" via the old [\d\s]* group, since \s matches newlines. Real
  // evidence from Perenium live testing.
  const sqmMatch = text.match(/(?<!\d)(\d[\d \t]*(?:[.,]\d+)?)[ \t]*(?:m²|m2|sqm)\b(?!\w)/i) ||
                    text.match(/(?<!\d)(\d[\d \t]*(?:[.,]\d+)?)[ \t]*(?:m²|m2|sqm)/i);
  const sqm = sqmMatch ? parseFloat(sqmMatch[1].replace(/[\s\t]/g, '').replace(',', '.')) : null;

  // ---- ADDRESS / ARRONDISSEMENT --------------------------------------------
  // Added bare "e" (e.g. "Paris 6e") after real evidence: Junot writes
  // arrondissements this way, not "ème"/"eme" like Barnes/SeLoger. Without
  // it, this regex failed on most Junot listings, falling through to the
  // "first line" fallback below — which for Junot's raw text is usually a
  // listing badge ("EXCLUSIVITÉ") or property type ("APPARTEMENT"), not a
  // location at all.
  let address = '';
  // Split into two alternatives: WITH a suffix (er/ème/th/etc), the
  // ordinal is already confirmed complete, no extra guard needed. WITHOUT
  // a suffix (Eiffel Housing's bare "Paris 16"), guard against more
  // digits following — that's what distinguishes a genuine bare
  // arrondissement from "Paris" sitting next to an unrelated price like
  // "Paris 2 200 €". Combining both cases into one optional-suffix regex
  // caused a real regression: the guard incorrectly also blocked
  // suffixed cases like "1er" when a price happened to follow.
  const parisMatch = text.match(/Paris\s*\d{1,2}\s*(?:er|ème|eme|e|th|st|nd|rd)\b|Paris\s*\d{1,2}(?!\s*\d)\b/i);
  if (parisMatch) {
    address = parisMatch[0].trim();
  } else {
    const addressPatterns = [
      // Negative lookbehind (?<![a-zA-Z]) added after a real bug: without
      // it, "16M2 rue Gutenberg" matched starting at the trailing "2" in
      // "M2" (mistaking it for a house number), swallowing almost the
      // entire rest of the raw text as the "address". Requiring the
      // digit NOT be preceded by a letter rejects that false match while
      // still matching genuine house numbers like "5 rue de la Paix".
      /(?<![a-zA-Z])(\d+\s+(?:rue|avenue|boulevard|place|square|allée|chemin|quai)[^,\n|]*)/i,
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
    const badgeWords = /^(exclusivit[ée]|nouveau|appartement|maison|studio|duplex|loft|new|price on request|furnished apartment for rent|unfurnished apartment for rent)$/i;
    const priceOnlyLine = /^\d[\d\s.,]*\s*€\s*(\/\s*(mois|month))?\s*(charges? (comprises?|incluses?)|hors charges)?\s*$/i;
    // Found via ParisRental: "Ref. 58221" is consistently the first line of
    // raw card text and is never a location — same class of fix as
    // badgeWords/priceOnlyLine, filtering out a known non-address pattern
    // rather than blindly trusting whatever line comes first.
    const refNumberLine = /^ref\.?\s*\d+$/i;
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);
    const usableLine = lines.find(l => !badgeWords.test(l) && !priceOnlyLine.test(l) && !refNumberLine.test(l));
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
  const bathMatch = text.match(/(\d+)\s*salles?\s*(?:de)?\s*(?:bain|douche|d'eau)s?/i)
    || text.match(/(\d+)\s*(?:bathrooms?|wc|toilettes?|sdb)\b/i);
  if (bathMatch) {
    bathroomsFromDetail = parseInt(bathMatch[1], 10);
  }

  // Bedroom count from the fuller detail-page description. Real evidence:
  // SeLoger listings very commonly state BOTH pièces (total rooms) and
  // chambres (bedrooms specifically) explicitly in their full
  // description — e.g. "6 pièces - 4 chambres", "5 pièces (3 chambres)"
  // — even when the shorter summary-card text only shows the pièces
  // count. This lets us fill in a real bedroom count for sources where
  // the summary alone was ambiguous between total rooms and bedrooms.
  let bedroomsFromDetail = null;
  const bedroomDetailMatch = text.match(/(\d+)\s*(?:chambres?|bedrooms?)(?![a-zA-Z])/i);
  if (bedroomDetailMatch) {
    bedroomsFromDetail = parseInt(bedroomDetailMatch[1], 10);
  }

  return { elevator, balcony, furnished, bathroomsFromDetail, bedroomsFromDetail };
}

module.exports = parseListing;
module.exports.extractDetailFeatures = extractDetailFeatures;
