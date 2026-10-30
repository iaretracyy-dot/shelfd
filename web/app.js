import { initImprints, resolvePublisher } from './imprints.js';
import { searchCatalog, loadBookDetails, selectEdition, setGoogleKey, lookupISBN } from './catalog.js';
import { readSpreadsheet, parseStoryGraph } from './storygraph.js';
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

// "📱 Ebook · 🎧 Audiobook", shown in the Diary so the format is clear at a glance.
const formatLabel = (formats) =>
  formats?.length ? `<div class="format-label">${formats.map((f) => `${FORMAT_ICONS[f]} ${store.FORMATS[f]}`).join(' · ')}</div>` : '';
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

// Shorten book titles inside notifications so they stay on one line.
function clip(text, max = 24) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,:;–-]+$/, '')}…`; // end on a whole word
}

// toast('Saved') or toast('Updated', { label: 'Undo', run: fn }) for an action button.
// Every notification stays 8 seconds, then fades out.
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('has-action', !!action);
  if (action) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: action.label });
    btn.addEventListener('click', () => {
      t.classList.remove('show');
      action.run();
    });
    t.append(' ', btn);
  }
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 8000);
}

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { parts: (path || '/').split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) };
}

// ---------- router ----------

const routes = { '': diary, search, preview, add: addManually, import: importPage, book: bookPage, diary, library, stats };
let currentAbort = null;

function render({ keepScroll = false } = {}) {
  const y = window.scrollY;
  currentAbort?.abort();
  currentAbort = new AbortController();
  const { parts, params } = parseHash();
  const view = routes[parts[0] || ''] || diary;
  // Leaving a page (link, back button or swipe) closes any dialog left open on it.
  document.querySelectorAll('dialog[open]').forEach((d) => d.close('cancel'));
  if (parts[0] !== selectionPage) selection = null; // selections belong to one page
  selectionPage = parts[0];
  const section = { preview: 'search', add: 'search', book: '', import: '' }[parts[0]] ?? (parts[0] || 'diary');
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === section);
    a.toggleAttribute('aria-current', a.dataset.nav === section);
  });
  view(parts.slice(1), params, currentAbort.signal);
  window.scrollTo(0, keepScroll ? y : 0);
}

// ---------- home ----------

function posterGrid(books) {
  return `<div class="poster-row">${books
    .map((b) => {
      const rating = store.latestRating(b.id);
      return `<a class="poster" data-id="${esc(b.id)}" href="#/book/${encodeURIComponent(b.id)}" title="${esc(b.title)} — ${esc(authorsText(b.authors))}">
        ${cover(b)}
        <span class="poster-title">${esc(b.title)}</span><span class="poster-author">${esc(authorsText(b.authors))}</span>
        <span class="under"><span class="stars">${starsText(rating)}</span></span>
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
        ? `<p class="muted">${relaxed ? `No exact matches for “${esc(q)}”. Showing results for <b>“${esc(relaxed)}”</b>.` : `${results.length} ${results.length === 1 ? 'result' : 'results'} for “${esc(q)}”.`} Select the book you read.</p>
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
  if (!result) return diary([], new URLSearchParams());
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
          <button type="button" class="btn small" data-shelf="want">＋ Want to read</button>
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
        <button type="button" class="btn" data-shelf="want">＋ Want to read</button>
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

// ---------- StoryGraph import ----------

let enrichJob = null; // background detail lookup: { total, done, found, running }

function importPage() {
  app.innerHTML = `
    <h1>Import from StoryGraph</h1>
    <ol class="steps">
      <li>On StoryGraph, open <b>Manage Account</b> and choose <b>Export StoryGraph Library</b>.</li>
      <li>Download the CSV file it gives you.</li>
      <li>Choose that file below. A copy you opened and saved in Excel (.xlsx) works too.</li>
    </ol>
    <label class="dropzone">
      <input type="file" id="sg-file" accept=".csv,.xlsx,.xls,text/csv" />
      <span>📄 Choose your StoryGraph file…</span>
    </label>
    <div id="sg-result"></div>
    <div id="enrich-progress"></div>`;
  paintEnrich();
  $('#sg-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const out = $('#sg-result');
    out.innerHTML = '<div class="spinner"></div>';
    try {
      const parsed = parseStoryGraph(await readSpreadsheet(file));
      if (!parsed.books.length) throw new Error('No books found in this file.');
      showImportPreview(parsed, file.name);
    } catch (err) {
      out.innerHTML = `<div class="notice">⚠ Couldn't read “${esc(file.name)}”: ${esc(err.message)}</div>`;
    }
    e.target.value = '';
  });
}

function showImportPreview({ books, skipped }, fileName) {
  const count = (shelf) => books.filter((b) => b.shelf === shelf).length;
  const entries = books.reduce((n, b) => n + b.logs.length, 0);
  const withISBN = books.filter((b) => b.isbn13 || b.isbn10).length;
  const shelfLine = Object.entries(store.SHELVES).map(([k, label]) => `<li><b>${count(k)}</b> ${label.toLowerCase()}</li>`).join('');
  $('#sg-result').innerHTML = `
    <h2 class="section-title">${esc(fileName)}</h2>
    <p>Found <b>${books.length}</b> books, which will add <b>${entries}</b> diary ${entries === 1 ? 'entry' : 'entries'}.${skipped ? ` <span class="muted">${skipped} ${skipped === 1 ? 'row' : 'rows'} without a title ${skipped === 1 ? 'was' : 'were'} skipped.</span>` : ''}</p>
    <ul class="import-counts">${shelfLine}</ul>
    <table class="import-table">
      <thead><tr><th>Title</th><th>Author</th><th>Shelf</th><th>Reads</th><th>Rating</th></tr></thead>
      <tbody>${books.slice(0, 8).map((b) => `<tr><td>${esc(b.title)}</td><td>${esc(authorsText(b.authors))}</td><td>${esc(store.SHELVES[b.shelf])}</td><td>${b.logs.length || '—'}</td><td class="stars">${starsText(b.logs.at(-1)?.rating)}</td></tr>`).join('')}</tbody>
    </table>
    ${books.length > 8 ? `<p class="muted">…and ${books.length - 8} more.</p>` : ''}
    <label class="check"><input type="checkbox" id="sg-enrich" ${withISBN ? 'checked' : 'disabled'} />
      Look up covers, publishers and page counts for the ${withISBN} books with an ISBN (StoryGraph doesn't export them)</label>
    <p class="muted small-print">Books already in your library are matched and not duplicated, so it's safe to import the same file again later.</p>
    <button type="button" class="btn primary" id="sg-import">Import ${books.length} books</button>`;
  $('#sg-import').addEventListener('click', () => {
    const enrich = $('#sg-enrich').checked;
    const r = store.importLibrary(books);
    $('#sg-result').innerHTML = `
      <div class="import-done">
        <h2>✓ Import complete</h2>
        <p>Added <b>${r.added}</b> new ${r.added === 1 ? 'book' : 'books'}${r.matched ? `, matched <b>${r.matched}</b> already in your library` : ''}, and <b>${r.entries}</b> diary ${r.entries === 1 ? 'entry' : 'entries'}.</p>
        <p><a class="btn small" href="#/library">Go to Library</a> <a class="btn small" href="#/diary">Go to Diary</a> <a class="btn small" href="#/stats">See Stats</a></p>
      </div>`;
    toast('Import complete');
    if (enrich) enrichBooks(r.ids);
  });
}

const ENRICH_FIELDS = ['publisher', 'imprint', 'pages', 'publishedDate', 'editionKey', 'workKey', 'language', 'description', 'isbn13', 'isbn10'];

async function enrichBooks(ids) {
  if (enrichJob?.running) return;
  const queue = [...new Set(ids)].filter((id) => {
    const b = store.getBook(id);
    return b && (b.isbn13 || b.isbn10) && (!b.pages || !b.publisher);
  });
  enrichJob = { total: queue.length, done: 0, found: 0, running: true };
  paintEnrich();
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const book = store.getBook(id);
      try {
        const info = book && (await lookupISBN(book.isbn13 || book.isbn10));
        if (info) {
          const patch = Object.fromEntries(ENRICH_FIELDS.filter((f) => !book[f] && info[f]).map((f) => [f, info[f]]));
          if (info.coverUrl && !/covers\.openlibrary\.org\/b\/id\//.test(book.coverUrl || '')) patch.coverUrl = info.coverUrl;
          store.updateBook(id, patch);
          enrichJob.found++;
        }
      } catch {}
      enrichJob.done++;
      paintEnrich();
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker)); // a few at a time, to be polite to Open Library
  enrichJob.running = false;
  paintEnrich();
}

function paintEnrich() {
  const el = $('#enrich-progress');
  if (!el || !enrichJob || !enrichJob.total) return;
  const { total, done, found, running } = enrichJob;
  el.innerHTML = running
    ? `<p>Looking up book details… <b>${done}</b> of ${total}</p><progress max="${total}" value="${done}"></progress>
       <p class="muted small-print">You can keep using Shelfd while this runs.</p>`
    : `<p>✓ Filled in details for <b>${found}</b> of ${total} books.${total - found ? ` ${total - found} couldn't be found in the catalogs; you can add their details from each book's page.` : ''}</p>`;
}

// ---------- library book page ----------

function bookPage([id]) {
  let book = store.getBook(id);
  if (!book) {
    app.innerHTML = `<div class="empty">This book isn't in your library.</div>`;
    return;
  }
  let logs;
  let editing = false;

  const draw = () => {
    book = store.getBook(id) || book; // latest saved copy (another tab may have changed it)
    logs = store.logsFor(id);
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
        // Save only the detail fields, so nothing else on the book is overwritten.
        const edits = readEdits(form, book);
        store.updateBook(id, Object.fromEntries(DETAIL_FIELDS.map(([key]) => [key, edits[key]])));
        toast('Details saved');
      }
      editing = !editing;
      draw();
    });
    form.querySelectorAll('[data-shelf]').forEach((btn) =>
      btn.addEventListener('click', () => {
        store.updateBook(id, { shelf: btn.dataset.shelf });
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

function diary(_, params) {
  const { books } = store.getState();
  const everything = store.allLogs().filter((l) => books[l.bookId]);
  if (!everything.length) {
    app.innerHTML = `<h1>Diary</h1><div class="empty">Your diary is empty. <a href="#/search">Log a book</a> to begin.</div>`;
    return;
  }
  // Year / month filters (default: everything)
  const years = [...new Set(everything.map((l) => l.date.slice(0, 4)))].sort().reverse();
  const year = years.includes(params.get('year')) ? params.get('year') : 'all';
  const month = /^(0[1-9]|1[0-2])$/.test(params.get('month')) ? params.get('month') : 'all';
  const logs = everything.filter((l) => (year === 'all' || l.date.startsWith(year)) && (month === 'all' || l.date.slice(5, 7) === month));
  const filtering = year !== 'all' || month !== 'all';
  const filters = `
    <form class="filters" id="diary-filters">
      <label>Year
        <select name="year">
          <option value="all">All years</option>
          ${years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </label>
      <label>Month
        <select name="month">
          <option value="all">All months</option>
          ${MONTHS.map((m, i) => { const v = String(i + 1).padStart(2, '0'); return `<option value="${v}" ${v === month ? 'selected' : ''}>${m}</option>`; }).join('')}
        </select>
      </label>
    </form>
    <p class="muted diary-count">${logs.length} ${logs.length === 1 ? 'entry' : 'entries'}${filtering ? ` · <a href="#/diary">Show all</a>` : ''}</p>`;
  const months = new Map();
  for (const l of logs) {
    const key = l.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(l);
  }
  app.innerHTML = `<div class="page-head"><h1>Diary</h1><div class="head-actions">${selectToggle()}</div></div>
    ${filters}
    ${selection ? `<p class="muted select-hint">Click entries to select them, then choose <b>Edit selected</b>.</p>` : ''}
    ${logs.length ? '' : '<div class="empty">No diary entries in this period.</div>'}
    <div class="${selection ? 'selecting' : ''}" id="diary-list">${[...months]
    .map(([month, entries]) => `
      <section class="diary-month">
        <h2 class="section-title">${new Date(month + '-01T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
        ${entries.map((l) => {
          const b = books[l.bookId];
          return `<a class="diary-row" data-id="${esc(l.id)}" href="#/book/${encodeURIComponent(b.id)}">
            <span class="diary-day">${Number(l.date.slice(8, 10))}</span>
            ${cover(b, 'sm')}
            <div><h3>${esc(b.title)}</h3><span class="muted">${esc(authorsText(b.authors))}${b.pages ? ` · ${b.pages} pp` : ''}</span>${formatLabel(l.formats)}${l.tags?.length ? `<div class="log-tags">${tagList(l.tags)}</div>` : ''}</div>
            <span class="stars">${starsText(l.rating)}</span>
            <span class="icons">${knitIcon(l)}${l.liked ? '<span class="heart">♥</span>' : ''}${l.reread ? '<span title="Reread">↻</span>' : ''}${l.review ? '<span title="Has review">≡</span>' : ''}</span>
          </a>`;
        }).join('')}
      </section>`)
    .join('')}</div>
    ${bulkBar(logs.length)}`;
  $('#diary-filters').addEventListener('change', (e) => {
    const f = e.currentTarget;
    location.hash = `#/diary?year=${f.year.value}&month=${f.month.value}`;
  });
  wireSelection({ container: $('#diary-list'), items: '.diary-row', allIds: logs.map((l) => l.id), mode: 'entries', rerender: () => diary(_, params) });
}

// ---------- library ----------

// The Library is the Want to read list, with a search bar for adding books.
let librarySearch = null; // last search, so re-renders don't search again: { q, results, issues, relaxed }

function library(_, params, signal) {
  const sort = params.get('sort') || 'added';
  const q = (params.get('q') || '').trim();
  const sorters = {
    added: (a, b) => b.addedAt.localeCompare(a.addedAt),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.authors[0] || '').localeCompare(b.authors[0] || ''),
  };
  const books = Object.values(store.getState().books).filter((b) => b.shelf === 'want');
  books.sort(sorters[sort] || sorters.added);
  const rerender = () => library(_, params, signal);

  app.innerHTML = `
    <div class="page-head"><h1>Library</h1>
      <div class="head-actions">
        ${selectToggle()}
        <select id="sort" aria-label="Sort" class="sort-select">${Object.keys(sorters).map((k) => `<option value="${k}" ${k === sort ? 'selected' : ''}>Sort: ${k}</option>`).join('')}</select>
      </div>
    </div>
    <p class="muted library-count">${books.length} ${books.length === 1 ? 'book' : 'books'} you want to read</p>
    <form class="search-big library-search" id="library-search" role="search">
      <input name="q" type="search" value="${esc(q)}" placeholder="Add a book: title, author or ISBN" aria-label="Search for a book to add" autocomplete="off">
      <button class="btn primary">Search</button>
    </form>
    <div id="library-results"></div>
    ${selection ? `<p class="muted select-hint">Click books to select them, then choose <b>Edit selected</b>.</p>` : ''}
    <div class="${selection ? 'selecting' : ''}" id="library-grid">${books.length ? posterGrid(books) : '<div class="empty">Your Want to read list is empty. Search above to add a book.</div>'}</div>
    ${bulkBar(books.length)}`;

  const hashFor = (query) => `#/library?sort=${sort}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  $('#sort').addEventListener('change', (e) => (location.hash = `#/library?sort=${e.target.value}${q ? `&q=${encodeURIComponent(q)}` : ''}`));
  $('#library-search').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = hashFor(e.target.q.value.trim());
  });
  wireSelection({ container: $('#library-grid'), items: '.poster', allIds: books.map((b) => b.id), mode: 'books', rerender });
  if (q) showLibraryResults(q, signal, rerender, hashFor(''));
}

async function showLibraryResults(q, signal, rerender, clearHref) {
  const out = $('#library-results');
  if (librarySearch?.q !== q) {
    out.innerHTML = '<div class="spinner"></div>';
    try {
      librarySearch = { q, ...(await searchCatalog(q, { signal })) };
    } catch (err) {
      if (err.name !== 'AbortError') out.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    if (signal?.aborted) return;
  }
  const { results, issues, relaxed } = librarySearch;
  results.forEach((r) => resultCache.set(r.id, r));
  out.innerHTML = `
    <div class="library-results">
      ${issues.map(issueNotice).join('')}
      <div class="library-results-head">
        <span class="muted">${results.length ? (relaxed ? `Showing results for <b>“${esc(relaxed)}”</b>` : `${results.length} ${results.length === 1 ? 'result' : 'results'} for “${esc(q)}”`) : `No books found for “${esc(q)}”.`}</span>
        <a href="${clearHref}" class="btn small ghost">✕ Close results</a>
      </div>
      <ul class="results">${results.map(addableRow).join('')}</ul>
      <p class="muted small-print">Not here? <a href="#/add">Add it manually</a>.</p>
    </div>`;
  out.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const result = resultCache.get(btn.dataset.add);
      btn.disabled = true;
      btn.textContent = 'Adding…';
      try {
        const { book } = await loadBookDetails(result); // fills publisher, pages, cover…
        const saved = store.saveBook(book, { shelf: 'want' });
        toast(`Added “${clip(saved.title)}” to Want to read`);
        rerender();
      } catch {
        btn.disabled = false;
        btn.textContent = '＋ Add';
        toast("Couldn't load that book. Try again.");
      }
    }),
  );
}

// A search result with a one-tap "Add" (or its status if it's already in the library).
function addableRow(r) {
  const owned = store.findInLibrary(r);
  const action = owned
    ? `<span class="badge ${owned.shelf === 'want' ? 'green' : ''} add-state">${owned.shelf === 'want' ? '✓ On your list' : esc(store.SHELVES[owned.shelf])}</span>`
    : `<button type="button" class="btn small primary" data-add="${esc(r.id)}" aria-label="Add ${esc(r.title)} to Want to read">＋ Add</button>`;
  return `<li class="result-row"><a class="result" href="#/preview/${encodeURIComponent(r.id)}">
    ${cover(r, 'sm')}
    <div>
      <h3>${esc(r.title)}${r.year ? ` <span class="muted">${esc(r.year)}</span>` : ''}</h3>
      <div class="meta">${esc(authorsText(r.authors))}</div>
    </div></a>${action}</li>`;
}

// ---------- bulk edit (Library books, Diary entries) ----------

let selection = null; // Set of selected ids while a page is in select mode
let selectionPage = '';
const bulkDialog = $('#bulk-dialog');
const bulkForm = $('#bulk-form');
let bulkContext = null; // { mode: 'books' | 'entries', rerender }

const BULK_TEXT = {
  books: {
    noun: ['book', 'books'],
    shelf: 'Moves every selected book to this shelf.',
    date: 'Marks each book as finished on this date: adds a diary entry and moves it to Read.',
    formats: 'Sets the format on that diary entry (without a read date: on each book\'s most recent read).',
  },
  entries: {
    noun: ['entry', 'entries'],
    shelf: 'Moves the books these entries belong to onto this shelf.',
    date: 'Sets this date on every selected entry.',
    formats: 'Replaces the formats on every selected entry.',
  },
};
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;

const selectToggle = () =>
  `<button type="button" class="btn small" id="select-toggle" aria-pressed="${!!selection}">${selection ? 'Done selecting' : '☑ Select'}</button>`;

const bulkBar = (total) =>
  selection
    ? `<div class="bulk-bar" role="region" aria-label="Bulk actions">
        <span id="bulk-count"></span>
        <button type="button" class="btn small ghost" id="select-all">Select all ${total}</button>
        <button type="button" class="btn small ghost" id="select-none">Clear</button>
        <span class="spacer"></span>
        <button type="button" class="btn small primary" id="bulk-edit">Edit selected…</button>
      </div>`
    : '';

// In select mode, clicking an item toggles it instead of following its link.
function wireSelection({ container, items, allIds, mode, rerender }) {
  $('#select-toggle').addEventListener('click', () => {
    selection = selection ? null : new Set();
    rerender();
  });
  if (!selection || !container) return;
  const paint = () => {
    container.querySelectorAll(items).forEach((el) => {
      const on = selection.has(el.dataset.id);
      el.classList.toggle('selected', on);
      el.setAttribute('aria-pressed', on);
    });
    $('#bulk-count').textContent = `${selection.size} selected`;
    $('#bulk-edit').disabled = !selection.size;
  };
  container.querySelectorAll(items).forEach((el) => el.setAttribute('role', 'button'));
  container.addEventListener('click', (e) => {
    const el = e.target.closest(items);
    if (!el) return;
    e.preventDefault();
    selection.has(el.dataset.id) ? selection.delete(el.dataset.id) : selection.add(el.dataset.id);
    paint();
  });
  $('#select-all').addEventListener('click', () => {
    allIds.forEach((id) => selection.add(id));
    paint();
  });
  $('#select-none').addEventListener('click', () => {
    selection.clear();
    paint();
  });
  $('#bulk-edit').addEventListener('click', () => openBulkDialog(mode, rerender));
  paint();
}

bulkForm.shelf.innerHTML = Object.entries(store.SHELVES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
// Touching a section's controls ticks that section.
for (const [box, controls] of [['doShelf', '[name=shelf]'], ['doDate', '[name=date]'], ['doFormats', '[name=bulkFormats]']]) {
  bulkForm.querySelectorAll(controls).forEach((el) => el.addEventListener('input', () => (bulkForm[box].checked = true)));
}

bulkForm.addEventListener('input', () => ($('#bulk-error').hidden = true));

function openBulkDialog(mode, rerender) {
  bulkContext = { mode, rerender };
  bulkDialog.returnValue = '';
  const text = BULK_TEXT[mode];
  $('#bulk-hint-shelf').textContent = text.shelf;
  $('#bulk-hint-date').textContent = text.date;
  $('#bulk-hint-formats').textContent = text.formats;
  bulkForm.reset();
  bulkForm.date.value = today();
  $('#bulk-error').hidden = true;
  $('#bulk-error').textContent = 'Tick at least one thing to change.';
  $('#bulk-title').textContent = `Edit ${plural(selection.size, text.noun)}`;
  bulkDialog.showModal();
}

$('#bulk-apply').addEventListener('click', (e) => {
  const f = bulkForm;
  const changes = {
    shelf: f.doShelf.checked ? f.shelf.value : null,
    date: f.doDate.checked ? f.date.value : null,
    formats: f.doFormats.checked ? [...f.querySelectorAll('[name=bulkFormats]:checked')].map((c) => c.value) : null,
  };
  if (!changes.shelf && !changes.date && !changes.formats) {
    e.preventDefault();
    $('#bulk-error').hidden = false;
    return;
  }
  if (f.doDate.checked && !f.date.value) {
    e.preventDefault();
    $('#bulk-error').textContent = 'Pick a read date, or untick Read date.';
    $('#bulk-error').hidden = false;
    return;
  }
  const before = store.snapshot();
  let message;
  if (bulkContext.mode === 'entries') {
    const r = store.bulkUpdateLogs([...selection], changes);
    message = `Updated ${plural(r.entries, BULK_TEXT.entries.noun)}`;
  } else {
    const r = store.bulkUpdate([...selection], changes);
    const notes = [
      r.created && `${plural(r.created, ['book', 'books'])} moved to Read`,
      r.noRead && `${r.noRead} not logged yet, so no format set`,
    ].filter(Boolean);
    message = `Updated ${plural(r.books, BULK_TEXT.books.noun)}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  }
  selection = new Set();
  bulkContext.rerender();
  toast(message, {
    label: 'Undo',
    run: () => {
      store.restore(before);
      render();
      toast('Changes undone');
    },
  });
});

// ---------- stats ----------

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' }));

function stats(_, params) {
  const { books } = store.getState();
  const logs = store.allLogs().filter((l) => books[l.bookId]);
  // Did-not-finish books have no diary entry; they're placed by the date they were marked DNF.
  const dnfAll = Object.values(books)
    .filter((b) => b.shelf === 'dnf')
    .map((b) => ({ bookId: b.id, date: b.dnfAt || String(b.addedAt || '').slice(0, 10), rating: 0, formats: [], tags: [] }))
    .filter((e) => e.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  const years = [...new Set([...logs, ...dnfAll].map((l) => l.date.slice(0, 4)))].sort().reverse();
  const thisYear = String(new Date().getFullYear());
  const year = params.get('year') || (years.includes(thisYear) ? thisYear : years[0]) || thisYear;
  const month = params.get('month') || 'all'; // '01'..'12' or 'all'
  const inPeriod = (l) => (year === 'all' || l.date.startsWith(year)) && (month === 'all' || l.date.slice(5, 7) === month);
  const picked = logs.filter(inPeriod);
  const dnf = dnfAll.filter(inPeriod);
  const period = [month === 'all' ? '' : MONTHS[Number(month) - 1] + (year === 'all' ? ',' : ''), year === 'all' ? (month === 'all' ? 'All time' : 'all years') : year].filter(Boolean).join(' ');

  // Every number on the page is clickable: drill() remembers which diary entries make it up.
  const drills = [];
  const drill = (title, entries, opts = {}) => {
    drills.push({ title, entries, ...opts });
    return drills.length - 1;
  };
  const groupBy = (fn) => Object.entries(picked.reduce((m, l) => (fn(l).forEach((k) => k && (m[k] ||= []).push(l)), m), {})).sort((a, b) => b[1].length - a[1].length);

  const rated = picked.filter((l) => l.rating);
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
      ${tile(dnf.length, 'did not finish', drill('Did not finish', dnf))}
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
function openDrill({ title, entries, ownPeriod }, period) {
  const { books } = store.getState();
  $('#drill-title').textContent = title;
  $('#drill-sub').textContent = `${ownPeriod ? '' : `${period} · `}${entries.length} ${entries.length === 1 ? 'book' : 'books'}`;
  $('#drill-list').innerHTML = entries.map((l) => {
    const b = books[l.bookId];
    const meta = new Date(l.date + 'T00:00').toLocaleDateString(undefined, { dateStyle: 'medium' });
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
  logDialog.returnValue = ''; // Safari can keep the last close value; never let it count as Save
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
$('#storygraph-link').addEventListener('click', () => settingsDialog.close());
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

// ---------- search boxes: clear (×) button ----------
// Every search box gets an × that appears once there's text and wipes it.
// Pages re-render their HTML, so new boxes are picked up as they appear.

function addClearButton(input) {
  if (input.closest('.search-wrap')) return;
  const hadFocus = document.activeElement === input; // moving an element drops focus
  const wrap = document.createElement('span');
  wrap.className = 'search-wrap';
  input.replaceWith(wrap);
  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'search-clear', textContent: '×', hidden: !input.value });
  btn.setAttribute('aria-label', 'Clear search');
  wrap.append(input, btn);
  if (hadFocus) input.focus();
}

function addClearButtons(root = document) {
  root.querySelectorAll('input[type=search]').forEach(addClearButton);
}

document.addEventListener('input', (e) => {
  const btn = e.target.matches?.('.search-wrap input') && e.target.parentElement.querySelector('.search-clear');
  if (btn) btn.hidden = !e.target.value;
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.search-clear');
  if (!btn) return;
  const input = btn.parentElement.querySelector('input');
  input.value = '';
  btn.hidden = true;
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
addClearButtons();
new MutationObserver(() => addClearButtons(app)).observe(app, { childList: true, subtree: true });

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
window.addEventListener('hashchange', () => render());

// Another tab saved a change. The store has already re-read it; refresh the
// page on screen, unless the user is in the middle of editing something here.
let staleView = false;
const isEditing = () => !!document.querySelector('dialog[open]') || !!app.querySelector('.details input, #manual-form, #sg-import');
function refreshIfStale() {
  if (!staleView || isEditing()) return;
  staleView = false;
  render({ keepScroll: true });
}
store.subscribe((_, { external }) => {
  if (!external) return;
  staleView = true;
  refreshIfStale();
});
document.addEventListener('visibilitychange', () => !document.hidden && refreshIfStale());
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => setTimeout(refreshIfStale)));
setGoogleKey(store.getState().settings.googleKey);
await initImprints();
render();
