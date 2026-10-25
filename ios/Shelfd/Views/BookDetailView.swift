import SwiftUI
import SwiftData

/// A book in the user's library: shelf, details, and every time they've logged it.
struct BookDetailView: View {
    @Bindable var book: Book

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var showLog = false
    @State private var editingEntry: LogEntry?
    @State private var showEdit = false
    @State private var confirmRemove = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 16) {
                    CoverImage(url: book.coverURL, title: book.title, width: 120)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(book.title).font(.system(.title2, design: .serif).bold())
                        if !book.subtitle.isEmpty {
                            Text(book.subtitle).font(.system(.subheadline, design: .serif)).foregroundStyle(.secondary)
                        }
                        Text("by \(book.authorLine)").font(.subheadline.weight(.semibold))
                        StarsLabel(rating: book.latestRating, size: 14)
                    }
                }

                Button { showLog = true } label: {
                    Label(book.logs.isEmpty ? "Log this book" : "Log again", systemImage: "plus").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Picker("Shelf", selection: $book.shelf) {
                    ForEach(Shelf.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)

                BookFactsView(book: book.asCatalogBook)

                if !book.logs.isEmpty {
                    Text("YOUR READS").font(.caption.weight(.semibold)).tracking(1).foregroundStyle(.secondary).padding(.top, 8)
                    ForEach(book.sortedLogs) { entry in
                        Button { editingEntry = entry } label: { LogRow(entry: entry) }
                            .buttonStyle(.plain)
                        Divider()
                    }
                }

                if !book.bookDescription.isEmpty {
                    Text("ABOUT").font(.caption.weight(.semibold)).tracking(1).foregroundStyle(.secondary).padding(.top, 8)
                    Text(book.bookDescription).font(.callout).foregroundStyle(.secondary)
                }
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Menu {
                Button("Edit details", systemImage: "pencil") { showEdit = true }
                Button("Remove from library", systemImage: "trash", role: .destructive) { confirmRemove = true }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
        .sheet(isPresented: $showLog) {
            LogEntrySheet(title: book.title, authors: book.authors, coverURL: book.coverURL, existing: nil,
                          defaultReread: !book.logs.isEmpty) { $0.insert(for: book, in: context) }
        }
        .sheet(item: $editingEntry) { entry in
            LogEntrySheet(title: book.title, authors: book.authors, coverURL: book.coverURL, existing: entry,
                          onDelete: { context.delete(entry) }) { $0.apply(to: entry) }
        }
        .sheet(isPresented: $showEdit) {
            EditDetailsSheet(book: book.asCatalogBook) { book.apply($0) }
        }
        .confirmationDialog("Remove “\(book.title)” and its diary entries?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                dismiss()
                context.delete(book)
            }
        }
    }
}

struct LogRow: View {
    let entry: LogEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(entry.date, format: .dateTime.day().month(.abbreviated).year()).font(.subheadline.bold())
                StarsLabel(rating: entry.rating)
                if entry.liked { Image(systemName: "heart.fill").font(.caption).foregroundStyle(Color.shelfdOrange) }
                if entry.reread { Image(systemName: "arrow.clockwise").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            if !entry.review.isEmpty {
                Text(entry.review).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.leading)
            }
        }
        .contentShape(Rectangle())
    }
}
