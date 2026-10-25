// Local persistence. The JSON shape here is also what the iOS app exports and
// imports, so a library can move between the two.

const KEY = 'shelfd.v1';
export const SHELVES = { want: 'Want to read', reading: 'Reading', read: 'Read', dnf: 'Did not finish' };
export const FORMATS = { physical: 'Physical', ebook: 'Ebook', audio: 'Audiobook' };

let state = load();
const listeners = new Set();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.books && Array.isArray(s.logs)) return s;
  } catch {}
  return { version: 1, books: {}, logs: [], settings: {} };
}

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
  listeners.forEach((fn) => fn(state));
}

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
  // Same work already shelved under a different edition counts as "in library".
  return Object.values(state.books).find((b) => book.workKey && b.workKey === book.workKey) || null;
}

const BOOK_FIELDS = ['source', 'workKey', 'editionKey', 'googleId', 'title', 'subtitle', 'authors', 'publisher', 'imprint', 'pages', 'isbn13', 'isbn10', 'publishedDate', 'firstPublished', 'language', 'format', 'description', 'subjects', 'coverUrl'];

export function saveBook(book, patch = {}) {
  const id = book.id || bookId(book);
  const existing = state.books[id];
  const data = Object.fromEntries(BOOK_FIELDS.map((f) => [f, book[f] ?? existing?.[f] ?? '']));
  state.books[id] = { ...existing, ...data, ...patch, id, addedAt: existing?.addedAt || new Date().toISOString() };
  commit();
  return state.books[id];
}

export function updateBook(id, patch) {
  if (!state.books[id]) return;
  state.books[id] = { ...state.books[id], ...patch };
  commit();
}

export function removeBook(id) {
  delete state.books[id];
  state.logs = state.logs.filter((l) => l.bookId !== id);
  commit();
}

export function saveLog(log) {
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
  const key = (b) => `${String(b.title).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}|${String(b.authors?.[0] || '').toLowerCase().replace(/[^\p{L}]/gu, '')}`;
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

export function deleteLog(id) {
  state.logs = state.logs.filter((l) => l.id !== id);
  commit();
}

export function latestRating(bookId) {
  return logsFor(bookId).find((l) => l.rating)?.rating || 0;
}

export function setSetting(key, value) {
  state.settings = { ...state.settings, [key]: value };
  commit();
}

export function exportJSON() {
  const { settings, ...data } = state;
  return JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2);
}

export function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.books !== 'object' || !Array.isArray(data.logs)) throw new Error('Not a Shelfd export file.');
  const ids = new Set(state.logs.map((l) => l.id));
  state.books = { ...state.books, ...data.books };
  state.logs = [...state.logs, ...data.logs.filter((l) => !ids.has(l.id))];
  commit();
  return { books: Object.keys(data.books).length, logs: data.logs.length };
}
