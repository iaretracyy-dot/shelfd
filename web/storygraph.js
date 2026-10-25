// Reads a StoryGraph library export (CSV, or the same sheet saved as .xlsx)
// and turns each row into a Shelfd book plus its diary entries.
//
// StoryGraph columns used: Title, Authors, ISBN/UID, Format, Read Status,
// Date Added, Last Date Read, Dates Read, Read Count, Star Rating, Review, Tags.
// Headers are matched loosely, so small renames in future exports still work.

const SHEETJS_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs';

export async function readSpreadsheet(file) {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await import(SHEETJS_URL);
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }).filter((r) => r.some((v) => String(v).trim()));
  }
  return parseCSV(await file.text());
}

// RFC 4180 CSV: quoted fields, "" escapes, newlines inside quotes, optional BOM.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim()));
}

const COLUMNS = {
  title: ['title'],
  authors: ['authors', 'author'],
  isbn: ['isbn/uid', 'isbn', 'isbn13', 'uid'],
  format: ['format'],
  status: ['read status', 'status'],
  added: ['date added'],
  lastRead: ['last date read'],
  datesRead: ['dates read'],
  readCount: ['read count'],
  rating: ['star rating', 'rating'],
  review: ['review'],
  tags: ['tags'],
};

const STATUS = {
  read: 'read',
  'currently-reading': 'reading',
  'currently reading': 'reading',
  paused: 'reading',
  'to-read': 'want',
  'to read': 'want',
  'did-not-finish': 'dnf',
  'did not finish': 'dnf',
};

// Returns { books: [...], skipped: n } or throws if this isn't a StoryGraph export.
export function parseStoryGraph(rows) {
  const header = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.title < 0 || col.authors < 0) {
    throw new Error("This doesn't look like a StoryGraph export: it needs at least “Title” and “Authors” columns.");
  }
  const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');

  const books = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const title = get(r, 'title');
    if (!title) {
      skipped++;
      continue;
    }
    const isbn = get(r, 'isbn').replace(/[-\s]/g, '');
    const status = STATUS[get(r, 'status').toLowerCase()] || (get(r, 'datesRead') || get(r, 'lastRead') ? 'read' : 'want');
    const book = {
      source: 'storygraph',
      title,
      authors: splitList(get(r, 'authors')),
      isbn13: /^97[89]\d{10}$/.test(isbn) ? isbn : '',
      isbn10: /^\d{9}[\dX]$/i.test(isbn) ? isbn.toUpperCase() : '',
      format: get(r, 'format'),
      shelf: status,
      addedAt: toISODate(get(r, 'added')),
    };
    book.coverUrl = book.isbn13 || book.isbn10 ? `https://covers.openlibrary.org/b/isbn/${book.isbn13 || book.isbn10}-L.jpg?default=false` : '';

    const reads = status === 'read' ? readDates(get(r, 'datesRead'), get(r, 'lastRead'), get(r, 'added')) : [];
    const rating = Math.round(Number(get(r, 'rating')) * 2) / 2 || 0; // StoryGraph allows quarter stars
    const formats = formatsFrom(book.format);
    const tags = splitList(get(r, 'tags'));
    book.logs = reads.map((date, i) => ({
      date,
      reread: i > 0,
      formats,
      tags,
      // The rating and review belong to the most recent read.
      rating: i === reads.length - 1 ? rating : 0,
      review: i === reads.length - 1 ? stripHTML(get(r, 'review')) : '',
    }));
    books.push(book);
  }
  return { books, skipped };
}

function splitList(s) {
  return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

function formatsFrom(f) {
  const v = f.toLowerCase();
  if (/audio/.test(v)) return ['audio'];
  if (/digital|e-?book|kindle/.test(v)) return ['ebook'];
  if (/paper|hard|print/.test(v)) return ['physical'];
  return [];
}

// "2023/01/05-2023/01/20, 2024/06/01-2024/06/09" -> ['2023-01-20', '2024-06-09'] (finish dates).
// Falls back to Last Date Read, then Date Added, so every read book gets one entry.
function readDates(datesRead, lastRead, added) {
  const finishes = datesRead
    .split(/[,;]/)
    .map((range) => {
      const found = range.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}/g);
      return found ? toISODate(found[found.length - 1]) : '';
    })
    .filter(Boolean);
  if (finishes.length) return [...new Set(finishes)].sort();
  const fallback = toISODate(lastRead) || toISODate(added);
  return fallback ? [fallback] : [];
}

// Accepts 2023/01/20, 2023-1-20, 01/20/2023 or an ISO timestamp; returns YYYY-MM-DD or ''.
export function toISODate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
}

function stripHTML(s) {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
