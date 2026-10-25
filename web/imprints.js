// Works out { publisher, imprint } from the publisher names a catalog returns.
// Catalogs usually record the imprint printed on the spine ("Vintage", "Riverhead"),
// so we look it up in data/imprints.json to find the parent publishing house.

let index = null; // normalized imprint name -> { imprint, parent }
let parents = null; // normalized parent name -> parent

export function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'’"()[\]]/g, '')
    .replace(/\b(the|inc|ltd|llc|co|company|corp|group|publishing|publishers|publisher|books|book)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadImprints(data) {
  index = new Map();
  parents = new Map();
  for (const [parent, imprints] of Object.entries(data)) {
    if (parent.startsWith('_')) continue;
    parents.set(normalize(parent), parent);
    for (const imprint of imprints) index.set(normalize(imprint), { imprint, parent });
  }
}

export async function initImprints(url = './data/imprints.json') {
  try {
    loadImprints(await (await fetch(url)).json());
  } catch {
    loadImprints({});
  }
}

function lookup(name) {
  const n = normalize(name);
  if (!n) return null;
  if (parents.has(n)) return { publisher: parents.get(n), imprint: '' };
  const hit = index.get(n);
  if (hit) return { publisher: hit.parent, imprint: normalize(hit.parent) === n ? '' : clean(name) };
  // "Vintage Books, a division of Random House" -> longest known imprint that prefixes the name
  let best = null;
  for (const [key, value] of index) {
    if (key.length >= 4 && n.startsWith(key + ' ') && (!best || key.length > best.key.length)) best = { key, ...value };
  }
  return best ? { publisher: best.parent, imprint: best.imprint } : null;
}

function clean(name) {
  return String(name).replace(/\s+/g, ' ').replace(/[\s,;:]+$/, '').trim();
}

export function resolvePublisher(names) {
  if (!index) loadImprints({});
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean).map(clean);
  const hits = list.map(lookup).filter(Boolean);
  return hits.find((h) => h.imprint) || hits[0] || { publisher: list[0] || '', imprint: '' };
}
