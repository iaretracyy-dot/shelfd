import SwiftUI
import SwiftData

struct SearchView: View {
    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && results.isEmpty {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    ContentUnavailableView("Couldn't search", systemImage: "wifi.exclamationmark", description: Text(errorMessage))
                } else if results.isEmpty {
                    if query.isEmpty {
                        ContentUnavailableView("Find a book", systemImage: "magnifyingglass",
                                               description: Text("Search by title, author or ISBN, then pick the book you read."))
                    } else if !isLoading {
                        ContentUnavailableView.search(text: query)
                    }
                } else {
                    List(results) { result in
                        NavigationLink(value: result) { SearchResultRow(result: result) }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Search")
            .navigationDestination(for: SearchResult.self) { BookPreviewView(result: $0) }
            .navigationDestination(for: Book.self) { BookDetailView(book: $0) }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Title, author or ISBN")
            .onSubmit(of: .search) { runSearch(immediately: true) }
            .onChange(of: query) { runSearch(immediately: false) }
        }
    }

    /// Debounced search-as-you-type; Return searches immediately.
    private func runSearch(immediately: Bool) {
        searchTask?.cancel()
        let q = query
        guard q.trimmingCharacters(in: .whitespaces).count >= 2 else {
            results = []
            errorMessage = nil
            return
        }
        searchTask = Task {
            if !immediately { try? await Task.sleep(for: .milliseconds(450)) }
            guard !Task.isCancelled else { return }
            isLoading = true
            defer { isLoading = false }
            do {
                let found = try await CatalogService.shared.search(q)
                guard !Task.isCancelled else { return }
                results = found
                errorMessage = nil
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = "The book catalogs could not be reached. Check your connection and try again."
            }
        }
    }
}

private struct SearchResultRow: View {
    let result: SearchResult

    var body: some View {
        HStack(spacing: 12) {
            CoverImage(url: result.coverURL, title: result.title, width: 46)
            VStack(alignment: .leading, spacing: 2) {
                Text(result.title).font(.system(.body, design: .serif).weight(.semibold))
                    + Text(result.year.isEmpty ? "" : "  \(result.year)").foregroundStyle(.secondary)
                Text(result.authorLine).font(.subheadline).foregroundStyle(.secondary)
                if result.editionCount > 1 {
                    Text("\(result.editionCount) editions").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
