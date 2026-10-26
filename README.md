# Shelfd

A Letterboxd-style reading tracker website: search a book catalog, pick the book you read, and its details (author, publisher, imprint, pages, ISBN, cover) fill in automatically. Then log it with a date, a half-star rating, a like and a review.

The site lives in **`web/`**. It's plain HTML/CSS/JS with no build step.

## Features

- **Catalog search** by title, author or ISBN. If nothing matches, it retries with looser wording, and it says when a catalog is unavailable.
- **Autofill on select:** author, publisher, imprint, page count, publish date, ISBN-10/13, format, cover and description.
- **Edition picker:** a book can have many editions. Pick the copy you actually read to get the right publisher and page count.
- **Correct details**, or **add a book manually** when it isn't in any catalog yet.
- **Diary:** log every read with a date, ★ to ★★★★★ in half steps, a ♥ like, a reread flag, formats (physical / ebook / audiobook), 🧶 knitted while reading, tags and a review.
- **Shelves:** Want to read · Reading · Read · Did not finish.
- **Library:** a cover grid with sorting, plus **bulk edit**: select books (or a whole shelf) and change status, read date and/or format in one go, with Undo.
- **Stats:** filter by year and month. See books, pages, ratings, formats (with combinations counted separately), knitting, tags, books per period, rating spread, top authors and top publishers. Click any number or bar to see the books behind it.
- **Import from StoryGraph:** load StoryGraph's CSV export, or the same file saved as `.xlsx`. Shelves, read dates (one diary entry per read), ratings, reviews, formats and tags come across. Covers, publishers and page counts are then looked up by ISBN. Re-importing the same file never creates duplicates.
- **Export / import JSON** for backups, or to move a library to another browser.

## Where the book data comes from

| Source | Used for | Key needed? |
|---|---|---|
| [Open Library](https://openlibrary.org/developers/api) | Main search, per-edition publisher, pages, ISBNs, covers | No |
| [Google Books](https://developers.google.com/books) | Backup search; fills missing page counts, publishers and descriptions by ISBN | Optional (set it in Settings to raise the rate limit) |

**About imprints:** catalogs usually record the imprint printed on the book (for example "Vintage" or "Riverhead Books") and not the parent company. `web/data/imprints.json` maps about 230 imprints to their parent houses (Penguin Random House, HarperCollins, and others), so the site fills in both fields. Add entries to it as you find gaps.

## Run it locally

```sh
cd web
python3 -m http.server 8000     # or: npx serve .
# open http://localhost:8000
```

It needs a local server because ES modules don't load from `file://`.

## Hosting

The repository is set up for GitHub Pages: deploy from the `master` branch, `/ (root)` folder. The root `index.html` forwards to `web/`. Any other static host works too (Cloudflare Pages, Netlify): set the output or publish directory to `web` and leave the build command empty.

## Data

Everything is saved in the visitor's browser (`localStorage`), so each browser has its own library. Use Settings → Export / Import JSON to back up or move a library.

Next step for real accounts and automatic sync: add a backend such as Supabase (Postgres + auth). The `books` and `logs` shapes in the export file can be used as the table schema.
