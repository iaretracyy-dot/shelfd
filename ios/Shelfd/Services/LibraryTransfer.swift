import Foundation
import SwiftData
import SwiftUI
import UniformTypeIdentifiers

/// JSON export/import in the same format as the website's Settings > Export,
/// so a library can move between the browser and the phone.
enum LibraryTransfer {
    struct Archive: Codable {
        var version = 1
        var books: [String: BookRecord]
        var logs: [LogRecord]
        var exportedAt: String?
    }

    struct BookRecord: Codable {
        var id, source, workKey, editionKey, googleId, title, subtitle: String
        var authors: [String]
        var publisher, imprint: String
        var pages: Int?
        var isbn13, isbn10, publishedDate, firstPublished, language, format, description: String
        var subjects: [String]
        var coverUrl, shelf, addedAt: String

        // The web app stores missing values as "" (even for pages), so decode leniently.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            func str(_ k: CodingKeys) -> String { (try? c.decodeIfPresent(String.self, forKey: k)) ?? "" }
            func list(_ k: CodingKeys) -> [String] { (try? c.decodeIfPresent([String].self, forKey: k)) ?? [] }
            id = str(.id); source = str(.source); workKey = str(.workKey); editionKey = str(.editionKey)
            googleId = str(.googleId); title = str(.title); subtitle = str(.subtitle); authors = list(.authors)
            publisher = str(.publisher); imprint = str(.imprint)
            pages = (try? c.decodeIfPresent(Int.self, forKey: .pages)) ?? Int(str(.pages))
            isbn13 = str(.isbn13); isbn10 = str(.isbn10); publishedDate = str(.publishedDate)
            firstPublished = str(.firstPublished); language = str(.language); format = str(.format)
            description = str(.description); subjects = list(.subjects); coverUrl = str(.coverUrl)
            shelf = str(.shelf); addedAt = str(.addedAt)
        }

        init(_ b: Book) {
            id = b.id; source = b.source; workKey = b.workKey; editionKey = b.editionKey; googleId = b.googleId
            title = b.title; subtitle = b.subtitle; authors = b.authors; publisher = b.publisher; imprint = b.imprint
            pages = b.pages; isbn13 = b.isbn13; isbn10 = b.isbn10; publishedDate = b.publishedDate
            firstPublished = b.firstPublished; language = b.language; format = b.format; description = b.bookDescription
            subjects = b.subjects; coverUrl = b.coverURL; shelf = b.shelfRaw; addedAt = iso.string(from: b.addedAt)
        }

        var catalogBook: CatalogBook {
            CatalogBook(source: source, workKey: workKey, editionKey: editionKey, googleId: googleId, title: title,
                        subtitle: subtitle, authors: authors, publisher: publisher, imprint: imprint, pages: pages,
                        isbn13: isbn13, isbn10: isbn10, publishedDate: publishedDate, firstPublished: firstPublished,
                        language: language, format: format, description: description, subjects: subjects, coverURL: coverUrl)
        }
    }

    struct LogRecord: Codable {
        var id, bookId, date: String
        var rating: Double
        var liked, reread: Bool
        var review, createdAt: String
    }

    static let iso = ISO8601DateFormatter()
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    /// The web app writes timestamps with milliseconds ("2026-10-25T10:00:00.000Z").
    static func instant(_ s: String) -> Date? { iso.date(from: s) ?? isoFractional.date(from: s) }
    /// Diary dates are calendar days ("2026-10-25"), not instants.
    static let day: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func export(_ context: ModelContext) throws -> Data {
        let books = try context.fetch(FetchDescriptor<Book>())
        let logs = books.flatMap { book in
            book.logs.map {
                LogRecord(id: $0.id, bookId: book.id, date: day.string(from: $0.date), rating: $0.rating, liked: $0.liked,
                          reread: $0.reread, review: $0.review, createdAt: iso.string(from: $0.createdAt))
            }
        }
        let archive = Archive(books: Dictionary(uniqueKeysWithValues: books.map { ($0.id, BookRecord($0)) }),
                              logs: logs, exportedAt: iso.string(from: .now))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(archive)
    }

    /// Merges an export into the library. Returns (books, entries) imported.
    @discardableResult
    static func importArchive(_ data: Data, into context: ModelContext) throws -> (Int, Int) {
        let archive = try JSONDecoder().decode(Archive.self, from: data)
        var bookCount = 0, logCount = 0
        for (id, record) in archive.books where context.book(withID: id) == nil {
            let book = Book(id: id, from: record.catalogBook, shelf: Shelf(rawValue: record.shelf) ?? .want,
                            addedAt: instant(record.addedAt) ?? .now)
            context.insert(book)
            bookCount += 1
        }
        let existingLogIDs = Set(try context.fetch(FetchDescriptor<LogEntry>()).map(\.id))
        for record in archive.logs where !existingLogIDs.contains(record.id) {
            guard let book = context.book(withID: record.bookId), let date = day.date(from: record.date) else { continue }
            let entry = LogEntry(id: record.id, date: date, rating: record.rating, liked: record.liked, reread: record.reread,
                                 review: record.review, createdAt: instant(record.createdAt) ?? .now)
            entry.book = book
            context.insert(entry)
            logCount += 1
        }
        try context.save()
        return (bookCount, logCount)
    }
}

/// Lets ShareLink hand the export to Files, AirDrop, Mail, etc.
struct LibraryExportFile: Transferable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .json) { $0.data }
            .suggestedFileName("shelfd-export.json")
    }
}
