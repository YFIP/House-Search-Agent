// new-agencies-config.js
//
// NEW FILE (2026-11-07). Agencies requested on 6 Nov 2026 in the
// "Real estate agencies" email thread — 8 from Anna Struzik, 5 from
// Analea Munoz-Bertrand. None overlap with Sophie's original June list.
// URLs have had ad-tracking parameters (utm_*, gclid, gad_*, hsa_*)
// stripped.
//
// All 13 run through the shared agency-auto-scraper.js. Fields:
//   source          Label shown in the "Source" column / frontend filter.
//   baseUrl         Homepage — used to discover rent/sale pages that
//                   aren't pinned below.
//   rentUrl/saleUrl Pinned listing pages. Leave unset to auto-discover.
//   rentOnly        Furnished-rental specialists — skip the sale run.
//   allFurnished    Every listing is furnished (meublé) by definition.
//   listingSelector Optional CSS selector for listing links. Leave unset
//                   until a live run shows the auto-detection needs help
//                   (check that agency's `debug` block in the
//                   output-new-agencies*.json artifact).
//
// STATUS: none of these have been verified against the live HTML yet —
// the first CI run is the verification. After it, check each agency's
// sourceStatus + debug in the artifacts and pin URLs/selectors here.

const NEW_AGENCIES = [
  // ---- From Anna ----------------------------------------------------------
  { source: 'Joya',            baseUrl: 'https://www.joya.fr',           rentUrl: 'https://www.joya.fr/louer' },
  { source: 'Freestone',       baseUrl: 'https://freestone-fr.com',      rentUrl: 'https://freestone-fr.com/annonces/', saleUrl: 'https://freestone-fr.com/annonces/' }, // one mixed page; rent/sale split by price type
  { source: 'Paris Attitude',  baseUrl: 'https://www.parisattitude.com', rentUrl: 'https://www.parisattitude.com/rent-apartment/furnished-rental/index,rentals.aspx', rentOnly: true, allFurnished: true },
  { source: 'Lodgis',          baseUrl: 'https://www.lodgis.com',        rentUrl: 'https://www.lodgis.com/fr/paris,location-meublee/', rentOnly: true, allFurnished: true },
  { source: 'Avant-Garde',     baseUrl: 'https://avant-garde.immo',      rentUrl: 'https://avant-garde.immo/biens/locations' },
  { source: 'Cour Intérieure', baseUrl: 'https://courinterieure.fr' },
  { source: 'Paris Housing',   baseUrl: 'https://www.paris-housing.com/fr', rentOnly: true, allFurnished: true },
  { source: 'Connexion Immo',  baseUrl: 'https://connexion.immo/fr',     rentUrl: 'https://connexion.immo/fr/locations-paris' },

  // ---- From Analea --------------------------------------------------------
  { source: 'Marel Immobilier', baseUrl: 'https://www.marelimmobilier.fr/en/' },
  { source: 'Franck Ross Immo', baseUrl: 'https://www.franckrossimmo.com' },
  { source: 'Meilleurs Biens',  baseUrl: 'https://meilleursbiens.com' },
  { source: 'Affinity Home',    baseUrl: 'https://affinity-home.com/en/' },
  { source: 'Léon Immobilier',  baseUrl: 'https://leonimmobilier.fr/' },
];

module.exports = { NEW_AGENCIES };
