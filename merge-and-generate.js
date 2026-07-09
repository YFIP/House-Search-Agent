// merge-and-generate.js
// Downloads/reads output-main.json (Barnes, Barnes-Suburbs, Junot, SeLoger
// Paris) plus every output-seloger-{slug}.json (one per suburb, each
// scraped in its own isolated GitHub Actions job), merges everything, and
// writes the final Excel file — same output shape as before, just
// assembled from multiple separate scrape runs instead of one process.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function findSeLogerSuburbFiles(dir) {
  return fs.readdirSync(dir).filter(f => /^output-seloger-.+\.json$/.test(f));
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function buildExcel(searchType, listings, sourceStatus, generatedAtIso) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Prospector';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Listings', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  const hasDetails = listings.some(l => 'elevator' in l);

  const columns = [
    { header: 'Source', key: 'source', width: 12 },
    { header: 'Price (€)', key: 'price', width: 14 },
    { header: 'Rooms', key: 'rooms', width: 8 },
    { header: 'Bathrooms', key: 'bathrooms', width: 10 },
    { header: 'm²', key: 'sqm', width: 8 },
    { header: '€/m²', key: 'pricePerSqm', width: 12 },
    { header: 'Address', key: 'address', width: 20 },
  ];
  if (hasDetails) {
    columns.push(
      { header: 'Elevator', key: 'elevator', width: 10 },
      { header: 'Balcony', key: 'balcony', width: 10 },
      { header: 'Furnished', key: 'furnished', width: 10 }
    );
  }
  columns.push({ header: 'URL', key: 'url', width: 55 });
  sheet.columns = columns;

  const priceColIdx = columns.findIndex(c => c.key === 'price') + 1;
  const sqmColIdx = columns.findIndex(c => c.key === 'sqm') + 1;
  const pricePerSqmColIdx = columns.findIndex(c => c.key === 'pricePerSqm') + 1;
  const priceColLetter = sheet.getColumn(priceColIdx).letter;
  const sqmColLetter = sheet.getColumn(sqmColIdx).letter;

  listings.forEach(l => {
    const row = {
      source: l.source,
      price: l.priceOnRequest ? 'On request' : l.price,
      rooms: l.rooms,
      bathrooms: l.bathrooms,
      sqm: l.sqm,
      address: l.address,
      url: l.url
    };
    if (hasDetails) {
      row.elevator = l.elevator === true ? 'Yes' : l.elevator === false ? 'No' : '';
      row.balcony = l.balcony === true ? 'Yes' : l.balcony === false ? 'No' : '';
      row.furnished = l.furnished === true ? 'Yes' : l.furnished === false ? 'No' : '';
    }
    const addedRow = sheet.addRow(row);

    if (typeof l.price === 'number' && l.price > 0 && typeof l.sqm === 'number' && l.sqm > 0) {
      const r = addedRow.number;
      addedRow.getCell(pricePerSqmColIdx).value = { formula: `${priceColLetter}${r}/${sqmColLetter}${r}` };
      addedRow.getCell(pricePerSqmColIdx).numFmt = '#,##0';
    }
  });

  sheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  sheet.eachRow((row, i) => {
    if (i === 1) return;
    row.font = { name: 'Arial', size: 10 };
    const priceCell = row.getCell(priceColIdx);
    if (typeof priceCell.value === 'number') priceCell.numFmt = '#,##0" €"';
  });

  const info = workbook.addWorksheet('Info');
  info.getCell('A1').value = 'Prospector — Paris Listings';
  info.getCell('A1').font = { bold: true, size: 14, name: 'Arial' };
  info.getCell('A2').value = `Generated: ${new Date(generatedAtIso).toLocaleString('en-GB')}`;
  info.getCell('A2').font = { name: 'Arial' };
  sourceStatus.forEach((s, i) => {
    const cell = info.getCell(`A${3 + i}`);
    cell.value = s.error ? `${s.source}: FAILED — ${s.error}` : `${s.source}: ${s.found} listings`;
    cell.font = { name: 'Arial', color: s.error ? { argb: 'FFCC0000' } : undefined };
  });
  info.getColumn('A').width = 90;

  const filename = searchType === 'purchase' ? 'listings-purchase.xlsx' : 'listings.xlsx';
  await workbook.xlsx.writeFile(filename);
  return filename;
}

async function main() {
  const searchType = process.argv[2] === 'purchase' ? 'purchase' : 'rent';
  const artifactsDir = process.argv[3] || '.';

  console.log(`Merging main sources with individual SeLoger suburb results from: ${artifactsDir}`);

  const mainDataPath = path.join(artifactsDir, 'output-main.json');
  if (!fs.existsSync(mainDataPath)) {
    console.error(`Missing ${mainDataPath} — the main-sources job may not have completed or its artifact wasn't downloaded correctly.`);
    process.exit(1);
  }
  const mainData = loadJson(mainDataPath);

  const suburbFiles = findSeLogerSuburbFiles(artifactsDir);
  console.log(`Found ${suburbFiles.length} SeLoger suburb result file(s): ${suburbFiles.join(', ') || '(none)'}`);

  const allListings = [...mainData.listings];
  const allSourceStatus = [...mainData.sourceStatus];

  for (const file of suburbFiles) {
    const result = loadJson(path.join(artifactsDir, file));
    if (result.error) {
      allSourceStatus.push({ source: `SeLoger-Suburb-${result.slug}`, found: 0, error: result.error });
    } else {
      allListings.push(...result.listings);
      allSourceStatus.push({ source: `SeLoger-Suburb-${result.slug}`, found: result.listings.length, error: null });
    }
  }

  console.log(`\nCombined total: ${allListings.length} listings`);
  allSourceStatus.forEach(s => console.log(`  ${s.source}: ${s.error ? 'FAILED - ' + s.error : s.found + ' listings'}`));

  const filename = await buildExcel(searchType, allListings, allSourceStatus, new Date().toISOString());
  console.log(`\n✅ Wrote ${allListings.length} combined listings to ${filename}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
