import SwiftUI
import WidgetKit

struct ContinueReadingEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct ContinueReadingProvider: TimelineProvider {
    func placeholder(in context: Context) -> ContinueReadingEntry {
        ContinueReadingEntry(date: .now, snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (ContinueReadingEntry) -> Void) {
        completion(ContinueReadingEntry(date: .now, snapshot: WidgetSnapshotStore.loadSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ContinueReadingEntry>) -> Void) {
        // The app republishes + calls reloadAllTimelines(); re-read at most hourly as a fallback.
        let entry = ContinueReadingEntry(date: .now, snapshot: WidgetSnapshotStore.loadSnapshot())
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(3600))))
    }
}

struct ContinueReadingWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ContinueReadingEntry

    var body: some View {
        Group {
            if let book = entry.snapshot?.continueReading {
                VStack(alignment: .leading, spacing: 4) {
                    Text(book.title)
                        .font(.system(size: 13, weight: .bold))
                        .lineLimit(2)
                        .foregroundColor(EinkColorPalette.text)
                    ProgressView(value: Double(book.progressPct), total: 100)
                        .tint(EinkColorPalette.accent)
                    Text("\(book.progressPct)%")
                        .font(.system(size: 11))
                        .foregroundColor(EinkColorPalette.muted)
                }
                .widgetURL(URL(string: "readest://book/\(book.hash)"))
            } else {
                Text("Open a book to start reading")
                    .font(.system(size: 12))
                    .foregroundColor(EinkColorPalette.muted)
                    .widgetURL(URL(string: "readest://library"))
            }
        }
        .padding(10)
        .widgetCard()
    }
}

struct ContinueReadingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ContinueReadingWidget", provider: ContinueReadingProvider()) { entry in
            ContinueReadingWidgetView(entry: entry)
        }
        .configurationDisplayName("Continue Reading")
        .description("Resume your most recent book")
        .supportedFamilies([.systemSmall])
    }
}
