import SwiftUI
import SwiftData

@main
struct ShelfdApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .tint(.shelfdGreen)
                .preferredColorScheme(.dark)
        }
        .modelContainer(for: [Book.self, LogEntry.self])
    }
}

extension Color {
    static let shelfdGreen = Color(red: 0, green: 0.75, blue: 0.19)
    static let shelfdOrange = Color(red: 1, green: 0.5, blue: 0)
    static let shelfdBlue = Color(red: 0.25, green: 0.74, blue: 0.96)
}

struct RootView: View {
    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "house") }
            SearchView()
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
            DiaryView()
                .tabItem { Label("Diary", systemImage: "book.closed") }
            LibraryView()
                .tabItem { Label("Library", systemImage: "books.vertical") }
        }
    }
}
