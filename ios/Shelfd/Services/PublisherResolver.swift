import Foundation

/// Works out publisher + imprint from catalog publisher names using the shared
/// imprints.json table (imprint -> parent house). Mirrors web/imprints.js.
final class PublisherResolver {
    static let shared = PublisherResolver()

    private var imprints: [String: (imprint: String, parent: String)] = [:]
    private var parents: [String: String] = [:]

    init(bundle: Bundle = .main) {
        guard let url = bundle.url(forResource: "imprints", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let table = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        for (parent, value) in table where !parent.hasPrefix("_") {
            guard let names = value as? [String] else { continue }
            parents[Self.normalize(parent)] = parent
            for name in names { imprints[Self.normalize(name)] = (name, parent) }
        }
    }

    static func normalize(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: "&", with: " and ")
            .replacingOccurrences(of: "[.,'’\"()\\[\\]]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\b(the|inc|ltd|llc|co|company|corp|group|publishing|publishers|publisher|books|book)\\b",
                                  with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    private static func clean(_ name: String) -> String {
        name.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " ,;:"))
    }

    private func lookup(_ name: String) -> (publisher: String, imprint: String)? {
        let n = Self.normalize(name)
        guard !n.isEmpty else { return nil }
        if let parent = parents[n] { return (parent, "") }
        if let hit = imprints[n] {
            return (hit.parent, Self.normalize(hit.parent) == n ? "" : Self.clean(name))
        }
        // "Vintage Books, a division of Random House" -> longest known imprint prefix
        let best = imprints
            .filter { $0.key.count >= 4 && n.hasPrefix($0.key + " ") }
            .max { $0.key.count < $1.key.count }
        return best.map { ($0.value.parent, $0.value.imprint) }
    }

    func resolve(_ names: [String]) -> (publisher: String, imprint: String) {
        let list = names.map(Self.clean).filter { !$0.isEmpty }
        let hits = list.compactMap(lookup)
        return hits.first { !$0.imprint.isEmpty } ?? hits.first ?? (publisher: list.first ?? "", imprint: "")
    }
}
