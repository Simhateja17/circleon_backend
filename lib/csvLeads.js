function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(value.trim());
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }
  row.push(value.trim());
  if (row.some(cell => cell !== '')) rows.push(row);
  if (!rows.length) return { headers: [], rows: [] };

  const headers = rows[0].map((header, index) => header || `column_${index + 1}`);
  return {
    headers,
    rows: rows.slice(1).map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']))),
  };
}

function applyMapping(row, mappings) {
  const normalized = {};
  const mappedSources = new Set();
  for (const mapping of mappings || []) {
    if (!mapping?.source || !mapping?.target || mapping.target === 'ignore') continue;
    mappedSources.add(mapping.source);
    const value = row[mapping.source];
    if (value !== undefined && value !== '') normalized[mapping.target] = value;
  }
  normalized.raw_data = {
    csv: row,
    unmapped: Object.fromEntries(Object.entries(row).filter(([key]) => !mappedSources.has(key))),
  };
  return normalized;
}

module.exports = { applyMapping, parseCsv };
