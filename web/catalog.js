// Book catalog: Open Library (primary, no key needed) with Google Books as a
// fallback search source and a gap-filler for page counts / publishers.

import { resolvePublisher } from './imprints.js';

const OL = 'https://openlibrary.org';
const GB = 'https://www.googleapis.com/books/v1';

let googleKey = '';
export function setGoogleKey(key) {
  googleKey = (key || '').trim();
}

async function getJSON(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status });
  return res.json();
}

const gbURL = (path) => `${GB}${path}${googleKey ? `${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(googleKey)}` : ''}`;
const olCover = (id, size = 'L') => (id && id > 0 ? `https://covers.openlibrary.org/b/id/${id}-${size}.jpg` : '');
const lastKey = (key) => String(key || '').split('/').pop();
const isISBN = (q) => /^(97[89])?\d{9}[\dXx]$/.test(q.replace(/[-\s]/g, ''));

// ---------- search ----------

// Returns { results, issues, relaxed }:
//   issues  - catalogs that failed, e.g. [{ source: 'Google Books', reason: 'limit' }]
//   relaxed - the looser query used when the exact one found nothing ('' otherwise)
export async function searchCatalog(query, { signal } = {}) {
  const q = query.trim();
  if (!q) return { results: [], issues: [], relaxed: '' };
  const exact = await runSearch(q, signal);
  if (exact.results.length || isISBN(q)) return { ...exact, relaxed: '' };
  // Catalogs require every word to match, so one stray word ("the", or "hk" for "H. K.") hides the book.
  const relaxed = relaxQuery(q);
  if (!relaxed || relaxed === q.toLowerCase()) return { ...exact, relaxed: '' };
  const loose = await runSearch(relaxed, signal);
  return { results: loose.results, issues: loose.issues.length ? loose.issues : exact.issues, relaxed: loose.results.length ? relaxed : '' };
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'by', 'to', 'in', 'on', 'for']);
export function relaxQuery(q) {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => /^\d+$/.test(w) || (w.length > 2 && !STOPWORDS.has(w)))
    .join(' ');
}

async function runSearch(q, signal) {
  const [ol, gb] = await Promise.allSettled([searchOpenLibrary(q, signal), searchGoogle(q, signal)]);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const results = ol.status === 'fulfilled' ? ol.value : [];
  const seen = new Set(results.map(dedupeKey));
  for (const r of gb.status === 'fulfilled' ? gb.value : []) {
    const k = dedupeKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      results.push(r);
    }
  }
  const issues = [];
  if (ol.status === 'rejected') issues.push({ source: 'Open Library', reason: failureReason(ol.reason) });
  if (gb.status === 'rejected') issues.push({ source: 'Google Books', reason: failureReason(gb.reason) });
  return { results, issues };
}

function failureReason(err) {
  if (err?.status === 429) return 'limit';
  if (googleKey && (err?.status === 400 || err?.status === 403)) return 'key';
  return 'offline';
}

function dedupeKey(r) {
  const title = r.title.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${title}|${(r.authors[0] || '').toLowerCase().replace(/[^a-z]/g, '')}`;
}

async function searchOpenLibrary(q, signal) {
  const fields = 'key,title,subtitle,author_name,first_publish_year,cover_i,cover_edition_key,edition_count';
  const param = isISBN(q) ? `isbn=${encodeURIComponent(q.replace(/[-\s]/g, ''))}` : `q=${encodeURIComponent(q)}`;
  const data = await getJSON(`${OL}/search.json?${param}&limit=20&fields=${fields}`, signal);
  return (data.docs || []).map((d) => ({
    id: `ol:${lastKey(d.key)}`,
    source: 'openlibrary',
    workKey: lastKey(d.key),
    editionKey: d.cover_edition_key || '',
    title: d.title || 'Untitled',
    subtitle: d.subtitle || '',
    authors: d.author_name || [],
    year: d.first_publish_year || '',
    coverUrl: olCover(d.cover_i, 'M'),
    editionCount: d.edition_count || 0,
  }));
}

async function searchGoogle(q, signal) {
  const query = isISBN(q) ? `isbn:${q.replace(/[-\s]/g, '')}` : q;
  const data = await getJSON(gbURL(`/volumes?q=${encodeURIComponent(query)}&maxResults=20&printType=books`), signal);
  return (data.items || []).map((item) => {
    const v = item.volumeInfo || {};
    return {
      id: `gb:${item.id}`,
      source: 'google',
      googleId: item.id,
      title: v.title || 'Untitled',
      subtitle: v.subtitle || '',
      authors: v.authors || [],
      year: (v.publishedDate || '').slice(0, 4),
      coverUrl: gbCover(v.imageLinks),
      editionCount: 1,
    };
  });
}

// ---------- details ----------

// Returns { book, editions } where book is fully populated from the chosen
// edition, and editions lets the user switch to the exact copy they read.
export async function loadBookDetails(result, { signal } = {}) {
  if (result.source === 'google') {
    const item = await getJSON(gbURL(`/volumes/${encodeURIComponent(result.googleId)}`), signal);
    return { book: fromGoogle(item), editions: [] };
  }
  const [work, editionsData] = await Promise.all([
    getJSON(`${OL}/works/${result.workKey}.json`, signal).catch(() => ({})),
    getJSON(`${OL}/works/${result.workKey}/editions.json?limit=100`, signal).catch(() => ({ entries: [] })),
  ]);
  const base = {
    workKey: result.workKey,
    title: result.title,
    authors: result.authors,
    firstPublished: result.year ? String(result.year) : '',
    description: textOf(work.description),
    subjects: (work.subjects || []).slice(0, 8),
  };
  const editions = (editionsData.entries || []).map((e) => fromOpenLibraryEdition(e, base));
  editions.sort((a, b) => editionScore(b) - editionScore(a));
  let book = editions.find((e) => e.editionKey === result.editionKey) || editions[0];
  if (!book) book = { ...base, ...emptyEdition(), source: 'openlibrary', coverUrl: result.coverUrl.replace('-M.', '-L.') };
  book = await fillGaps(book, signal);
  return { book, editions };
}

// Switch edition: re-run gap filling for the newly picked edition.
export async function selectEdition(edition, { signal } = {}) {
  return fillGaps({ ...edition }, signal);
}

// Details for one ISBN (used to enrich imported books): Open Library edition,
// with Google Books filling whatever is missing. Returns null when neither knows it.
export async function lookupISBN(isbn, { signal } = {}) {
  const key = isbn.length === 13 ? 'isbn13' : 'isbn10';
  let book;
  try {
    const e = await getJSON(`${OL}/isbn/${encodeURIComponent(isbn)}.json`, signal);
    book = fromOpenLibraryEdition(e, { workKey: lastKey(e.works?.[0]?.key), title: e.title || '', authors: [], firstPublished: '', description: '', subjects: [] });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    book = { ...emptyEdition(), [key]: isbn, description: '', coverUrl: '' };
  }
  if (!book.isbn13 && !book.isbn10) book[key] = isbn;
  const filled = await fillGaps(book, signal);
  return filled.publisher || filled.pages || filled.editionKey ? filled : null;
}

function emptyEdition() {
  return { editionKey: '', publisher: '', imprint: '', publishers: [], pages: null, isbn13: '', isbn10: '', publishedDate: '', language: '', format: '' };
}

function fromOpenLibraryEdition(e, base) {
  const { publisher, imprint } = resolvePublisher(e.publishers || []);
  return {
    ...base,
    source: 'openlibrary',
    editionKey: lastKey(e.key),
    title: e.title || base.title,
    subtitle: e.subtitle || '',
    publishers: e.publishers || [],
    publisher,
    imprint,
    pages: e.number_of_pages || parsePagination(e.pagination),
    isbn13: (e.isbn_13 || [])[0] || '',
    isbn10: (e.isbn_10 || [])[0] || '',
    publishedDate: e.publish_date || '',
    language: lastKey((e.languages || [])[0]?.key),
    format: e.physical_format || '',
    coverUrl: olCover((e.covers || [])[0]) || '',
  };
}

function parsePagination(p) {
  // "xii, 245 p." -> 245
  const nums = String(p || '').match(/\d+/g);
  return nums ? Math.max(...nums.map(Number)) : null;
}

function editionScore(e) {
  return (e.language === 'eng' ? 4 : e.language ? 0 : 1) + (e.publisher ? 2 : 0) + (e.pages ? 2 : 0) + (e.isbn13 || e.isbn10 ? 2 : 0) + (e.coverUrl ? 1 : 0);
}

function fromGoogle(item) {
  const v = item.volumeInfo || {};
  const ids = Object.fromEntries((v.industryIdentifiers || []).map((i) => [i.type, i.identifier]));
  const { publisher, imprint } = resolvePublisher(v.publisher ? [v.publisher] : []);
  return {
    source: 'google',
    googleId: item.id,
    workKey: '',
    editionKey: '',
    title: v.title || 'Untitled',
    subtitle: v.subtitle || '',
    authors: v.authors || [],
    publishers: v.publisher ? [v.publisher] : [],
    publisher,
    imprint,
    pages: v.pageCount || null,
    isbn13: ids.ISBN_13 || '',
    isbn10: ids.ISBN_10 || '',
    publishedDate: v.publishedDate || '',
    firstPublished: '',
    language: v.language || '',
    format: '',
    description: stripHTML(v.description || ''),
    subjects: (v.categories || []).slice(0, 8),
    coverUrl: gbCover(v.imageLinks, true),
  };
}

// Open Library editions are often missing page counts or publishers; look the
// ISBN up on Google Books and fill whatever is empty.
async function fillGaps(book, signal) {
  const isbn = book.isbn13 || book.isbn10;
  if (!isbn || (book.pages && book.publisher && book.description && book.coverUrl)) return book;
  try {
    const data = await getJSON(gbURL(`/volumes?q=isbn:${isbn}&maxResults=1`), signal);
    if (!data.items?.length) return book;
    const g = fromGoogle(data.items[0]);
    const out = { ...book };
    if (!out.pages) out.pages = g.pages;
    if (!out.publisher) Object.assign(out, { publisher: g.publisher, imprint: g.imprint, publishers: g.publishers });
    if (!out.description) out.description = g.description;
    if (!out.coverUrl) out.coverUrl = g.coverUrl;
    if (!out.publishedDate) out.publishedDate = g.publishedDate;
    return out;
  } catch {
    return book;
  }
}

function gbCover(links, large = false) {
  const url = links && (large ? links.large || links.medium || links.thumbnail : links.thumbnail || links.smallThumbnail);
  return url ? url.replace(/^http:/, 'https:').replace('&edge=curl', '') : '';
}

function textOf(d) {
  return typeof d === 'string' ? d : d?.value || '';
}

function stripHTML(html) {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
