import SwiftUI
import SwiftData

struct LibraryView: View {
    @Query(sort: \Book.addedAt, order: .reverse) private var books: [Book]
    @State private var shelf: Shelf? = nil
    @State private var sort = LibrarySort.added

    enum LibrarySort: String, CaseIterable, Identifiable {
        case added = "Recently added", title = "Title", author = "Author", rating = "Rating"
        var id: String { rawValue }
    }

    private var visible: [Book] {
        let filtered = shelf.map { s in books.filter { $0.shelf == s } } ?? books
        switch sort {
        case .added: return filtered
        case .title: return filtered.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .author: return filtered.sorted { ($0.authors.first ?? "").localizedCaseInsensitiveCompare($1.authors.first ?? "") == .orderedAscending }
        case .rating: return filtered.sorted { $0.latestRating > $1.latestRating }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Picker("Shelf", selection: $shelf) {
                    Text("All").tag(Shelf?.none)
                    ForEach(Shelf.allCases) { Text($0 == .dnf ? "DNF" : $0.title).tag(Shelf?.some($0)) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)

                if visible.isEmpty {
                    ContentUnavailableView("No books here yet", systemImage: "books.vertical").padding(.top, 60)
                } else {
                    BookGrid(books: visible).padding()
                }
            }
            .navigationTitle("Library")
            .navigationDestination(for: Book.self) { BookDetailView(book: $0) }
            .toolbar {
                Menu {
                    Picker("Sort", selection: $sort) {
                        ForEach(LibrarySort.allCases) { Text($0.rawValue).tag($0) }
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
            }
        }
    }
}

struct BookGrid: View {
    let books: [Book]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 12)], spacing: 16) {
            ForEach(books) { book in
                NavigationLink(value: book) {
                    VStack(alignment: .leading, spacing: 4) {
                        CoverImage(url: book.coverURL, title: book.title, width: 100)
                        StarsLabel(rating: book.latestRating, size: 10)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(book.title) by \(book.authorLine)")
            }
        }
    }
}
