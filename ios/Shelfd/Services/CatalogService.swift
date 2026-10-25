import Foundation

/// A row in the search results list.
struct SearchResult: Identifiable, Hashable {
    enum Source: String { case openLibrary, google }
    let id: String
    let source: Source
    var workKey = ""
    var editionKey = ""
    var googleId = ""
    let title: String
    var authors: [String] = []
    var year = ""
    var coverURL = ""
    var editionCount = 0

    var authorLine: String { authors.isEmpty ? "Unknown author" : authors.joined(separator: ", ") }
}

struct BookDetails {
    var book: CatalogBook
    var editions: [CatalogBook]
}

/// Open Library (primary, no API key) + Google Books (fallback search and gap filler).
/// Mirrors web/catalog.js.
struct CatalogService {
    static let shared = CatalogService()
    var googleAPIKey: String { UserDefaults.standard.string(forKey: "googleBooksKey") ?? "" }

    private let session = URLSession.shared
    private let resolver = PublisherResolver.shared
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    // MARK: Search

    func search(_ query: String) async throws -> [SearchResult] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        async let ol = capture { try await searchOpenLibrary(q) }
        async let gb = capture { try await searchGoogle(q) }
        let (olResult, gbResult) = await (ol, gb)

        var results = (try? olResult.get()) ?? []
        var seen = Set(results.map(dedupeKey))
        for r in (try? gbResult.get()) ?? [] where seen.insert(dedupeKey(r)).inserted {
            results.append(r)
        }
        if results.isEmpty, case .failure(let error) = olResult, case .failure = gbResult { throw error }
        return results
    }

    private func dedupeKey(_ r: SearchResult) -> String {
        let letters = { (s: String) in s.lowercased().filter { $0.isLetter || $0.isNumber } }
        return letters(r.title) + "|" + letters(r.authors.first ?? "").filter(\.isLetter)
    }

    private func isISBN(_ q: String) -> Bool {
        let digits = q.filter { !$0.isWhitespace && $0 != "-" }
        return digits.range(of: "^(97[89])?\\d{9}[\\dXx]$", options: .regularExpression) != nil
    }

    private func searchOpenLibrary(_ q: String) async throws -> [SearchResult] {
        var c = URLComponents(string: "https://openlibrary.org/search.json")!
        let isbn = isISBN(q)
        c.queryItems = [
            URLQueryItem(name: isbn ? "isbn" : "q", value: isbn ? q.filter(\.isNumber) : q),
            URLQueryItem(name: "limit", value: "20"),
            URLQueryItem(name: "fields", value: "key,title,subtitle,author_name,first_publish_year,cover_i,cover_edition_key,edition_count"),
        ]
        let response: OLSearch = try await get(c.url!)
        return response.docs.map { d in
            SearchResult(id: "ol:\(d.key.lastPathComponent)", source: .openLibrary, workKey: d.key.lastPathComponent,
                         editionKey: d.coverEditionKey ?? "", title: d.title ?? "Untitled", authors: d.authorName ?? [],
                         year: d.firstPublishYear.map(String.init) ?? "", coverURL: Self.olCover(d.coverI, size: "M"),
                         editionCount: d.editionCount ?? 0)
        }
    }

    private func searchGoogle(_ q: String) async throws -> [SearchResult] {
        let query = isISBN(q) ? "isbn:\(q.filter { $0.isNumber || $0 == "X" || $0 == "x" })" : q
        let response: GBSearch = try await get(googleURL("volumes", [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "maxResults", value: "20"),
            URLQueryItem(name: "printType", value: "books"),
        ]))
        return (response.items ?? []).map { item in
            let v = item.volumeInfo
            return SearchResult(id: "gb:\(item.id)", source: .google, googleId: item.id, title: v.title ?? "Untitled",
                                authors: v.authors ?? [], year: String((v.publishedDate ?? "").prefix(4)),
                                coverURL: Self.googleCover(v.imageLinks), editionCount: 1)
        }
    }

    // MARK: Details

    func details(for result: SearchResult) async throws -> BookDetails {
        if result.source == .google {
            let item: GBVolume = try await get(googleURL("volumes/\(result.googleId)", []))
            return BookDetails(book: fromGoogle(item), editions: [])
        }
        let workURL = URL(string: "https://openlibrary.org/works/\(result.workKey).json")!
        let editionsURL = URL(string: "https://openlibrary.org/works/\(result.workKey)/editions.json?limit=100")!
        async let workTask: OLWork? = try? get(workURL)
        async let editionsTask: OLEditions? = try? get(editionsURL)
        let (work, editionsResponse) = await (workTask, editionsTask)

        var base = CatalogBook()
        base.workKey = result.workKey
        base.title = result.title
        base.authors = result.authors
        base.firstPublished = result.year
        base.description = work?.description?.text ?? ""
        base.subjects = Array((work?.subjects ?? []).prefix(8))

        let editions = (editionsResponse?.entries ?? [])
            .map { fromOpenLibrary($0, base: base) }
            .sorted { score($0) > score($1) }
        var book = editions.first { $0.editionKey == result.editionKey } ?? editions.first ?? base
        if book.coverURL.isEmpty { book.coverURL = result.coverURL.replacingOccurrences(of: "-M.", with: "-L.") }
        return BookDetails(book: await fillGaps(book), editions: editions)
    }

    /// Called when the user switches to a different edition.
    func select(edition: CatalogBook) async -> CatalogBook {
        await fillGaps(edition)
    }

    private func fromOpenLibrary(_ e: OLEdition, base: CatalogBook) -> CatalogBook {
        var b = base
        let names = e.publishers ?? []
        let (publisher, imprint) = resolver.resolve(names)
        b.source = "openlibrary"
        b.editionKey = e.key.lastPathComponent
        b.title = e.title ?? base.title
        b.subtitle = e.subtitle ?? ""
        b.publishers = names
        b.publisher = publisher
        b.imprint = imprint
        b.pages = e.numberOfPages ?? Self.parsePagination(e.pagination)
        b.isbn13 = e.isbn13?.first ?? ""
        b.isbn10 = e.isbn10?.first ?? ""
        b.publishedDate = e.publishDate ?? ""
        b.language = e.languages?.first?.key.lastPathComponent ?? ""
        b.format = e.physicalFormat ?? ""
        b.coverURL = Self.olCover(e.covers?.first { $0 > 0 }, size: "L")
        return b
    }

    private func fromGoogle(_ item: GBVolume) -> CatalogBook {
        let v = item.volumeInfo
        let ids = Dictionary((v.industryIdentifiers ?? []).map { ($0.type, $0.identifier) }, uniquingKeysWith: { a, _ in a })
        let names = v.publisher.map { [$0] } ?? []
        let (publisher, imprint) = resolver.resolve(names)
        var b = CatalogBook()
        b.source = "google"
        b.googleId = item.id
        b.title = v.title ?? "Untitled"
        b.subtitle = v.subtitle ?? ""
        b.authors = v.authors ?? []
        b.publishers = names
        b.publisher = publisher
        b.imprint = imprint
        b.pages = v.pageCount
        b.isbn13 = ids["ISBN_13"] ?? ""
        b.isbn10 = ids["ISBN_10"] ?? ""
        b.publishedDate = v.publishedDate ?? ""
        b.language = v.language ?? ""
        b.description = Self.stripHTML(v.description ?? "")
        b.subjects = Array((v.categories ?? []).prefix(8))
        b.coverURL = Self.googleCover(v.imageLinks, large: true)
        return b
    }

    /// Open Library editions often lack page counts or publishers; fill them from Google Books by ISBN.
    private func fillGaps(_ book: CatalogBook) async -> CatalogBook {
        let isbn = book.isbn13.isEmpty ? book.isbn10 : book.isbn13
        guard !isbn.isEmpty, book.pages == nil || book.publisher.isEmpty || book.description.isEmpty || book.coverURL.isEmpty else { return book }
        guard let response: GBSearch = try? await get(googleURL("volumes", [URLQueryItem(name: "q", value: "isbn:\(isbn)"), URLQueryItem(name: "maxResults", value: "1")])),
              let item = response.items?.first else { return book }
        let g = fromGoogle(item)
        var out = book
        if out.pages == nil { out.pages = g.pages }
        if out.publisher.isEmpty { out.publisher = g.publisher; out.imprint = g.imprint; out.publishers = g.publishers }
        if out.description.isEmpty { out.description = g.description }
        if out.coverURL.isEmpty { out.coverURL = g.coverURL }
        if out.publishedDate.isEmpty { out.publishedDate = g.publishedDate }
        return out
    }

    // MARK: Helpers

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try decoder.decode(T.self, from: data)
    }

    private func googleURL(_ path: String, _ items: [URLQueryItem]) -> URL {
        var c = URLComponents(string: "https://www.googleapis.com/books/v1/\(path)")!
        var query = items
        if !googleAPIKey.isEmpty { query.append(URLQueryItem(name: "key", value: googleAPIKey)) }
        c.queryItems = query.isEmpty ? nil : query
        return c.url!
    }

    private func score(_ b: CatalogBook) -> Int {
        (b.language == "eng" ? 4 : b.language.isEmpty ? 1 : 0) + (b.publisher.isEmpty ? 0 : 2) + (b.pages == nil ? 0 : 2)
            + (b.isbn13.isEmpty && b.isbn10.isEmpty ? 0 : 2) + (b.coverURL.isEmpty ? 0 : 1)
    }

    static func olCover(_ id: Int?, size: String) -> String {
        guard let id, id > 0 else { return "" }
        return "https://covers.openlibrary.org/b/id/\(id)-\(size).jpg"
    }

    static func googleCover(_ links: GBVolume.ImageLinks?, large: Bool = false) -> String {
        guard let links else { return "" }
        let url = large ? (links.large ?? links.medium ?? links.thumbnail) : (links.thumbnail ?? links.smallThumbnail)
        return (url ?? "").replacingOccurrences(of: "http://", with: "https://").replacingOccurrences(of: "&edge=curl", with: "")
    }

    static func parsePagination(_ p: String?) -> Int? {
        // "xii, 245 p." -> 245
        guard let p else { return nil }
        return p.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }.max()
    }

    static func stripHTML(_ html: String) -> String {
        html.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "</p>", with: "\n\n")
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private extension String {
    var lastPathComponent: String { split(separator: "/").last.map(String.init) ?? self }
}

private func capture<T>(_ body: () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await body()) } catch { return .failure(error) }
}

// MARK: - API payloads

struct OLSearch: Decodable {
    struct Doc: Decodable {
        let key: String
        let title: String?
        let authorName: [String]?
        let firstPublishYear: Int?
        let coverI: Int?
        let coverEditionKey: String?
        let editionCount: Int?
    }
    let docs: [Doc]
}

struct OLEditions: Decodable { let entries: [OLEdition] }

struct OLEdition: Decodable {
    struct Ref: Decodable { let key: String }
    let key: String
    let title: String?
    let subtitle: String?
    let publishers: [String]?
    let numberOfPages: Int?
    let pagination: String?
    let isbn13: [String]?
    let isbn10: [String]?
    let publishDate: String?
    let languages: [Ref]?
    let physicalFormat: String?
    let covers: [Int]?
}

struct OLWork: Decodable {
    /// Open Library stores descriptions as either a plain string or {"type": ..., "value": "..."}.
    struct Text: Decodable {
        let text: String
        private struct Typed: Decodable { let value: String }
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) { text = s } else { text = try c.decode(Typed.self).value }
        }
    }
    let description: Text?
    let subjects: [String]?
}

struct GBSearch: Decodable { let items: [GBVolume]? }

struct GBVolume: Decodable {
    struct Identifier: Decodable { let type: String; let identifier: String }
    struct ImageLinks: Decodable { let smallThumbnail, thumbnail, medium, large: String? }
    struct Info: Decodable {
        let title, subtitle, publisher, publishedDate, description, language: String?
        let authors, categories: [String]?
        let pageCount: Int?
        let industryIdentifiers: [Identifier]?
        let imageLinks: ImageLinks?
    }
    let id: String
    let volumeInfo: Info
}
