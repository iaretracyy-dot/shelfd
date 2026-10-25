import Foundation
import SwiftData

enum Shelf: String, CaseIterable, Identifiable, Codable {
    case want, reading, read, dnf
    var id: String { rawValue }
    var title: String {
        switch self {
        case .want: "Want to read"
        case .reading: "Reading"
        case .read: "Read"
        case .dnf: "Did not finish"
        }
    }
}

/// A book as it comes back from the catalog, before (or without) being saved.
struct CatalogBook: Hashable {
    var source = "openlibrary"
    var workKey = ""
    var editionKey = ""
    var googleId = ""
    var title = ""
    var subtitle = ""
    var authors: [String] = []
    var publishers: [String] = []
    var publisher = ""
    var imprint = ""
    var pages: Int?
    var isbn13 = ""
    var isbn10 = ""
    var publishedDate = ""
    var firstPublished = ""
    var language = ""
    var format = ""
    var description = ""
    var subjects: [String] = []
    var coverURL = ""

    /// Same id scheme as the website so exports line up.
    var libraryID: String {
        if !editionKey.isEmpty { return "ol:\(editionKey)" }
        if !googleId.isEmpty { return "gb:\(googleId)" }
        if !workKey.isEmpty { return "ol:\(workKey)" }
        return "local:\(UUID().uuidString)"
    }
}

@Model
final class Book {
    @Attribute(.unique) var id: String
    var source: String
    var workKey: String
    var editionKey: String
    var googleId: String
    var title: String
    var subtitle: String
    var authors: [String]
    var publisher: String
    var imprint: String
    var pages: Int?
    var isbn13: String
    var isbn10: String
    var publishedDate: String
    var firstPublished: String
    var language: String
    var format: String
    var bookDescription: String
    var subjects: [String]
    var coverURL: String
    var shelfRaw: String
    var addedAt: Date
    @Relationship(deleteRule: .cascade, inverse: \LogEntry.book) var logs: [LogEntry] = []

    init(id: String, from c: CatalogBook, shelf: Shelf, addedAt: Date = .now) {
        self.id = id
        source = c.source
        workKey = c.workKey
        editionKey = c.editionKey
        googleId = c.googleId
        title = c.title
        subtitle = c.subtitle
        authors = c.authors
        publisher = c.publisher
        imprint = c.imprint
        pages = c.pages
        isbn13 = c.isbn13
        isbn10 = c.isbn10
        publishedDate = c.publishedDate
        firstPublished = c.firstPublished
        language = c.language
        format = c.format
        bookDescription = c.description
        subjects = c.subjects
        coverURL = c.coverURL
        shelfRaw = shelf.rawValue
        self.addedAt = addedAt
    }

    var shelf: Shelf {
        get { Shelf(rawValue: shelfRaw) ?? .want }
        set { shelfRaw = newValue.rawValue }
    }

    var authorLine: String { authors.isEmpty ? "Unknown author" : authors.joined(separator: ", ") }
    var sortedLogs: [LogEntry] { logs.sorted { $0.date > $1.date } }
    var latestRating: Double { sortedLogs.first { $0.rating > 0 }?.rating ?? 0 }

    var asCatalogBook: CatalogBook {
        CatalogBook(source: source, workKey: workKey, editionKey: editionKey, googleId: googleId, title: title,
                    subtitle: subtitle, authors: authors, publisher: publisher, imprint: imprint, pages: pages,
                    isbn13: isbn13, isbn10: isbn10, publishedDate: publishedDate, firstPublished: firstPublished,
                    language: language, format: format, description: bookDescription, subjects: subjects, coverURL: coverURL)
    }

    func apply(_ c: CatalogBook) {
        title = c.title
        subtitle = c.subtitle
        authors = c.authors
        publisher = c.publisher
        imprint = c.imprint
        pages = c.pages
        isbn13 = c.isbn13
        isbn10 = c.isbn10
        publishedDate = c.publishedDate
        format = c.format
        language = c.language
    }
}

@Model
final class LogEntry {
    @Attribute(.unique) var id: String
    var date: Date
    var rating: Double
    var liked: Bool
    var reread: Bool
    var review: String
    var createdAt: Date
    var book: Book?

    init(id: String = UUID().uuidString, date: Date, rating: Double, liked: Bool, reread: Bool, review: String, createdAt: Date = .now) {
        self.id = id
        self.date = date
        self.rating = rating
        self.liked = liked
        self.reread = reread
        self.review = review
        self.createdAt = createdAt
    }
}

extension ModelContext {
    func book(withID id: String) -> Book? {
        var descriptor = FetchDescriptor<Book>(predicate: #Predicate { $0.id == id })
        descriptor.fetchLimit = 1
        return try? fetch(descriptor).first
    }

    /// The saved copy of this catalog book (same edition, or another edition of the same work).
    func libraryBook(matching c: CatalogBook) -> Book? {
        if let exact = book(withID: c.libraryID) { return exact }
        guard !c.workKey.isEmpty else { return nil }
        let work = c.workKey
        var descriptor = FetchDescriptor<Book>(predicate: #Predicate { $0.workKey == work })
        descriptor.fetchLimit = 1
        return try? fetch(descriptor).first
    }

    @discardableResult
    func saveBook(_ c: CatalogBook, shelf: Shelf) -> Book {
        if let existing = book(withID: c.libraryID) {
            existing.shelf = shelf
            return existing
        }
        let book = Book(id: c.libraryID, from: c, shelf: shelf)
        insert(book)
        return book
    }
}
