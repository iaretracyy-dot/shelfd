import SwiftUI
import SwiftData

struct DiaryView: View {
    @Query(sort: [SortDescriptor(\LogEntry.date, order: .reverse), SortDescriptor(\LogEntry.createdAt, order: .reverse)])
    private var entries: [LogEntry]

    private struct MonthGroup: Identifiable {
        let month: Date
        let entries: [LogEntry]
        var id: Date { month }
    }

    private var months: [MonthGroup] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: entries.filter { $0.book != nil }) {
            calendar.date(from: calendar.dateComponents([.year, .month], from: $0.date)) ?? $0.date
        }
        return grouped.keys.sorted(by: >).map { MonthGroup(month: $0, entries: grouped[$0]!) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if entries.isEmpty {
                    ContentUnavailableView("Your diary is empty", systemImage: "book.closed",
                                           description: Text("Search for a book you've read and log it."))
                } else {
                    List {
                        ForEach(months) { group in
                            Section(group.month.formatted(.dateTime.month(.wide).year())) {
                                ForEach(group.entries) { entry in
                                    if let book = entry.book {
                                        NavigationLink(value: book) { DiaryRow(entry: entry, book: book) }
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Diary")
            .navigationDestination(for: Book.self) { BookDetailView(book: $0) }
        }
    }
}

private struct DiaryRow: View {
    let entry: LogEntry
    let book: Book

    var body: some View {
        HStack(spacing: 12) {
            Text(entry.date, format: .dateTime.day())
                .font(.title3.bold())
                .foregroundStyle(.secondary)
                .frame(width: 32)
            CoverImage(url: book.coverURL, title: book.title, width: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(book.title).font(.system(.subheadline, design: .serif).weight(.semibold)).lineLimit(2)
                HStack(spacing: 6) {
                    StarsLabel(rating: entry.rating, size: 11)
                    if entry.liked { Image(systemName: "heart.fill").font(.caption2).foregroundStyle(Color.shelfdOrange) }
                    if entry.reread { Image(systemName: "arrow.clockwise").font(.caption2).foregroundStyle(.secondary) }
                    if !entry.review.isEmpty { Image(systemName: "text.alignleft").font(.caption2).foregroundStyle(.secondary) }
                }
            }
        }
    }
}
