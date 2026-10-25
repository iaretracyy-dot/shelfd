import SwiftUI
import SwiftData

/// Shown after the user selects a search result: loads the full book info
/// (author, publisher, imprint, pages…) and lets them log or shelve it.
struct BookPreviewView: View {
    let result: SearchResult

    @Environment(\.modelContext) private var context
    @State private var book: CatalogBook?
    @State private var editions: [CatalogBook] = []
    @State private var selectedEdition = ""
    @State private var loadError: String?
    @State private var showLog = false
    @State private var showEdit = false
    @State private var savedBook: Book?

    var body: some View {
        Group {
            if let book {
                content(book)
            } else if let loadError {
                ContentUnavailableView("Couldn't load this book", systemImage: "exclamationmark.triangle", description: Text(loadError))
            } else {
                ProgressView("Loading book details…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .navigationDestination(item: $savedBook) { BookDetailView(book: $0) }
    }

    private func content(_ book: CatalogBook) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 16) {
                    CoverImage(url: book.coverURL, title: book.title, width: 120)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(book.title).font(.system(.title2, design: .serif).bold())
                        if !book.subtitle.isEmpty {
                            Text(book.subtitle).font(.system(.subheadline, design: .serif)).foregroundStyle(.secondary)
                        }
                        Text("by \(book.authors.isEmpty ? "Unknown author" : book.authors.joined(separator: ", "))")
                            .font(.subheadline.weight(.semibold))
                        if let owned = context.libraryBook(matching: book) {
                            Label("In your library · \(owned.shelf.title)", systemImage: "checkmark.circle.fill")
                                .font(.caption).foregroundStyle(Color.shelfdGreen)
                        }
                    }
                }

                Button { showLog = true } label: {
                    Label("Log this book", systemImage: "plus").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                HStack {
                    shelfButton(.reading, book)
                    shelfButton(.want, book)
                }

                if editions.count > 1 {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Edition").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Picker("Edition", selection: $selectedEdition) {
                            ForEach(editions, id: \.editionKey) { e in
                                Text(editionLabel(e)).tag(e.editionKey)
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: selectedEdition) { switchEdition(to: selectedEdition) }
                        Text("Pick the copy you read for the right publisher and page count.")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }

                BookFactsView(book: book)

                Button("Correct details", systemImage: "pencil") { showEdit = true }
                    .font(.subheadline)

                if !book.description.isEmpty {
                    Divider()
                    Text(book.description).font(.callout).foregroundStyle(.secondary)
                }
            }
            .padding()
        }
        .sheet(isPresented: $showLog) {
            LogEntrySheet(title: book.title, authors: book.authors, coverURL: book.coverURL, existing: nil,
                          defaultReread: !(context.libraryBook(matching: book)?.logs.isEmpty ?? true)) { draft in
                let saved = context.saveBook(book, shelf: .read)
                draft.insert(for: saved, in: context)
                savedBook = saved
            }
        }
        .sheet(isPresented: $showEdit) {
            EditDetailsSheet(book: book) { self.book = $0 }
        }
    }

    private func shelfButton(_ shelf: Shelf, _ book: CatalogBook) -> some View {
        Button(shelf.title) {
            savedBook = context.saveBook(book, shelf: shelf)
        }
        .buttonStyle(.bordered)
        .frame(maxWidth: .infinity)
    }

    private func editionLabel(_ e: CatalogBook) -> String {
        [e.imprint.isEmpty ? (e.publisher.isEmpty ? "Unknown publisher" : e.publisher) : e.imprint,
         e.publishedDate, e.pages.map { "\($0) pp" } ?? "", e.format]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private func load() async {
        guard book == nil else { return }
        do {
            let details = try await CatalogService.shared.details(for: result)
            editions = details.editions.filter { !$0.editionKey.isEmpty }
            selectedEdition = details.book.editionKey
            book = details.book
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func switchEdition(to key: String) {
        guard let current = book, key != current.editionKey, var picked = editions.first(where: { $0.editionKey == key }) else { return }
        picked.authors = current.authors
        if picked.description.isEmpty { picked.description = current.description }
        Task { book = await CatalogService.shared.select(edition: picked) }
    }
}
