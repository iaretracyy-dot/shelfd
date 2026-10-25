import { initImprints, resolvePublisher } from './imprints.js';
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

const knitIcon = (l) => (l.knitted ? '<span title="Knitted while reading" aria-label="Knitted while reading">🧶</span>' : '');
const tagList = (tags) => (tags?.length ? `<span class="tag-list">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : '');

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

const routes = { '': home, search, preview, add: addManually, book: bookPage, diary, library, stats };
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
    const { results, issues, relaxed } = await searchCatalog(q, { signal });
    if (signal.aborted) return;
    results.forEach((r) => resultCache.set(r.id, r));
    const allFailed = issues.length === 2;
    const manual = `<div class="manual-cta">Can't find your book? New releases can take a while to reach the catalogs.
      <a class="btn small" href="#/add">＋ Add it manually</a></div>`;
    $('#results').innerHTML = `
      ${issues.map(issueNotice).join('')}
      ${results.length
        ? `<p class="muted">${relaxed ? `No exact matches for “${esc(q)}”. Showing results for <b>“${esc(relaxed)}”</b>.` : `${results.length} results for “${esc(q)}”.`} Select the book you read.</p>
           <ul class="results">${results.map(resultRow).join('')}</ul>`
        : allFailed
          ? `<div class="empty">Couldn't reach the book catalogs, so this search didn't run. Check your connection and try again.</div>`
          : `<div class="empty">No books found for “${esc(q)}”${issues.length ? ' in the catalog that responded' : ''}. Try fewer words, or search by ISBN.</div>`}
      ${manual}`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('#results').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function issueNotice({ source, reason }) {
  const text = {
    limit: `${source} has hit its free request limit, so results may be missing books (especially new releases).
      <a href="#" data-open-settings>Add a free Google Books API key</a> to get your own limit.`,
    key: `${source} rejected your API key. <a href="#" data-open-settings>Check it in Settings</a>.`,
    offline: `${source} didn't respond, so results may be incomplete. Try again in a moment.`,
  }[reason];
  return `<div class="notice" role="status">⚠ ${text}</div>`;
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

// Fields marked editOnly appear only while editing.
const DETAIL_FIELDS = [
  ['title', 'Title', true],
  ['subtitle', 'Subtitle', true],
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
  ['coverUrl', 'Cover image URL', true],
];

function detailsList(book, editing) {
  return `<dl class="details">${DETAIL_FIELDS.map(([key, label, editOnly]) => {
    if (editOnly && !editing) return '';
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
    if (key === 'title' && !v) continue;
    out[key] = key === 'authors' ? v.split(',').map((s) => s.trim()).filter(Boolean) : key === 'pages' ? Number(v) || null : v;
  }
  return out;
}

// About on the left, book info on the right (stacks on small screens, About first).
function infoColumns(book, editing, editButton) {
  const about = book.description
    ? `<div class="about-col">
        <h2 class="section-title">About</h2>
        <p class="description clamp" id="about-text">${esc(book.description)}</p>
        <button type="button" class="btn small ghost" id="about-toggle" hidden>Show more</button>
      </div>`
    : '';
  return `<div class="info-cols ${about ? '' : 'single'}">${about}<div>${detailsList(book, editing)}${editButton}</div></div>`;
}

// Offer "Show more" only when the description is actually cut off.
function wireAboutToggle() {
  const text = $('#about-text');
  const toggle = $('#about-toggle');
  if (!text || !toggle) return;
  toggle.hidden = text.scrollHeight <= text.clientHeight + 1;
  toggle.addEventListener('click', () => {
    const open = text.classList.toggle('clamp');
    toggle.textContent = open ? 'Show more' : 'Show less';
  });
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
        ${infoColumns(book, editing, `<button type="button" class="btn small ghost" data-act="edit">${editing ? 'Done editing' : '✎ Correct details'}</button>`)}
      </div>
    </form>`;

  wireAboutToggle();
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

// ---------- add a book manually ----------

const MANUAL_FORMATS = ['', 'Hardcover', 'Paperback', 'Mass market paperback', 'Ebook', 'Audiobook'];

function addManually() {
  app.innerHTML = `
    <h1>Add a book</h1>
    <p class="muted">For books the catalogs don't have yet. Only the title and author are required, and you can edit everything later.</p>
    <form class="manual-form" id="manual-form" novalidate>
      <label class="field wide">Title * <input name="title" required autofocus></label>
      <label class="field wide">Subtitle <input name="subtitle"></label>
      <label class="field wide">Author(s) * <input name="authors" required placeholder="Separate several authors with commas"></label>
      <label class="field">Publisher <input name="publisher" placeholder="e.g. Flatiron Books"></label>
      <label class="field">Imprint <input name="imprint"></label>
      <p class="hint wide muted">Enter an imprint like “Flatiron Books” as the publisher and we'll fill in the parent house (Macmillan) for you.</p>
      <label class="field">Pages <input name="pages" inputmode="numeric" pattern="[0-9]*"></label>
      <label class="field">Published <input name="publishedDate" placeholder="e.g. June 9, 2026"></label>
      <label class="field">ISBN-13 <input name="isbn13" inputmode="numeric"></label>
      <label class="field">ISBN-10 <input name="isbn10"></label>
      <label class="field">Format <select name="format">${MANUAL_FORMATS.map((f) => `<option value="${f}">${f || '—'}</option>`).join('')}</select></label>
      <label class="field">Cover image URL <input name="coverUrl" type="url" placeholder="https://…"></label>
      <label class="field wide">Description <textarea name="description" rows="4"></textarea></label>
      <div class="wide manual-actions">
        <button type="button" class="btn primary" data-act="log">＋ Log this book</button>
        <button type="button" class="btn" data-shelf="reading">Reading</button>
        <button type="button" class="btn" data-shelf="want">Want to read</button>
      </div>
    </form>`;

  const form = $('#manual-form');
  // Typing a known imprint into Publisher fills both fields.
  form.publisher.addEventListener('change', () => {
    if (form.imprint.value.trim()) return;
    const { publisher, imprint } = resolvePublisher([form.publisher.value]);
    if (imprint) {
      form.publisher.value = publisher;
      form.imprint.value = imprint;
    }
  });

  const read = () => {
    for (const el of [form.title, form.authors]) el.value = el.value.trim();
    if (!form.reportValidity()) return null;
    const v = (name) => form.elements[name].value.trim();
    return {
      source: 'manual', workKey: '', editionKey: '', googleId: '',
      title: v('title'), subtitle: v('subtitle'),
      authors: v('authors').split(',').map((s) => s.trim()).filter(Boolean),
      publisher: v('publisher'), imprint: v('imprint'), pages: Number(v('pages')) || null,
      publishedDate: v('publishedDate'), firstPublished: '', isbn13: v('isbn13').replace(/[-\s]/g, ''), isbn10: v('isbn10').replace(/[-\s]/g, ''),
      format: v('format'), language: '', coverUrl: v('coverUrl'), description: v('description'), subjects: [],
    };
  };
  form.querySelector('[data-act="log"]').addEventListener('click', () => {
    const book = read();
    if (book) openLogDialog(book, null, () => store.saveBook(book, { shelf: 'read' }));
  });
  form.querySelectorAll('[data-shelf]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const book = read();
      if (!book) return;
      const saved = store.saveBook(book, { shelf: btn.dataset.shelf });
      toast(`Added to ${store.SHELVES[btn.dataset.shelf]}`);
      location.hash = `#/book/${encodeURIComponent(saved.id)}`;
    }),
  );
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
          ${infoColumns(book, editing, `<button type="button" class="btn small ghost" data-act="edit">${editing ? 'Save details' : '✎ Edit details'}</button>`)}
          <h2 class="section-title">Your reads</h2>
          ${logs.length ? `<ul class="log-list">${logs.map(logItem).join('')}</ul>` : '<p class="muted">Not logged yet.</p>'}
        </div>
      </form>`;

    wireAboutToggle();
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
      <span class="stars">${starsText(l.rating)}</span> ${l.liked ? '<span class="heart">♥</span>' : ''} ${l.reread ? '<span class="muted" title="Reread">↻</span>' : ''} ${formatIcons(l.formats)} ${knitIcon(l)}
      <button type="button" class="btn small ghost" data-log="${esc(l.id)}">Edit</button></div>
    ${l.review ? `<p>${esc(l.review)}</p>` : ''}
    ${l.tags?.length ? `<div class="log-tags">${tagList(l.tags)}</div>` : ''}
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
            <div><h3>${esc(b.title)}</h3><span class="muted">${esc(authorsText(b.authors))}${b.pages ? ` · ${b.pages} pp` : ''}</span>${l.tags?.length ? `<div class="log-tags">${tagList(l.tags)}</div>` : ''}</div>
            <span class="stars">${starsText(l.rating)}</span>
            <span class="icons">${formatIcons(l.formats)}${knitIcon(l)}${l.liked ? '<span class="heart">♥</span>' : ''}${l.reread ? '<span title="Reread">↻</span>' : ''}${l.review ? '<span title="Has review">≡</span>' : ''}</span>
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
  const period = [month === 'all' ? '' : MONTHS[Number(month) - 1] + (year === 'all' ? ',' : ''), year === 'all' ? (month === 'all' ? 'All time' : 'all years') : year].filter(Boolean).join(' ');

  // Every number on the page is clickable: drill() remembers which diary entries make it up.
  const drills = [];
  const drill = (title, entries, opts = {}) => {
    drills.push({ title, entries, ...opts });
    return drills.length - 1;
  };
  const groupBy = (fn) => Object.entries(picked.reduce((m, l) => (fn(l).forEach((k) => k && (m[k] ||= []).push(l)), m), {})).sort((a, b) => b[1].length - a[1].length);
  const pagesOf = (l) => Number(books[l.bookId].pages) || 0;

  const rated = picked.filter((l) => l.rating);
  const pages = picked.reduce((n, l) => n + pagesOf(l), 0);
  const liked = picked.filter((l) => l.liked);
  const knitted = picked.filter((l) => l.knitted);
  // Tags group case-insensitively under their most-used spelling.
  const spelling = new Map(store.allTags().map((t) => [t.toLowerCase(), t]));
  const tagGroups = [...picked.reduce((m, l) => {
    for (const t of l.tags || []) {
      const g = m.get(t.toLowerCase()) || { tag: spelling.get(t.toLowerCase()) || t, entries: [] };
      g.entries.push(l);
      m.set(t.toLowerCase(), g);
    }
    return m;
  }, new Map()).values()].sort((a, b) => b.entries.length - a.entries.length || a.tag.localeCompare(b.tag));

  // The timeline zooms with the filters: all years -> per year, one year -> per month, one month -> per day.
  let timeline;
  if (month !== 'all') {
    const days = year === 'all' ? 31 : new Date(Number(year), Number(month), 0).getDate();
    timeline = { title: 'Books per day', ticks: ['1', String(Math.ceil(days / 2)), String(days)],
      buckets: Array.from({ length: days }, (_, d) => ({ label: `${MONTHS[Number(month) - 1]} ${d + 1}${year === 'all' ? '' : `, ${year}`}`, entries: picked.filter((l) => Number(l.date.slice(8, 10)) === d + 1) })) };
  } else if (year === 'all') {
    const span = years.length ? [...years].reverse() : [thisYear];
    timeline = { title: 'Books per year', ticks: [span[0], '', span[span.length - 1]],
      buckets: span.map((y) => ({ label: y, short: y, entries: picked.filter((l) => l.date.startsWith(y)) })) };
  } else {
    timeline = { title: 'Books per month', ticks: ['Jan', 'Jun', 'Dec'],
      buckets: MONTHS.map((m, i) => ({ label: `${m} ${year}`, short: m.slice(0, 3), entries: picked.filter((l) => Number(l.date.slice(5, 7)) === i + 1) })) };
  }
  const ratingBuckets = Array.from({ length: 10 }, (_, i) => ({ label: `Rated ${starsText((i + 1) / 2)}`, short: `${i ? Math.floor((i + 1) / 2) || '' : ''}${i % 2 ? '' : '½'}★`, entries: rated.filter((l) => l.rating === (i + 1) / 2) }));

  // A read in one format counts toward that format; a read in two or more counts once, as a combination.
  const single = Object.keys(store.FORMATS).map((f) => [f, picked.filter((l) => l.formats?.length === 1 && l.formats[0] === f)]);
  const combined = picked.filter((l) => l.formats?.length > 1);
  const combos = groupBy((l) => (l.formats?.length > 1 ? [l.formats.map((f) => store.FORMATS[f]).join(' + ')] : []));

  const tile = (value, label, d, extra = '') =>
    `<button type="button" class="tile drill" data-drill="${d}" ${drills[d].entries.length ? '' : 'disabled'}><b>${value}</b><span class="muted">${label}</span>${extra}</button>`;
  // Timeline bars name their own period, so their drill-down skips the filter label.
  // Each bar shows its count on top. Charts of up to 12 bars label every bar; longer ones use the ticks.
  const bars = (buckets, chartTitle, ticks, ownPeriod = false) => {
    const max = Math.max(1, ...buckets.map((b) => b.entries.length));
    return `<div class="bars">${buckets.map((b) => {
      const n = b.entries.length;
      return `<button type="button" style="height:${(n / max) * 100}%" data-drill="${drill(b.label, b.entries, { ownPeriod })}" title="${esc(b.label)}: ${n}" aria-label="${esc(chartTitle)}, ${esc(b.label)}: ${n} ${n === 1 ? 'book' : 'books'}" ${n ? '' : 'disabled'}>${n ? `<span class="bar-n" aria-hidden="true">${n}</span>` : ''}</button>`;
    }).join('')}</div>
    ${buckets.length <= 12 && buckets.every((b) => b.short)
      ? `<div class="bar-axis" aria-hidden="true">${buckets.map((b) => `<span>${esc(b.short)}</span>`).join('')}</div>`
      : `<div class="bar-labels" aria-hidden="true">${ticks.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`}`;
  };
  const top = (rows, what) => (rows.length
    ? `<ol>${rows.slice(0, 5).map(([k, entries]) => `<li><button type="button" class="link-btn" data-drill="${drill(`${what}: ${k}`, entries)}">${esc(k)}</button> <span class="muted">· ${entries.length}</span></li>`).join('')}</ol>`
    : '<p class="muted">—</p>');

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
    <p class="muted">${esc(period)} · ${picked.length} ${picked.length === 1 ? 'book' : 'books'}${picked.length ? ' · Click any number or bar to see the books.' : ''}</p>
    ${picked.length ? '' : '<div class="empty">No books logged in this period.</div>'}
    <div class="tile-row">
      ${tile(picked.length, 'books', drill('Books', picked))}
      ${tile(pages.toLocaleString(), 'pages', drill('Pages', [...picked].sort((a, b) => pagesOf(b) - pagesOf(a)), { showPages: true }))}
      ${tile(rated.length ? (rated.reduce((n, l) => n + l.rating, 0) / rated.length).toFixed(1) : '—', 'average rating', drill('Rated books', [...rated].sort((a, b) => b.rating - a.rating)))}
      ${tile(liked.length, 'liked', drill('Liked', liked))}
      ${tile(`🧶 ${knitted.length}`, 'knitted', drill('Knitted while reading', knitted),
        picked.length ? `<small class="muted combo-line">${Math.round((knitted.length / picked.length) * 100)}% of books</small>` : '')}
    </div>
    <h2 class="section-title">How you read</h2>
    <div class="tile-row">
      ${single.map(([f, entries]) => tile(`${FORMAT_ICONS[f]} ${entries.length}`, store.FORMATS[f].toLowerCase(), drill(store.FORMATS[f], entries))).join('')}
      ${tile(`🔀 ${combined.length}`, 'combination', drill('Combination', combined),
        combos.map(([k, entries]) => `<small class="muted combo-line">${esc(k)} · ${entries.length}</small>`).join(''))}
    </div>
    <h2 class="section-title">Tags</h2>
    ${tagGroups.length
      ? `<div class="tag-cloud">${tagGroups.map((g) => `<button type="button" class="tag tag-stat" data-drill="${drill(`Tag: ${g.tag}`, g.entries)}" aria-label="${esc(g.tag)}: ${g.entries.length} ${g.entries.length === 1 ? 'book' : 'books'}">${esc(g.tag)}<span class="tag-count">${g.entries.length}</span></button>`).join('')}</div>`
      : '<p class="muted">No tags in this period. Add tags when you log a book.</p>'}
    <h2 class="section-title">${timeline.title}</h2>${bars(timeline.buckets, timeline.title, timeline.ticks, true)}
    <h2 class="section-title">Ratings</h2>${bars(ratingBuckets, 'Ratings', ['½★', '5★'])}
    <div class="tile-row" style="margin-top:2rem">
      <div><h2 class="section-title">Top authors</h2>${top(groupBy((l) => books[l.bookId].authors || []), 'Author')}</div>
      <div><h2 class="section-title">Top publishers</h2>${top(groupBy((l) => [books[l.bookId].publisher]), 'Publisher')}</div>
    </div>`;

  $('#stats-filters').addEventListener('change', (e) => {
    const f = e.currentTarget;
    location.hash = `#/stats?year=${f.year.value}&month=${f.month.value}`;
  });
  app.querySelectorAll('[data-drill]').forEach((el) => el.addEventListener('click', () => openDrill(drills[el.dataset.drill], period)));
}

const drillDialog = $('#drill-dialog');
function openDrill({ title, entries, showPages, ownPeriod }, period) {
  const { books } = store.getState();
  $('#drill-title').textContent = title;
  $('#drill-sub').textContent = `${ownPeriod ? '' : `${period} · `}${entries.length} ${entries.length === 1 ? 'book' : 'books'}`;
  $('#drill-list').innerHTML = entries.map((l) => {
    const b = books[l.bookId];
    const meta = [new Date(l.date + 'T00:00').toLocaleDateString(undefined, { dateStyle: 'medium' }), showPages ? (b.pages ? `${Number(b.pages).toLocaleString()} pp` : 'pages unknown') : ''].filter(Boolean).join(' · ');
    return `<li><a class="drill-row" href="#/book/${encodeURIComponent(b.id)}">
      ${cover(b, 'sm')}
      <div><h3>${esc(b.title)}</h3><span class="muted">${esc(authorsText(b.authors))}</span><br>
        <span class="muted">${esc(meta)}</span> <span class="stars">${starsText(l.rating)}</span> ${l.liked ? '<span class="heart">♥</span>' : ''} ${formatIcons(l.formats)} ${knitIcon(l)}${l.tags?.length ? `<div class="log-tags">${tagList(l.tags)}</div>` : ''}</div>
    </a></li>`;
  }).join('');
  drillDialog.showModal();
}
drillDialog.addEventListener('click', (e) => {
  // Close on a backdrop click or when following a link to a book.
  if (e.target === drillDialog || e.target.closest('a.drill-row')) drillDialog.close();
});

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

// ---------- tag input ----------
// Type to filter existing tags; Enter or comma adds the highlighted suggestion,
// or creates a new tag when nothing matches. Matching ignores case.

const tagEntry = $('#tag-entry');
const tagChips = $('#tag-chips');
const tagSuggest = $('#tag-suggestions');
let tagState = [];
let tagOptions = [];
let tagActive = -1;
const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();

function setTags(tags) {
  tagState = store.cleanTags(tags);
  tagEntry.value = '';
  renderTagChips();
  closeTagSuggestions();
}

function renderTagChips() {
  tagChips.innerHTML = tagState
    .map((t, i) => `<li class="tag">${esc(t)}<button type="button" data-remove-tag="${i}" aria-label="Remove tag ${esc(t)}">×</button></li>`)
    .join('');
}

function addTag(raw) {
  const typed = String(raw).trim().replace(/\s+/g, ' ');
  if (!typed) return;
  const tag = store.allTags().find((t) => sameTag(t, typed)) || typed; // reuse the existing spelling
  if (!tagState.some((t) => sameTag(t, tag))) tagState.push(tag);
  tagEntry.value = '';
  renderTagChips();
  renderTagSuggestions();
}

function renderTagSuggestions() {
  const q = tagEntry.value.trim().replace(/\s+/g, ' ');
  const available = store.allTags().filter((t) => !tagState.some((s) => sameTag(s, t)));
  const matches = (q ? available.filter((t) => t.toLowerCase().includes(q.toLowerCase())) : available).slice(0, 8);
  tagOptions = matches.map((t) => ({ value: t, label: esc(t) }));
  if (q && ![...available, ...tagState].some((t) => sameTag(t, q))) {
    tagOptions.push({ value: q, label: `Create “${esc(q)}”`, create: true });
  }
  tagActive = q && tagOptions.length ? 0 : -1;
  if (!tagOptions.length || document.activeElement !== tagEntry) return closeTagSuggestions();
  paintTagSuggestions();
  tagSuggest.hidden = false;
  tagEntry.setAttribute('aria-expanded', 'true');
}

function paintTagSuggestions() {
  tagSuggest.innerHTML = tagOptions
    .map((o, i) => `<li role="option" id="tag-opt-${i}" data-tag-index="${i}" class="${o.create ? 'create' : ''}" aria-selected="${i === tagActive}">${o.label}</li>`)
    .join('');
  if (tagActive >= 0) tagEntry.setAttribute('aria-activedescendant', `tag-opt-${tagActive}`);
  else tagEntry.removeAttribute('aria-activedescendant');
}

function closeTagSuggestions() {
  tagSuggest.hidden = true;
  tagActive = -1;
  tagEntry.setAttribute('aria-expanded', 'false');
  tagEntry.removeAttribute('aria-activedescendant');
}

tagEntry.addEventListener('input', () => {
  if (tagEntry.value.includes(',')) {
    const parts = tagEntry.value.split(',');
    parts.slice(0, -1).forEach(addTag);
    tagEntry.value = parts.at(-1);
  }
  renderTagSuggestions();
});
tagEntry.addEventListener('focus', renderTagSuggestions);
tagEntry.addEventListener('blur', () => setTimeout(closeTagSuggestions, 100));
tagEntry.addEventListener('keydown', (e) => {
  const open = !tagSuggest.hidden;
  if (e.key === 'Enter') {
    e.preventDefault(); // Enter must not submit (and close) the log dialog
    if (open && tagActive >= 0) addTag(tagOptions[tagActive].value);
    else addTag(tagEntry.value);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) return renderTagSuggestions();
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    tagActive = (tagActive + step + tagOptions.length) % tagOptions.length;
    paintTagSuggestions();
  } else if (e.key === 'Escape' && open) {
    e.preventDefault(); // close the list, not the dialog
    e.stopPropagation();
    closeTagSuggestions();
  } else if (e.key === 'Backspace' && !tagEntry.value && tagState.length) {
    tagState.pop();
    renderTagChips();
    renderTagSuggestions();
  }
});
// mousedown (not click) so the input keeps focus while picking.
tagSuggest.addEventListener('mousedown', (e) => {
  const li = e.target.closest('[data-tag-index]');
  if (!li) return;
  e.preventDefault();
  addTag(tagOptions[Number(li.dataset.tagIndex)].value);
});
tagChips.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-tag]');
  if (!btn) return;
  tagState.splice(Number(btn.dataset.removeTag), 1);
  renderTagChips();
  tagEntry.focus();
});
$('#tag-input').addEventListener('click', (e) => {
  if (e.target.id === 'tag-input') tagEntry.focus();
});

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
  logForm.knitted.checked = !!log?.knitted;
  setTags(log?.tags || []);
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
    knitted: logForm.knitted.checked,
    tags: [...tagState, tagEntry.value], // text still in the box counts too
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

document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-open-settings]')) return;
  e.preventDefault();
  $('#settings-btn').click();
});

$('#quick-search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});
window.addEventListener('hashchange', render);
setGoogleKey(store.getState().settings.googleKey);
await initImprints();
render();
