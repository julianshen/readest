import SwiftUI
import WidgetKit

struct StreakEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct StreakProvider: TimelineProvider {
    func placeholder(in context: Context) -> StreakEntry {
        StreakEntry(date: .now, snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (StreakEntry) -> Void) {
        completion(StreakEntry(date: .now, snapshot: WidgetSnapshotStore.loadSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StreakEntry>) -> Void) {
        let entry = StreakEntry(date: .now, snapshot: WidgetSnapshotStore.loadSnapshot())
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(1800))))
    }
}

struct StreakWidgetView: View {
    let entry: StreakEntry

    private var weekBars: [Int] {
        // Pad to exactly 7 values, oldest first.
        let week = entry.snapshot?.streak?.week ?? []
        return Array(repeating: 0, count: max(0, 7 - week.count)) + suffix7(week)
    }

    private func suffix7(_ week: [Int]) -> [Int] {
        week.count > 7 ? Array(week.suffix(7)) : week
    }

    var body: some View {
        VStack(spacing: 6) {
            Text("\(entry.snapshot?.streak?.days ?? 0) days")
                .font(.system(size: 20, weight: .bold))
                .foregroundColor(EinkColorPalette.text)
            HStack(spacing: 3) {
                ForEach(weekBars.indices, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(
                            weekBars[index] > 0
                                ? EinkColorPalette.accent
                                : Color(hex: 0xd1_d5_db)
                        )
                        .frame(height: CGFloat(6 + min(18, weekBars[index])))
                }
            }
            Text("\(entry.snapshot?.streak?.minutesToday ?? 0) min today")
                .font(.system(size: 11))
                .foregroundColor(EinkColorPalette.muted)
        }
        .padding(10)
        .widgetCard()
        .widgetURL(URL(string: "readest://library"))
    }
}

struct StreakWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "StreakWidget", provider: StreakProvider()) { entry in
            StreakWidgetView(entry: entry)
        }
        .configurationDisplayName("Reading Streak")
        .description("Your reading streak at a glance")
        .supportedFamilies([.systemSmall])
    }
}
