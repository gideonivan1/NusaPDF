import {
  buildArchive,
  columnToIndex,
  escapeXml,
  findAll,
  indexToColumn,
  listEntries,
  openArchive,
  parseXml,
  readText,
  type Archive,
} from './ooxml';

/** A sheet as a rectangular grid of already-formatted cell strings. */
export interface Sheet {
  name: string;
  rows: string[][];
}

/* ==========================================================================
   Reading
   ========================================================================== */

export function readWorkbook(buffer: ArrayBuffer): Sheet[] {
  const archive = openArchive(buffer);

  const workbookXml = readText(archive, 'xl/workbook.xml');
  if (!workbookXml) throw new Error('Bukan berkas Excel (.xlsx) yang valid');

  const sharedStrings = readSharedStrings(archive);
  const relationships = readRelationships(archive);
  const workbook = parseXml(workbookXml);

  const sheets: Sheet[] = [];

  for (const [index, element] of findAll(workbook.documentElement, 'sheet').entries()) {
    const name = element.getAttribute('name') ?? `Sheet${index + 1}`;
    const relationId =
      element.getAttribute('r:id') ??
      element.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');

    // Fall back to positional matching when the relationship is missing —
    // some generators emit workbooks without usable r:id attributes.
    const target = relationId ? relationships[relationId] : undefined;
    const path = target
      ? normalisePath(target)
      : listEntries(archive, 'xl/worksheets/', '.xml')[index];

    const sheetXml = path ? readText(archive, path) : null;
    if (!sheetXml) continue;

    sheets.push({ name, rows: readSheetRows(sheetXml, sharedStrings) });
  }

  if (sheets.length === 0) throw new Error('Tidak ada lembar kerja yang dapat dibaca');
  return sheets;
}

function normalisePath(target: string): string {
  const cleaned = target.replace(/^\/+/, '');
  return cleaned.startsWith('xl/') ? cleaned : `xl/${cleaned}`;
}

function readRelationships(archive: Archive): Record<string, string> {
  const xml = readText(archive, 'xl/_rels/workbook.xml.rels');
  if (!xml) return {};

  const map: Record<string, string> = {};
  for (const element of findAll(parseXml(xml).documentElement, 'Relationship')) {
    const id = element.getAttribute('Id');
    const target = element.getAttribute('Target');
    if (id && target) map[id] = target;
  }
  return map;
}

function readSharedStrings(archive: Archive): string[] {
  const xml = readText(archive, 'xl/sharedStrings.xml');
  if (!xml) return [];

  // A shared string is either a single <t>, or several <r><t> runs that must
  // be concatenated — splitting a styled phrase across runs is common.
  return findAll(parseXml(xml).documentElement, 'si').map((si) =>
    findAll(si, 't')
      .map((t) => t.textContent ?? '')
      .join(''),
  );
}

function readSheetRows(xml: string, sharedStrings: string[]): string[][] {
  const sheet = parseXml(xml);
  const rows: string[][] = [];

  for (const rowElement of findAll(sheet.documentElement, 'row')) {
    // `r` is 1-indexed and may skip entirely empty rows.
    const rowIndex = Number(rowElement.getAttribute('r') ?? rows.length + 1) - 1;
    const cells: string[] = [];

    for (const cellElement of findAll(rowElement, 'c')) {
      const reference = cellElement.getAttribute('r');
      const columnIndex = reference ? columnToIndex(reference) : cells.length;
      cells[columnIndex] = readCellValue(cellElement, sharedStrings);
    }

    rows[rowIndex] = normaliseRow(cells);
  }

  // Sparse arrays would surface as holes downstream; fill them in.
  return trimTrailingEmpty(
    Array.from({ length: rows.length }, (_, index) => rows[index] ?? []),
  );
}

function readCellValue(cell: Element, sharedStrings: string[]): string {
  const type = cell.getAttribute('t');

  if (type === 'inlineStr') {
    return findAll(cell, 't')
      .map((t) => t.textContent ?? '')
      .join('');
  }

  const value = findAll(cell, 'v')[0]?.textContent ?? '';
  if (value === '') return '';

  switch (type) {
    case 's': {
      const index = Number(value);
      return sharedStrings[index] ?? '';
    }
    case 'b':
      return value === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return value; // formula error, e.g. #DIV/0!
    default:
      return value;
  }
}

function normaliseRow(cells: string[]): string[] {
  const filled = Array.from({ length: cells.length }, (_, index) => cells[index] ?? '');
  return trimTrailingEmptyCells(filled);
}

function trimTrailingEmptyCells(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end--;
  return cells.slice(0, end);
}

function trimTrailingEmpty(rows: string[][]): string[][] {
  let end = rows.length;
  while (end > 0 && rows[end - 1].length === 0) end--;
  return rows.slice(0, end);
}

/* ==========================================================================
   Writing
   ========================================================================== */

/**
 * Emits a minimal but fully valid .xlsx.
 *
 * Values are written as `inlineStr`, which removes the need for a shared-string
 * table entirely. Numeric-looking cells are written as numbers so Excel treats
 * them as such rather than showing the green "stored as text" warning.
 */
export function writeWorkbook(sheets: Sheet[]): Blob {
  const safeSheets = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];

  const files: Record<string, string> = {
    '[Content_Types].xml': contentTypes(safeSheets.length),
    '_rels/.rels': rootRels(),
    'xl/workbook.xml': workbookXml(safeSheets),
    'xl/_rels/workbook.xml.rels': workbookRels(safeSheets.length),
  };

  safeSheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(sheet.rows);
  });

  return buildArchive(files);
}

function contentTypes(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets}</Types>`;
}

function rootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function workbookRels(sheetCount: number): string {
  const relations = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations}</Relationships>`;
}

function workbookXml(sheets: Sheet[]): string {
  const entries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheetName(sheet.name, index))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${entries}</sheets></workbook>`;
}

/** Excel rejects sheet names over 31 chars or containing : \ / ? * [ ] */
function sheetName(name: string, index: number): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((cells, rowIndex) => {
      const row = rowIndex + 1;
      const content = cells
        .map((value, columnIndex) => {
          if (value === '') return '';
          const reference = `${indexToColumn(columnIndex)}${row}`;

          if (NUMERIC.test(value)) {
            return `<c r="${reference}"><v>${value}</v></c>`;
          }

          // xml:space="preserve" keeps leading and trailing spaces, which
          // otherwise get silently stripped.
          return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join('');

      return `<row r="${row}">${content}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}
