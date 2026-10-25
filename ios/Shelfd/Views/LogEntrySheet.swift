import SwiftUI
import SwiftData

struct LogDraft {
    var date = Date.now
    var rating = 0.0
    var liked = false
    var reread = false
    var review = ""

    func insert(for book: Book, in context: ModelContext) {
        let entry = LogEntry(date: date, rating: rating, liked: liked, reread: reread,
                             review: review.trimmingCharacters(in: .whitespacesAndNewlines))
        entry.book = book
        context.insert(entry)
        book.shelf = .read
    }

    func apply(to entry: LogEntry) {
        entry.date = date
        entry.rating = rating
        entry.liked = liked
        entry.reread = reread
        entry.review = review.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// "I read…" sheet: date, half-star rating, like, reread, review.
struct LogEntrySheet: View {
    let title: String
    let authors: [String]
    let coverURL: String
    let existing: LogEntry?
    var defaultReread = false
    var onDelete: (() -> Void)?
    let onSave: (LogDraft) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft = LogDraft()
    @State private var confirmDelete = false

    init(title: String, authors: [String], coverURL: String, existing: LogEntry?, defaultReread: Bool = false,
         onDelete: (() -> Void)? = nil, onSave: @escaping (LogDraft) -> Void) {
        self.title = title
        self.authors = authors
        self.coverURL = coverURL
        self.existing = existing
        self.defaultReread = defaultReread
        self.onDelete = onDelete
        self.onSave = onSave
        let initial = existing.map {
            LogDraft(date: $0.date, rating: $0.rating, liked: $0.liked, reread: $0.reread, review: $0.review)
        } ?? LogDraft(reread: defaultReread)
        _draft = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        CoverImage(url: coverURL, title: title, width: 50)
                        VStack(alignment: .leading) {
                            Text("I read…").font(.caption).foregroundStyle(.secondary)
                            Text(title).font(.system(.headline, design: .serif))
                            Text(authors.joined(separator: ", ")).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    DatePicker("Finished on", selection: $draft.date, in: ...Date.now, displayedComponents: .date)
                    Toggle("I've read this before", isOn: $draft.reread)
                }
                Section("Rating") {
                    HStack {
                        StarRatingInput(rating: $draft.rating)
                        Spacer()
                        Button { draft.liked.toggle() } label: {
                            Image(systemName: draft.liked ? "heart.fill" : "heart")
                                .font(.system(size: 30))
                                .foregroundStyle(draft.liked ? Color.shelfdOrange : Color.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(draft.liked ? "Liked" : "Like")
                        .sensoryFeedback(.impact, trigger: draft.liked)
                    }
                    .padding(.vertical, 4)
                }
                Section("Review") {
                    TextField("Add a review…", text: $draft.review, axis: .vertical)
                        .lineLimit(5...12)
                }
                if existing != nil, onDelete != nil {
                    Section {
                        Button("Delete entry", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .navigationTitle(existing == nil ? "Log book" : "Edit entry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(draft); dismiss() }.bold()
                }
            }
            .confirmationDialog("Delete this diary entry?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { onDelete?(); dismiss() }
            }
        }
    }
}
