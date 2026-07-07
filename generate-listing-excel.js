// generate-listing-excel.js
// Runs the combiner (Barnes + SeLoger) and writes ONE Excel file.
//
// IMPORTANT: always writes to the SAME filename ("listings.xlsx" /
// "listings-purchase.xlsx") — never a date-stamped name. That means each
// day's scheduled run overwrites this file's contents, and Git/GitHub
// tracks it as "this file changed," not "a new file was added." Same
// download link forever, always showing the latest data.
//
// Usage:
//   node generate-listing-excel.js rent
//   node generate-listing-excel.js purchase
//   node generate-listing-excel.js rent details

const ExcelJS = require('exceljs');
const { combineAllSources } = require('./combine-sources');

async function main() {
  const searchType = process.argv[2] === 'purchase' ? 'purchase' : 'rent';
  const fetchDetails = process.argv[3] === 'details';

  console.log(`Combining sources for ${searchType}${fetchDetails ? ' (with detail enrichment)' : ''}...`);
  const data = await combineAllSources(searchType, { fetchDetails });

  console.log(`\nTotal combined listings: ${data.totalListings}`);
  data.sourceStatus.forEach(s => console.log(`  ${s.source}: ${s.error ? 'FAILED - ' + s.error : s.found + ' listings'}`));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Prospector';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Listings', {
    views: [{ state: 'frozen', ySplit: 1 }] // freeze header row
  });

  // No longer gated on the fetchDetails flag — SeLoger always enriches
  // regardless of that flag (only Barnes' optional slow fetch respects it),
  // so whether to show these columns should depend on whether the data
  // actually has them, not on a flag that's now only half-relevant.
  const hasDetails = data.listings.some(l => 'elevator' in l);

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

  const priceColIdx = columns.findIndex(c => c.key === 'price') + 1; // 1-based
  const sqmColIdx = columns.findIndex(c => c.key === 'sqm') + 1;
  const pricePerSqmColIdx = columns.findIndex(c => c.key === 'pricePerSqm') + 1;
  const priceColLetter = sheet.getColumn(priceColIdx).letter;
  const sqmColLetter = sheet.getColumn(sqmColIdx).letter;

  data.listings.forEach(l => {
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

    // Real Excel formula for €/m² (not a hardcoded pre-calculated value),
    // so the sheet stays dynamic if price/sqm get edited by hand later.
    // Only when both price and sqm are actual numbers — "On request"
    // listings or missing sqm would produce a #VALUE!/#DIV/0! error.
    if (typeof l.price === 'number' && l.price > 0 && typeof l.sqm === 'number' && l.sqm > 0) {
      const r = addedRow.number;
      addedRow.getCell(pricePerSqmColIdx).value = {
        formula: `${priceColLetter}${r}/${sqmColLetter}${r}`
      };
      addedRow.getCell(pricePerSqmColIdx).numFmt = '#,##0';
    }
  });

  // Header styling
  sheet.getRow(1).font = { bold: true, name: 'Arial' };
  sheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length }
  };

  // Whole-sheet font for readability, and currency formatting where relevant
  sheet.eachRow((row, i) => {
    if (i === 1) return;
    row.font = { name: 'Arial', size: 10 };
    const priceCell = row.getCell(priceColIdx);
    if (typeof priceCell.value === 'number') priceCell.numFmt = '#,##0" €"';
  });

  // Info sheet — generation time + per-source status, so anyone opening
  // the file knows how fresh it is and whether a source failed that day.
  const info = workbook.addWorksheet('Info');
  info.getCell('A1').value = 'Prospector — Paris Listings';
  info.getCell('A1').font = { bold: true, size: 14, name: 'Arial' };
  info.getCell('A2').value = `Generated: ${new Date(data.generatedAt).toLocaleString('en-GB')}`;
  info.getCell('A2').font = { name: 'Arial' };
  data.sourceStatus.forEach((s, i) => {
    const cell = info.getCell(`A${3 + i}`);
    cell.value = s.error ? `${s.source}: FAILED — ${s.error}` : `${s.source}: ${s.found} listings`;
    cell.font = { name: 'Arial', color: s.error ? { argb: 'FFCC0000' } : undefined };
  });
  info.getColumn('A').width = 90;

  const filename = searchType === 'purchase' ? 'listings-purchase.xlsx' : 'listings.xlsx';
  await workbook.xlsx.writeFile(filename);

  console.log(`\n✅ Wrote ${data.totalListings} combined listings to ${filename}`);
  console.log(`This filename never changes — each run overwrites it, same download link every time.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
