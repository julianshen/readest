import Foundation
import SwiftUI
import WidgetKit

// MARK: - Snapshot model (decoded from the App Group store)

struct WidgetSnapshot: Decodable {
    struct ContinueReading: Decodable {
        let hash: String
        let title: String
        let progressPct: Int
        let chapterLabel: String?
    }

    struct Streak: Decodable {
        let days: Int
        let minutesToday: Int
        let week: [Int]?
    }

    struct NextInSeries: Decodable {
        let series: String
        let finishedLabel: String
        let nextHash: String
        let nextLabel: String
    }

    let style: String
    let continueReading: ContinueReading?
    let streak: Streak?
    let nextInSeries: NextInSeries?
}

enum WidgetSnapshotStore {
    static let appGroupId = "group.com.bilingify.readest"

    static func loadSnapshot() -> WidgetSnapshot? {
        guard let groupDir = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupId)
        else { return nil }
        let url = groupDir.appendingPathComponent("widget-store/snapshot.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }

    static var isEink: Bool { loadSnapshot()?.style == "eink" }
}

// MARK: - Shared styling

extension View {
    /// E-ink variant swaps the card to a flat surface with a crisp 1px border.
    @ViewBuilder
    func widgetCard() -> some View {
        if WidgetSnapshotStore.isEink {
            background(Color.white)
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(Color(hex: 0x11_18_27), lineWidth: 1)
                )
        } else {
            background(Color(hex: 0xFF_FF_FF))
                .cornerRadius(14)
        }
    }
}

struct EinkColorPalette {
    static let text = Color(hex: 0x11_18_27)
    static let muted = Color(hex: 0x6b_72_80)
    static let accent = Color(hex: 0x05_96_69)
}

extension Color {
    init(hex: UInt) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}
