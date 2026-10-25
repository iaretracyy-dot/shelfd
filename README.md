# Shelfd

A Letterboxd-style reading tracker: search a book catalog, pick the book you read, and its details (author, publisher, imprint, pages, ISBN, cover) fill in automatically. Then log it with a date, a half-star rating, a like and a review.

Comes in two parts:

- **`web/`**: the website. Plain HTML/CSS/JS with no build step.
- **`ios/`**: the iPhone app. SwiftUI + SwiftData, iOS 17+.

## Features

- **Catalog search** by title, author or ISBN.
- **Autofill on select:** author, publisher, imprint, page count, publish date, ISBN-10/13, format, cover and description.
- **Edition picker:** a book can have many editions. Pick the copy you actually read to get the right publisher and page count.
- **Correct details:** any autofilled field can be edited.
- **Diary:** log every read with a date, ★ to ★★★★★ in half steps, a ♥ like, a reread flag and a review.
- **Shelves:** Want to read · Reading · Read · Did not finish.
- **Library:** a cover grid with sorting. **Stats:** books and pages per year, rating spread, top authors and publishers.
- **Export / import JSON:** both apps use the same file format, so a library can move between the website and the phone.

## Where the book data comes from

| Source | Used for | Key needed? |
|---|---|---|
| [Open Library](https://openlibrary.org/developers/api) | Main search, per-edition publisher, pages, ISBNs, covers | No |
| [Google Books](https://developers.google.com/books) | Backup search; fills missing page counts, publishers and descriptions by ISBN | Optional (set it in Settings to raise the rate limit) |

**About imprints:** catalogs usually record the imprint printed on the book (for example "Vintage" or "Riverhead Books") and not the parent company. `web/data/imprints.json` maps about 230 imprints to their parent houses (Penguin Random House, HarperCollins, and others), so the app fills in both fields. Both apps share this one file. Add entries to it as you find gaps.

## Run the website

```sh
cd web
python3 -m http.server 8000     # or: npx serve .
# open http://localhost:8000
```

It needs a local server because ES modules don't load from `file://`. To deploy, upload the `web/` folder to any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages).

## Run the iOS app

Requires a Mac with Xcode 15 or newer.

```sh
brew install xcodegen
cd ios
xcodegen generate
open Shelfd.xcodeproj
```

Pick a simulator or your phone and press Run. To install on a real device, set your Team under *Signing & Capabilities* and change the bundle ID (`com.example.shelfd`) in `project.yml`.

```
ios/Shelfd/
  ShelfdApp.swift              app entry, tab bar
  Models/Book.swift            SwiftData models: Book, LogEntry, Shelf
  Services/CatalogService.swift     Open Library + Google Books
  Services/PublisherResolver.swift  imprint → publisher lookup
  Services/LibraryTransfer.swift    JSON export/import (same format as the web)
  Views/                       Home, Search, BookPreview, BookDetail, LogEntrySheet, Diary, Library
```

## Data & sync

Right now each app stores data on its own device (browser `localStorage`, SwiftData on iOS). Use Settings → Export / Import to move a library between them.

Next step for real accounts and automatic sync: add a backend such as Supabase (Postgres + auth). The `books` and `logs` shapes in the export file can be used as the table schema. Follows, a friends' activity feed and public reviews (the social side of Letterboxd) would be built on that.
