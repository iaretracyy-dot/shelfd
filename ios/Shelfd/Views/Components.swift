import SwiftUI

struct CoverImage: View {
    let url: String
    let title: String
    var width: CGFloat = 70

    var body: some View {
        AsyncImage(url: URL(string: url)) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                ZStack {
                    Color(white: 0.2)
                    Text(title)
                        .font(.system(size: max(9, width / 9), design: .serif).italic())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(4)
                }
            }
        }
        .frame(width: width, height: width * 1.5)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(.white.opacity(0.1)))
        .accessibilityHidden(true)
    }
}

/// Read-only star display, e.g. ★★★½
struct StarsLabel: View {
    let rating: Double
    var size: CGFloat = 12

    var body: some View {
        if rating > 0 {
            HStack(spacing: 1) {
                ForEach(1...5, id: \.self) { n in
                    let value = Double(n)
                    if rating >= value {
                        Image(systemName: "star.fill")
                    } else if rating >= value - 0.5 {
                        Image(systemName: "star.leadinghalf.filled")
                    }
                }
            }
            .font(.system(size: size))
            .foregroundStyle(Color.shelfdGreen)
            .accessibilityLabel("\(rating.formatted()) stars")
        }
    }
}

/// Letterboxd-style half-star input: tap or drag across the stars; tap the same value to clear.
struct StarRatingInput: View {
    @Binding var rating: Double
    var size: CGFloat = 36

    var body: some View {
        HStack(spacing: 4) {
            ForEach(1...5, id: \.self) { n in
                let value = Double(n)
                Image(systemName: rating >= value ? "star.fill" : rating >= value - 0.5 ? "star.leadinghalf.filled" : "star")
                    .foregroundStyle(rating >= value - 0.5 ? Color.shelfdGreen : Color.secondary)
            }
        }
        .font(.system(size: size))
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { rating = value(at: $0.location.x, width: geo.size.width) }
                            .onEnded { g in
                                // A tap (no drag) on the current value clears the rating.
                                if abs(g.translation.width) < 2, value(at: g.startLocation.x, width: geo.size.width) == lastTapped {
                                    rating = 0
                                    lastTapped = -1
                                } else {
                                    lastTapped = rating
                                }
                            }
                    )
            }
        }
        .sensoryFeedback(.selection, trigger: rating)
        .accessibilityElement()
        .accessibilityLabel("Rating")
        .accessibilityValue(rating == 0 ? "None" : "\(rating.formatted()) stars")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: rating = min(5, rating + 0.5)
            case .decrement: rating = max(0, rating - 0.5)
            @unknown default: break
            }
        }
    }

    @State private var lastTapped: Double = -1

    private func value(at x: CGFloat, width: CGFloat) -> Double {
        let raw = Double(x / width) * 5
        return min(5, max(0.5, (raw * 2).rounded(.up) / 2))
    }
}

/// The autofilled book facts: author, publisher, imprint, pages, etc.
struct BookFactsView: View {
    let book: CatalogBook

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            row("Author", book.authors.joined(separator: ", "))
            row("Publisher", book.publisher)
            row("Imprint", book.imprint)
            row("Pages", book.pages.map(String.init) ?? "")
            row("Published", book.publishedDate)
            row("First published", book.firstPublished)
            row("ISBN-13", book.isbn13)
            row("ISBN-10", book.isbn10)
            row("Format", book.format)
        }
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String) -> some View {
        if !value.isEmpty || ["Publisher", "Imprint", "Pages"].contains(label) {
            GridRow {
                Text(label.uppercased())
                    .font(.caption2.weight(.semibold))
                    .tracking(1)
                    .foregroundStyle(.secondary)
                Text(value.isEmpty ? "—" : value)
                    .font(.subheadline)
                    .textSelection(.enabled)
            }
        }
    }
}

/// Lets the user correct anything the catalog got wrong.
struct EditDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var book: CatalogBook
    let onSave: (CatalogBook) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Book") {
                    TextField("Title", text: $book.title)
                    TextField("Subtitle", text: $book.subtitle)
                    TextField("Authors (comma separated)", text: Binding(
                        get: { book.authors.joined(separator: ", ") },
                        set: { book.authors = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
                    ))
                }
                Section("Edition") {
                    TextField("Publisher", text: $book.publisher)
                    TextField("Imprint", text: $book.imprint)
                    TextField("Pages", value: $book.pages, format: .number).keyboardType(.numberPad)
                    TextField("Published", text: $book.publishedDate)
                    TextField("ISBN-13", text: $book.isbn13).keyboardType(.numberPad)
                    TextField("ISBN-10", text: $book.isbn10)
                    TextField("Format", text: $book.format)
                }
            }
            .navigationTitle("Edit details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(book); dismiss() }
                }
            }
        }
    }
}
