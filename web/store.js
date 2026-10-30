// Local persistence in the browser. Export / import uses this same JSON shape.

const KEY = 'shelfd.v1';
export const SHELVES = { want: 'Want to read', read: 'Read', dnf: 'Did not finish' };
export const FORMATS = { physical: 'Physical', ebook: 'Ebook', audio: 'Audiobook' };

let state = load();
const listeners = new Set();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.books && Array.isArray(s.logs)) return normalizeShelves(s);
  } catch {}
  return { version: 1, books: {}, logs: [], settings: {} };
}

const todayISO = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local

// Status changes go through here so we remember when a book was marked Did
// not finish (Stats places DNF books in a year/month by that date).
function setShelf(book, shelf) {
  if (shelf === 'dnf' && book.shelf !== 'dnf') book.dnfAt = todayISO();
  book.shelf = shelf;
}

// The old "Reading" status (or anything unknown) becomes Want to read.
function normalizeShelves(s) {
  for (const b of Object.values(s.books)) if (!SHELVES[b.shelf]) b.shelf = 'want';
  return s;
}

// Several tabs can have Shelfd open at once. Every change first re-reads the
// saved library (sync) and then writes it back, so one tab never overwrites
// what another tab saved. Other tabs hear about it through the storage event.
function sync() {
  state = load();
}

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
  listeners.forEach((fn) => fn(state, { external: false }));
}

window.addEventListener('storage', (e) => {
  if (e.key !== KEY && e.key !== null) return;
  sync();
  listeners.forEach((fn) => fn(state, { external: true }));
});

export const subscribe = (fn) => listeners.add(fn);
export const getState = () => state;
export const getBook = (id) => state.books[id];
export const logsFor = (bookId) => state.logs.filter((l) => l.bookId === bookId).sort(byDateDesc);
export const allLogs = () => [...state.logs].sort(byDateDesc);

function byDateDesc(a, b) {
  return b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);
}

export function bookId(book) {
  if (book.editionKey) return `ol:${book.editionKey}`;
  if (book.googleId) return `gb:${book.googleId}`;
  if (book.workKey) return `ol:${book.workKey}`;
  return `local:${crypto.randomUUID()}`;
}

export function findInLibrary(book) {
  const id = bookId(book);
  if (state.books[id]) return state.books[id];
  const all = Object.values(state.books);
  // Same work under a different edition counts as "in library"; so does the same
  // title + first author (imported or hand-added books have no catalog keys).
  return all.find((b) => book.workKey && b.workKey === book.workKey) || all.find((b) => titleAuthorKey(b) === titleAuthorKey(book)) || null;
}

function titleAuthorKey(b) {
  return `${String(b.title || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}|${String(b.authors?.[0] || '').toLowerCase().replace(/[^\p{L}]/gu, '')}`;
}

const BOOK_FIELDS = ['source', 'workKey', 'editionKey', 'googleId', 'title', 'subtitle', 'authors', 'publisher', 'imprint', 'pages', 'isbn13', 'isbn10', 'publishedDate', 'firstPublished', 'language', 'format', 'description', 'subjects', 'coverUrl'];

export function saveBook(book, patch = {}) {
  sync();
  const id = book.id || bookId(book);
  const existing = state.books[id];
  const data = Object.fromEntries(BOOK_FIELDS.map((f) => [f, book[f] ?? existing?.[f] ?? '']));
  const { shelf, ...rest } = patch;
  state.books[id] = { ...existing, ...data, ...rest, id, addedAt: existing?.addedAt || new Date().toISOString() };
  if (shelf) setShelf(state.books[id], shelf);
  commit();
  return state.books[id];
}

export function updateBook(id, patch) {
  sync();
  if (!state.books[id]) return;
  const { shelf, ...rest } = patch;
  state.books[id] = { ...state.books[id], ...rest };
  if (shelf) setShelf(state.books[id], shelf);
  commit();
}

export function removeBook(id) {
  sync();
  delete state.books[id];
  state.logs = state.logs.filter((l) => l.bookId !== id);
  commit();
}

export function saveLog(log) {
  sync();
  const entry = {
    id: log.id || crypto.randomUUID(),
    bookId: log.bookId,
    date: log.date,
    rating: Number(log.rating) || 0,
    liked: !!log.liked,
    reread: !!log.reread,
    formats: Object.keys(FORMATS).filter((f) => (log.formats || []).includes(f)),
    knitted: !!log.knitted,
    tags: cleanTags(log.tags),
    review: (log.review || '').trim(),
    createdAt: log.createdAt || new Date().toISOString(),
  };
  const i = state.logs.findIndex((l) => l.id === entry.id);
  if (i >= 0) state.logs[i] = entry;
  else state.logs.push(entry);
  if (state.books[entry.bookId]) state.books[entry.bookId].shelf = 'read';
  commit();
  return entry;
}

export function cleanTags(tags) {
  const out = [];
  for (const raw of tags || []) {
    const tag = String(raw).trim().replace(/\s+/g, ' ').slice(0, 40);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

// Every tag used so far, most used first. Tags match case-insensitively.
export function allTags() {
  const counts = new Map();
  for (const l of state.logs) {
    for (const t of l.tags || []) {
      const key = t.toLowerCase();
      const hit = counts.get(key) || { tag: t, n: 0 };
      hit.n++;
      counts.set(key, hit);
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map((h) => h.tag);
}

// Bulk import (StoryGraph). Books already in the library are matched by ISBN,
// or by title + first author, and only have empty fields filled in. Entries
// are skipped when that book already has one on the same date, so importing
// the same file twice changes nothing.
export function importLibrary(incoming) {
  sync();
  const key = titleAuthorKey;
  const existing = Object.values(state.books);
  const result = { added: 0, matched: 0, entries: 0, ids: [] };
  for (const { logs = [], shelf, addedAt, ...book } of incoming) {
    const isbn = book.isbn13 || book.isbn10;
    let target = existing.find((b) => (isbn && (b.isbn13 === isbn || b.isbn10 === isbn)) || key(b) === key(book));
    if (target) {
      result.matched++;
      for (const f of BOOK_FIELDS) if (!target[f] && book[f]) target[f] = book[f];
    } else {
      const id = isbn ? `isbn:${isbn}` : `sg:${key(book)}`;
      target = { ...Object.fromEntries(BOOK_FIELDS.map((f) => [f, book[f] ?? ''])), id, shelf, addedAt: addedAt ? `${addedAt}T00:00:00.000Z` : new Date().toISOString() };
      if (book.dnfAt) target.dnfAt = book.dnfAt;
      state.books[id] = target;
      existing.push(target);
      result.added++;
    }
    result.ids.push(target.id);
    for (const log of logs) {
      if (state.logs.some((l) => l.bookId === target.id && l.date === log.date)) continue;
      state.logs.push({
        id: `sg:${target.id}:${log.date}`,
        bookId: target.id,
        date: log.date,
        rating: log.rating || 0,
        liked: false,
        reread: !!log.reread,
        formats: log.formats || [],
        knitted: false,
        tags: cleanTags(log.tags),
        review: log.review || '',
        createdAt: new Date().toISOString(),
      });
      result.entries++;
    }
  }
  commit();
  return result;
}

// Library (Want to read) bulk edit. Each change is optional:
//   shelf   - new status for every book
//   date    - "finished on": logs a new read on this date (a reread if the book
//             was read before) and moves the book to Read
//   formats - set on that new read, or on each book's most recent read
export function bulkUpdate(ids, { shelf, date, formats }) {
  sync();
  const r = { books: 0, created: 0, formatted: 0, noRead: 0 };
  const cleanFormats = formats && Object.keys(FORMATS).filter((f) => formats.includes(f));
  for (const id of ids) {
    const book = state.books[id];
    if (!book) continue;
    r.books++;
    let latest = logsFor(id)[0];
    if (date) {
      latest = { id: crypto.randomUUID(), bookId: id, date, rating: 0, liked: false, reread: !!latest, formats: [], knitted: false, tags: [], review: '', createdAt: new Date().toISOString() };
      state.logs.push(latest);
      book.shelf = 'read';
      r.created++;
    }
    if (cleanFormats) {
      if (latest) {
        latest.formats = cleanFormats;
        r.formatted++;
      } else r.noRead++;
    }
    if (shelf) setShelf(book, shelf);
  }
  commit();
  return r;
}

// Diary bulk edit: the same optional changes, applied to individual entries.
//   date / formats - set on every selected entry
//   shelf          - moves the books those entries belong to
export function bulkUpdateLogs(logIds, { shelf, date, formats }) {
  sync();
  const wanted = new Set(logIds);
  const cleanFormats = formats && Object.keys(FORMATS).filter((f) => formats.includes(f));
  const bookIds = new Set();
  let entries = 0;
  for (const log of state.logs) {
    if (!wanted.has(log.id)) continue;
    entries++;
    bookIds.add(log.bookId);
    if (date) log.date = date;
    if (cleanFormats) log.formats = cleanFormats;
  }
  if (shelf) for (const id of bookIds) if (state.books[id]) setShelf(state.books[id], shelf);
  commit();
  return { entries, books: bookIds.size };
}

// Whole-library snapshot for undo.
export const snapshot = () => JSON.stringify({ books: state.books, logs: state.logs });
export function restore(saved) {
  const { books, logs } = JSON.parse(saved);
  state.books = books;
  state.logs = logs;
  commit();
}

export function deleteLog(id) {
  sync();
  state.logs = state.logs.filter((l) => l.id !== id);
  commit();
}

export function latestRating(bookId) {
  return logsFor(bookId).find((l) => l.rating)?.rating || 0;
}

export function setSetting(key, value) {
  sync();
  state.settings = { ...state.settings, [key]: value };
  commit();
}

export function exportJSON() {
  const { settings, ...data } = state;
  return JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2);
}

export function importJSON(text) {
  sync();
  const data = JSON.parse(text);
  if (!data || typeof data.books !== 'object' || !Array.isArray(data.logs)) throw new Error('Not a Shelfd export file.');
  const ids = new Set(state.logs.map((l) => l.id));
  state.books = { ...state.books, ...data.books };
  state.logs = [...state.logs, ...data.logs.filter((l) => !ids.has(l.id))];
  normalizeShelves(state);
  commit();
  return { books: Object.keys(data.books).length, logs: data.logs.length };
}
