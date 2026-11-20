/** Rows a CSV preview shows; the rest is a download away. */
export const CSV_ROW_CAP = 1000;

export interface CsvTable { rows: string[][]; truncated: boolean }

/**
 * RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes), or TSV when the name ends in
 * .tsv. Stops after `cap` rows so a huge file never builds a huge table.
 */
export function parseCsv(text: string, name = '', cap = CSV_ROW_CAP): CsvTable {
  const sep = /\.tsv$/i.test(name) ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => { row.push(field); field = ''; rows.push(row); row = []; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
      if (rows.length > cap) return { rows: rows.slice(0, cap), truncated: true };
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}
