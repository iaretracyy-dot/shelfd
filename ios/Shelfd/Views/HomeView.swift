import SwiftUI
import SwiftData
import UniformTypeIdentifiers

struct HomeView: View {
    @Query(sort: \Book.addedAt, order: .reverse) private var books: [Book]
    @Query(sort: \LogEntry.date, order: .reverse) private var entries: [LogEntry]
    @State private var showSettings = false

    private var year: Int { Calendar.current.component(.year, from: .now) }
    private var thisYear: [LogEntry] {
        entries.filter { Calendar.current.component(.year, from: $0.date) == year && $0.book != nil }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        StatTile(value: "\(thisYear.count)", label: "books read in \(String(year))")
                        StatTile(value: thisYear.reduce(0) { $0 + ($1.book?.pages ?? 0) }.formatted(), label: "pages in \(String(year))")
                        StatTile(value: averageRating, label: "average rating")
                        StatTile(value: "\(books.filter { $0.shelf == .want }.count)", label: "want to read")
                    }

                    let reading = books.filter { $0.shelf == .reading }
                    if !reading.isEmpty {
                        SectionHeader("Currently reading")
                        BookGrid(books: reading)
                    }

                    SectionHeader("Recently logged")
                    let recent = entries.compactMap(\.book).reduce(into: [Book]()) { list, b in
                        if !list.contains(where: { $0.id == b.id }) { list.append(b) }
                    }.prefix(12)
                    if recent.isEmpty {
                        Text("Nothing logged yet. Use Search to find a book you've read.")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 120)
                    } else {
                        BookGrid(books: Array(recent))
                    }
                }
                .padding()
            }
            .navigationTitle("Shelfd")
            .navigationDestination(for: Book.self) { BookDetailView(book: $0) }
            .toolbar {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }

    private var averageRating: String {
        let rated = thisYear.filter { $0.rating > 0 }
        guard !rated.isEmpty else { return "—" }
        return (rated.reduce(0) { $0 + $1.rating } / Double(rated.count)).formatted(.number.precision(.fractionLength(1)))
    }
}

private struct StatTile: View {
    let value: String
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title.bold())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(white: 0.13), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.caption.weight(.semibold)).tracking(1).foregroundStyle(.secondary)
            Divider()
        }
    }
}

struct SettingsView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @AppStorage("googleBooksKey") private var googleKey = ""
    @State private var showImporter = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Google Books API key", text: $googleKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Optional. Open Library needs no key; a Google Books key raises the fallback search limit.")
                }
                Section {
                    if let data = try? LibraryTransfer.export(context) {
                        ShareLink(item: LibraryExportFile(data: data), preview: SharePreview("Shelfd library")) {
                            Label("Export library (JSON)", systemImage: "square.and.arrow.up")
                        }
                    }
                    Button { showImporter = true } label: {
                        Label("Import from website export", systemImage: "square.and.arrow.down")
                    }
                } header: {
                    Text("Your data")
                } footer: {
                    Text(message ?? "Same format as the Shelfd website's Export, so you can move your library between them.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json]) { result in
                do {
                    let url = try result.get()
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let (books, logs) = try LibraryTransfer.importArchive(Data(contentsOf: url), into: context)
                    message = "Imported \(books) books and \(logs) diary entries."
                } catch {
                    message = "Import failed: \(error.localizedDescription)"
                }
            }
        }
    }
}
