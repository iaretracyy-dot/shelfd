import { initImprints } from './imprints.js';
import { searchCatalog, loadBookDetails, selectEdition, setGoogleKey } from './catalog.js';
import * as store from './store.js';

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const authorsText = (a) => (a?.length ? a.join(', ') : 'Unknown author');

function starsText(rating) {
  if (!rating) return '';
  return '★'.repeat(Math.floor(rating)) + (rating % 1 ? '½' : '');
}

const FORMAT_ICONS = { physical: '📖', ebook: '📱', audio: '🎧' };
function formatIcons(formats) {
  if (!formats?.length) return '';
  const label = formats.map((f) => store.FORMATS[f]).join(', ');
  return `<span class="format-icons" title="${esc(label)}" aria-label="${esc(label)}">${formats.map((f) => FORMAT_ICONS[f]).join(' ')}</span>`;
}

// Best guess for a first log: the catalog's format field ("Paperback", "Kindle Edition", "Audio CD").
function guessFormats(book) {
  const f = String(book.format || '').toLowerCase();
  if (/audio/.test(f)) return ['audio'];
  if (/e-?book|kindle|electronic|epub|digital/.test(f)) return ['ebook'];
  if (/paper|hard|cloth|mass market|print|board/.test(f)) return ['physical'];
  return [];
}

function cover(book, size = '') {
  const cls = `cover ${size}`;
  if (book.coverUrl) return `<div class="${cls}"><img src="${esc(book.coverUrl)}" alt="" loading="lazy" onerror="this.remove()"></div>`;
  return `<div class="${cls}">${esc(book.title)}</div>`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { parts: (path || '/').split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) };
}

// ---------- router ----------

const routes = { '': home, search, preview, book: bookPage, diary, library, stats };
let currentAbort = null;

function render() {
  currentAbort?.abort();
  currentAbort = new AbortController();
  const { parts, params } = parseHash();
  const view = routes[parts[0] || ''] || home;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (parts[0] || 'home')));
  view(parts.slice(1), params, currentAbort.signal);
  window.scrollTo(0, 0);
}

// ---------- home ----------

function home() {
  const { books } = store.getState();
  const reading = Object.values(books).filter((b) => b.shelf === 'reading');
  const recent = store.allLogs().slice(0, 12);
  const year = String(new Date().getFullYear());
  const thisYear = store.allLogs().filter((l) => l.date.startsWith(year));
  const pages = thisYear.reduce((n, l) => n + (Number(books[l.bookId]?.pages) || 0), 0);

  app.innerHTML = `
    <h1>Welcome back.</h1>
    <p class="muted">Here's what you've been reading.</p>
    <form class="search-big" id="home-search">
      <input name="q" type="search" placeholder="What did you read? Search by title, author or ISBN" autofocus>
      <button class="btn primary">Search</button>
    </form>
    <div class="tile-row">
      <div class="tile"><b>${thisYear.length}</b><span class="muted">books read in ${year}</span></div>
      <div class="tile"><b>${pages.toLocaleString()}</b><span class="muted">pages in ${year}</span></div>
      <div class="tile"><b>${reading.length}</b><span class="muted">currently reading</span></div>
      <div class="tile"><b>${Object.values(books).filter((b) => b.shelf === 'want').length}</b><span class="muted">want to read</span></div>
    </div>
    ${reading.length ? `<h2 class="section-title">Currently reading</h2>${posterGrid(reading)}` : ''}
    <h2 class="section-title"><span>Recently logged</span><a href="#/diary">Diary</a></h2>
    ${recent.length ? posterGrid(recent.map((l) => ({ ...books[l.bookId], log: l })).filter((b) => b.id)) : `<div class="empty">Nothing logged yet. Search for a book you've read to start your diary.</div>`}
  `;
  $('#home-search').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/search?q=${encodeURIComponent(e.target.q.value)}`;
  });
}

function posterGrid(books) {
  return `<div class="poster-row">${books
    .map((b) => {
      const rating = b.log ? b.log.rating : store.latestRating(b.id);
      const liked = b.log ? b.log.liked : false;
      return `<a class="poster" href="#/book/${encodeURIComponent(b.id)}" title="${esc(b.title)} — ${esc(authorsText(b.authors))}">
        ${cover(b)}
        <span class="under"><span class="stars">${starsText(rating)}</span>${liked ? '<span class="heart">♥</span>' : ''}</span>
      </a>`;
    })
    .join('')}</div>`;
}

// ---------- search ----------

const resultCache = new Map();

async function search(_, params, signal) {
  const q = params.get('q') || '';
  app.innerHTML = `
    <form class="search-big" id="search-form">
      <input name="q" type="search" value="${esc(q)}" placeholder="Search by title, author or ISBN" autofocus>
      <button class="btn primary">Search</button>
    </form>
    <div id="results">${q ? '<div class="spinner"></div>' : '<div class="empty">Type a title, author or ISBN and pick the book you read.</div>'}</div>`;
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/search?q=${encodeURIComponent(e.target.q.value.trim())}`;
  });
  $('.quick-search input').value = q;
  if (!q) return;

  try {
    const results = await searchCatalog(q, { signal });
    if (signal.aborted) return;
    results.forEach((r) => resultCache.set(r.id, r));
    $('#results').innerHTML = results.length
      ? `<p class="muted">${results.length} results for “${esc(q)}”. Select the book you read.</p>
         <ul class="results">${results.map(resultRow).join('')}</ul>`
      : `<div class="empty">No books found for “${esc(q)}”. Try fewer words or search by ISBN.</div>`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('#results').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function resultRow(r) {
  const owned = store.findInLibrary(r);
  return `<li><a class="result" href="#/preview/${encodeURIComponent(r.id)}">
    ${cover(r, 'sm')}
    <div>
      <h3>${esc(r.title)}${r.year ? ` <span class="muted">${esc(r.year)}</span>` : ''}</h3>
      <div class="meta">${esc(authorsText(r.authors))}</div>
      <div class="meta">${r.editionCount > 1 ? `${r.editionCount} editions · ` : ''}<span class="badge">${r.source === 'google' ? 'Google Books' : 'Open Library'}</span>
        ${owned ? `<span class="badge green">${esc(store.SHELVES[owned.shelf] || 'In library')}</span>` : ''}</div>
    </div></a></li>`;
}

// ---------- preview (selected catalog result -> autofilled details) ----------

async function preview([id], _, signal) {
  const result = resultCache.get(id) || resultFromId(id);
  if (!result) return home();
  app.innerHTML = '<div class="spinner"></div>';
  try {
    const { book, editions } = await loadBookDetails(result, { signal });
    if (signal.aborted) return;
    renderPreview({ book, editions, editing: false }, signal);
  } catch (err) {
    if (err.name !== 'AbortError') app.innerHTML = `<div class="empty">Couldn't load this book: ${esc(err.message)}</div>`;
  }
}

function resultFromId(id) {
  const [src, key] = id.split(':');
  if (src === 'ol') return { id, source: 'openlibrary', workKey: key, editionKey: '', title: '', authors: [], year: '', coverUrl: '' };
  if (src === 'gb') return { id, source: 'google', googleId: key };
  return null;
}

const DETAIL_FIELDS = [
  ['authors', 'Author'],
  ['publisher', 'Publisher'],
  ['imprint', 'Imprint'],
  ['pages', 'Pages'],
  ['publishedDate', 'Published'],
  ['firstPublished', 'First published'],
  ['isbn13', 'ISBN-13'],
  ['isbn10', 'ISBN-10'],
  ['format', 'Format'],
  ['language', 'Language'],
];

function detailsList(book, editing) {
  return `<dl class="details">${DETAIL_FIELDS.map(([key, label]) => {
    const raw = key === 'authors' ? (book.authors || []).join(', ') : book[key];
    if (!editing && !raw && key !== 'imprint' && key !== 'pages') return '';
    const value = editing
      ? `<input name="${key}" value="${esc(raw)}" ${key === 'pages' ? 'inputmode="numeric"' : ''}>`
      : esc(raw || '—');
    return `<dt>${label}</dt><dd>${value}</dd>`;
  }).join('')}</dl>`;
}

function readEdits(form, book) {
  const out = { ...book };
  for (const [key] of DETAIL_FIELDS) {
    const el = form.elements[key];
    if (!el) continue;
    const v = el.value.trim();
    out[key] = key === 'authors' ? v.split(',').map((s) => s.trim()).filter(Boolean) : key === 'pages' ? Number(v) || null : v;
  }
  return out;
}

function renderPreview(state, signal) {
  const { book, editions, editing } = state;
  const owned = store.findInLibrary(book);
  const editionOptions = editions.length > 1
    ? `<label class="edition-picker">Edition — pick the copy you read for the right publisher and page count
        <select id="edition-select">${editions.map((e, i) => `<option value="${i}" ${e.editionKey === book.editionKey ? 'selected' : ''}>
          ${esc([e.imprint || e.publisher || e.publishers?.[0] || 'Unknown publisher', e.publishedDate, e.pages ? `${e.pages} pp` : '', e.format].filter(Boolean).join(' · '))}
        </option>`).join('')}</select></label>`
    : '';

  app.innerHTML = `
    <form class="book" id="preview-form">
      <div>${cover(book, 'lg')}
        <div class="actions-panel">
          <button type="button" class="btn primary" data-act="log">＋ Log this book</button>
          <div class="shelf-buttons">
            <button type="button" class="btn small" data-shelf="reading">Reading</button>
            <button type="button" class="btn small" data-shelf="want">Want to read</button>
          </div>
          ${owned ? `<a class="btn small ghost" href="#/book/${encodeURIComponent(owned.id)}">In your library: ${esc(store.SHELVES[owned.shelf] || '')} →</a>` : ''}
        </div>
      </div>
      <div>
        <h1 class="book-title">${esc(book.title)}</h1>
        ${book.subtitle ? `<p class="book-sub">${esc(book.subtitle)}</p>` : ''}
        <div class="byline">by ${(book.authors || []).map((a) => `<a href="#/search?q=${encodeURIComponent(a)}">${esc(a)}</a>`).join(', ') || 'Unknown author'}</div>
        ${editionOptions}
        ${detailsList(book, editing)}
        <button type="button" class="btn small ghost" data-act="edit">${editing ? 'Done editing' : '✎ Correct details'}</button>
        ${book.description ? `<h2 class="section-title">About</h2><p class="description clamp">${esc(book.description)}</p>` : ''}
      </div>
    </form>`;

  const form = $('#preview-form');
  const current = () => (state.editing ? readEdits(form, state.book) : state.book);

  $('#edition-select')?.addEventListener('change', async (e) => {
    const picked = editions[Number(e.target.value)];
    state.book = await selectEdition({ ...picked, authors: book.authors, description: picked.description || book.description }, { signal });
    if (!signal.aborted) renderPreview(state, signal);
  });
  form.querySelector('[data-act="edit"]').addEventListener('click', () => {
    if (state.editing) state.book = readEdits(form, state.book);
    state.editing = !state.editing;
    renderPreview(state, signal);
  });
  form.querySelectorAll('[data-shelf]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const saved = store.saveBook(current(), { shelf: btn.dataset.shelf });
      toast(`Added to ${store.SHELVES[btn.dataset.shelf]}`);
      location.hash = `#/book/${encodeURIComponent(saved.id)}`;
    }),
  );
  form.querySelector('[data-act="log"]').addEventListener('click', () => {
    const draft = current();
    openLogDialog(draft, null, () => store.saveBook(draft, { shelf: 'read' }));
  });
}

// ---------- library book page ----------

function bookPage([id]) {
  const book = store.getBook(id);
  if (!book) {
    app.innerHTML = `<div class="empty">This book isn't in your library.</div>`;
    return;
  }
  const logs = store.logsFor(id);
  let editing = false;

  const draw = () => {
    app.innerHTML = `
      <form class="book" id="book-form">
        <div>${cover(book, 'lg')}
          <div class="actions-panel">
            <button type="button" class="btn primary" data-act="log">＋ ${logs.length ? 'Log again' : 'Log this book'}</button>
            <div class="shelf-buttons">${Object.entries(store.SHELVES)
              .map(([k, label]) => `<button type="button" class="btn small" data-shelf="${k}" aria-pressed="${book.shelf === k}">${label}</button>`)
              .join('')}</div>
            <button type="button" class="btn small ghost danger" data-act="remove">Remove from library</button>
          </div>
        </div>
        <div>
          <h1 class="book-title">${esc(book.title)}</h1>
          ${book.subtitle ? `<p class="book-sub">${esc(book.subtitle)}</p>` : ''}
          <div class="byline">by ${(book.authors || []).map((a) => `<a href="#/search?q=${encodeURIComponent(a)}">${esc(a)}</a>`).join(', ') || 'Unknown author'}</div>
          ${detailsList(book, editing)}
          <button type="button" class="btn small ghost" data-act="edit">${editing ? 'Save details' : '✎ Edit details'}</button>
          <h2 class="section-title">Your reads</h2>
          ${logs.length ? `<ul class="log-list">${logs.map(logItem).join('')}</ul>` : '<p class="muted">Not logged yet.</p>'}
          ${book.description ? `<h2 class="section-title">About</h2><p class="description clamp">${esc(book.description)}</p>` : ''}
        </div>
      </form>`;

    const form = $('#book-form');
    form.querySelector('[data-act="log"]').addEventListener('click', () => openLogDialog(book, null));
    form.querySelector('[data-act="edit"]').addEventListener('click', () => {
      if (editing) {
        Object.assign(book, readEdits(form, book));
        store.updateBook(id, book);
        toast('Details saved');
      }
      editing = !editing;
      draw();
    });
    form.querySelectorAll('[data-shelf]').forEach((btn) =>
      btn.addEventListener('click', () => {
        book.shelf = btn.dataset.shelf;
        store.updateBook(id, { shelf: book.shelf });
        draw();
      }),
    );
    form.querySelector('[data-act="remove"]').addEventListener('click', () => {
      if (!confirm(`Remove “${book.title}” and its diary entries?`)) return;
      store.removeBook(id);
      location.hash = '#/library';
    });
    form.querySelectorAll('[data-log]').forEach((el) =>
      el.addEventListener('click', () => openLogDialog(book, logs.find((l) => l.id === el.dataset.log))),
    );
  };
  draw();
}

function logItem(l) {
  return `<li>
    <div><b>${new Date(l.date + 'T00:00').toLocaleDateString(undefined, { dateStyle: 'medium' })}</b>
      <span class="stars">${starsText(l.rating)}</span> ${l.liked ? '<span class="heart">♥</span>' : ''} ${l.reread ? '<span class="muted" title="Reread">↻</span>' : ''} ${formatIcons(l.formats)}
      <button type="button" class="btn small ghost" data-log="${esc(l.id)}">Edit</button></div>
    ${l.review ? `<p>${esc(l.review)}</p>` : ''}
  </li>`;
}

// ---------- diary ----------

function diary() {
  const { books } = store.getState();
  const logs = store.allLogs().filter((l) => books[l.bookId]);
  if (!logs.length) {
    app.innerHTML = `<h1>Diary</h1><div class="empty">Your diary is empty. <a href="#/search">Log a book</a> to begin.</div>`;
    return;
  }
  const months = new Map();
  for (const l of logs) {
    const key = l.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(l);
  }
  app.innerHTML = `<h1>Diary</h1>${[...months]
    .map(([month, entries]) => `
      <section class="diary-month">
        <h2 class="section-title">${new Date(month + '-01T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
        ${entries.map((l) => {
          const b = books[l.bookId];
          return `<a class="diary-row" href="#/book/${encodeURIComponent(b.id)}">
            <span class="diary-day">${Number(l.date.slice(8, 10))}</span>
            ${cover(b, 'sm')}
            <div><h3>${esc(b.title)}</h3><span class="muted">${esc(authorsText(b.authors))}${b.pages ? ` · ${b.pages} pp` : ''}</span></div>
            <span class="stars">${starsText(l.rating)}</span>
            <span class="icons">${formatIcons(l.formats)}${l.liked ? '<span class="heart">♥</span>' : ''}${l.reread ? '<span title="Reread">↻</span>' : ''}${l.review ? '<span title="Has review">≡</span>' : ''}</span>
          </a>`;
        }).join('')}
      </section>`)
    .join('')}`;
}

// ---------- library ----------

function library(_, params) {
  const shelf = params.get('shelf') || 'all';
  const sort = params.get('sort') || 'added';
  let books = Object.values(store.getState().books);
  if (shelf !== 'all') books = books.filter((b) => b.shelf === shelf);
  const sorters = {
    added: (a, b) => b.addedAt.localeCompare(a.addedAt),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.authors[0] || '').localeCompare(b.authors[0] || ''),
    rating: (a, b) => store.latestRating(b.id) - store.latestRating(a.id),
  };
  books.sort(sorters[sort] || sorters.added);
  const tab = (k, label) => `<a class="btn small" aria-pressed="${shelf === k}" href="#/library?shelf=${k}&sort=${sort}">${label}</a>`;
  app.innerHTML = `
    <h1>Library</h1>
    <div class="tabs">${tab('all', 'All')}${Object.entries(store.SHELVES).map(([k, l]) => tab(k, l)).join('')}
      <span class="spacer"></span>
      <select id="sort" aria-label="Sort" style="width:auto">${Object.keys(sorters).map((k) => `<option value="${k}" ${k === sort ? 'selected' : ''}>Sort: ${k}</option>`).join('')}</select>
    </div>
    ${books.length ? posterGrid(books) : '<div class="empty">No books on this shelf yet.</div>'}`;
  $('#sort').addEventListener('change', (e) => (location.hash = `#/library?shelf=${shelf}&sort=${e.target.value}`));
}

// ---------- stats ----------

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' }));

function stats(_, params) {
  const { books } = store.getState();
  const logs = store.allLogs().filter((l) => books[l.bookId]);
  const years = [...new Set(logs.map((l) => l.date.slice(0, 4)))].sort().reverse();
  const thisYear = String(new Date().getFullYear());
  const year = params.get('year') || (years.includes(thisYear) ? thisYear : years[0]) || thisYear;
  const month = params.get('month') || 'all'; // '01'..'12' or 'all'
  const picked = logs.filter((l) => (year === 'all' || l.date.startsWith(year)) && (month === 'all' || l.date.slice(5, 7) === month));

  const rated = picked.filter((l) => l.rating);
  const pages = picked.reduce((n, l) => n + (Number(books[l.bookId].pages) || 0), 0);
  const dist = Array.from({ length: 10 }, (_, i) => rated.filter((l) => l.rating === (i + 1) / 2).length);
  const tally = (fn) => Object.entries(picked.reduce((m, l) => (fn(l).forEach((k) => k && (m[k] = (m[k] || 0) + 1)), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const bars = (arr) => `<div class="bars">${arr.map((n) => `<div style="height:${(n / Math.max(1, ...arr)) * 100}%" title="${n}"></div>`).join('')}</div>`;
  const top = (rows) => (rows.length ? `<ol>${rows.map(([k, n]) => `<li>${esc(k)} <span class="muted">· ${n}</span></li>`).join('')}</ol>` : '<p class="muted">—</p>');

  // The timeline zooms with the filters: all years -> per year, one year -> per month, one month -> per day.
  let timeline;
  if (month !== 'all') {
    const days = year === 'all' ? 31 : new Date(Number(year), Number(month), 0).getDate();
    const counts = Array.from({ length: days }, (_, d) => picked.filter((l) => Number(l.date.slice(8, 10)) === d + 1).length);
    timeline = { title: 'Books per day', counts, labels: ['1', String(Math.ceil(days / 2)), String(days)] };
  } else if (year === 'all') {
    const span = years.length ? [...years].reverse() : [thisYear];
    timeline = { title: 'Books per year', counts: span.map((y) => picked.filter((l) => l.date.startsWith(y)).length), labels: [span[0], '', span[span.length - 1]] };
  } else {
    timeline = { title: 'Books per month', counts: Array.from({ length: 12 }, (_, m) => picked.filter((l) => Number(l.date.slice(5, 7)) === m + 1).length), labels: ['Jan', 'Jun', 'Dec'] };
  }

  const period = [month === 'all' ? '' : MONTHS[Number(month) - 1] + (year === 'all' ? ',' : ''), year === 'all' ? (month === 'all' ? 'All time' : 'all years') : year].filter(Boolean).join(' ');
  const formatCounts = Object.keys(store.FORMATS).map((f) => [f, picked.filter((l) => l.formats?.includes(f)).length]);

  app.innerHTML = `
    <h1>Stats</h1>
    <form class="filters" id="stats-filters">
      <label>Year
        <select name="year">
          <option value="all" ${year === 'all' ? 'selected' : ''}>All time</option>
          ${(years.includes(thisYear) ? years : [thisYear, ...years]).map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </label>
      <label>Month
        <select name="month">
          <option value="all">All months</option>
          ${MONTHS.map((m, i) => { const v = String(i + 1).padStart(2, '0'); return `<option value="${v}" ${v === month ? 'selected' : ''}>${m}</option>`; }).join('')}
        </select>
      </label>
    </form>
    <p class="muted">${esc(period)} · ${picked.length} ${picked.length === 1 ? 'book' : 'books'}</p>
    ${picked.length ? '' : '<div class="empty">No books logged in this period.</div>'}
    <div class="tile-row">
      <div class="tile"><b>${picked.length}</b><span class="muted">books</span></div>
      <div class="tile"><b>${pages.toLocaleString()}</b><span class="muted">pages</span></div>
      <div class="tile"><b>${rated.length ? (rated.reduce((n, l) => n + l.rating, 0) / rated.length).toFixed(1) : '—'}</b><span class="muted">average rating</span></div>
      <div class="tile"><b>${picked.filter((l) => l.liked).length}</b><span class="muted">liked</span></div>
    </div>
    <h2 class="section-title">How you read</h2>
    <div class="tile-row">${formatCounts.map(([f, n]) => `<div class="tile"><b>${FORMAT_ICONS[f]} ${n}</b><span class="muted">${store.FORMATS[f].toLowerCase()}</span></div>`).join('')}</div>
    <h2 class="section-title">${timeline.title}</h2>${bars(timeline.counts)}<div class="bar-labels">${timeline.labels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>
    <h2 class="section-title">Ratings</h2>${bars(dist)}<div class="bar-labels"><span class="stars">½</span><span class="stars">★★★★★</span></div>
    <div class="tile-row" style="margin-top:2rem">
      <div><h2 class="section-title">Top authors</h2>${top(tally((l) => books[l.bookId].authors || []))}</div>
      <div><h2 class="section-title">Top publishers</h2>${top(tally((l) => [books[l.bookId].publisher]))}</div>
    </div>`;

  $('#stats-filters').addEventListener('change', (e) => {
    const f = e.currentTarget;
    location.hash = `#/stats?year=${f.year.value}&month=${f.month.value}`;
  });
}

// ---------- log dialog ----------

const logDialog = $('#log-dialog');
const logForm = $('#log-form');
const starsInput = $('#stars-input');
let logContext = null;

function paintStars(rating) {
  starsInput.dataset.value = rating;
  starsInput.setAttribute('aria-valuenow', rating);
  starsInput.setAttribute('aria-valuetext', rating ? `${rating} stars` : 'No rating');
  starsInput.innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<span class="star ${rating >= n ? 'full' : rating >= n - 0.5 ? 'half' : ''}" data-n="${n}"><span class="fill"></span></span>`)
    .join('');
}

function ratingFromPointer(e) {
  const star = e.target.closest('.star');
  if (!star) return null;
  const rect = star.getBoundingClientRect();
  return Number(star.dataset.n) - (e.clientX - rect.left < rect.width / 2 ? 0.5 : 0);
}

starsInput.addEventListener('mousemove', (e) => {
  const r = ratingFromPointer(e);
  if (r != null) paintPreview(r);
});
starsInput.addEventListener('mouseleave', () => paintStars(Number(starsInput.dataset.value)));
starsInput.addEventListener('click', (e) => {
  const r = ratingFromPointer(e);
  if (r == null) return;
  paintStars(r === Number(starsInput.dataset.value) ? 0 : r); // click again to clear
});
starsInput.addEventListener('keydown', (e) => {
  const v = Number(starsInput.dataset.value);
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') paintStars(Math.min(5, v + 0.5));
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') paintStars(Math.max(0, v - 0.5));
  else return;
  e.preventDefault();
});
function paintPreview(r) {
  starsInput.querySelectorAll('.star').forEach((s) => {
    const n = Number(s.dataset.n);
    s.className = `star ${r >= n ? 'full' : r >= n - 0.5 ? 'half' : ''}`;
  });
}

// beforeSave lets the preview page add the book to the library only once the log is confirmed.
function openLogDialog(book, log, beforeSave) {
  logContext = { book, log, beforeSave };
  $('#log-title').textContent = book.title;
  $('#log-author').textContent = authorsText(book.authors);
  $('#log-cover').src = book.coverUrl || '';
  $('#log-cover').hidden = !book.coverUrl;
  logForm.date.value = log?.date || today();
  logForm.liked.checked = !!log?.liked;
  logForm.reread.checked = log ? log.reread : store.logsFor(book.id || '').length > 0;
  logForm.review.value = log?.review || '';
  // New entries reuse the formats from this book's last read, else guess from the edition.
  const formats = log ? log.formats || [] : store.logsFor(book.id || '')[0]?.formats || guessFormats(book);
  logForm.querySelectorAll('[name=formats]').forEach((cb) => (cb.checked = formats.includes(cb.value)));
  $('#log-delete').hidden = !log;
  paintStars(log?.rating || 0);
  logDialog.showModal();
}

logDialog.addEventListener('close', () => {
  if (logDialog.returnValue !== 'save' || !logContext) return;
  const { book, log, beforeSave } = logContext;
  const saved = beforeSave ? beforeSave() : book;
  store.saveLog({
    id: log?.id,
    createdAt: log?.createdAt,
    bookId: saved.id,
    date: logForm.date.value || today(),
    rating: Number(starsInput.dataset.value),
    liked: logForm.liked.checked,
    reread: logForm.reread.checked,
    formats: [...logForm.querySelectorAll('[name=formats]:checked')].map((cb) => cb.value),
    review: logForm.review.value,
  });
  logContext = null;
  toast(log ? 'Entry updated' : 'Logged to your diary');
  const target = `#/book/${encodeURIComponent(saved.id)}`;
  if (location.hash === target) render();
  else location.hash = target;
});

$('#log-delete').addEventListener('click', () => {
  if (!logContext?.log || !confirm('Delete this diary entry?')) return;
  store.deleteLog(logContext.log.id);
  logContext = null;
  logDialog.close('cancel');
  render();
});

// ---------- settings ----------

const settingsDialog = $('#settings-dialog');
$('#settings-btn').addEventListener('click', () => {
  settingsDialog.querySelector('[name=googleKey]').value = store.getState().settings.googleKey || '';
  settingsDialog.showModal();
});
settingsDialog.addEventListener('close', () => {
  const key = settingsDialog.querySelector('[name=googleKey]').value.trim();
  store.setSetting('googleKey', key);
  setGoogleKey(key);
});
$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `shelfd-${today()}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { books, logs } = store.importJSON(await file.text());
    toast(`Imported ${books} books and ${logs} entries`);
    settingsDialog.close();
    render();
  } catch (err) {
    alert(err.message);
  }
  e.target.value = '';
});

// ---------- boot ----------

$('#quick-search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});
window.addEventListener('hashchange', render);
setGoogleKey(store.getState().settings.googleKey);
await initImprints();
render();
