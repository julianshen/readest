import SwiftUI
import WidgetKit

struct NextInSeriesEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct NextInSeriesProvider: TimelineProvider {
    func placeholder(in context: Context) -> NextInSeriesEntry {
        NextInSeriesEntry(date: .now, snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (NextInSeriesEntry) -> Void) {
        completion(NextInSeriesEntry(date: .now, snapshot: WidgetSnapshotStore.loadSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NextInSeriesEntry>) -> Void) {
        let entry = NextInSeriesEntry(date: .now, snapshot: WidgetSnapshotStore.loadSnapshot())
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(3600))))
    }
}

struct NextInSeriesWidgetView: View {
    let entry: NextInSeriesEntry

    var body: some View {
        if let series = entry.snapshot?.nextInSeries {
            VStack(spacing: 4) {
                Text(series.series)
                    .font(.system(size: 12, weight: .bold))
                    .lineLimit(1)
                    .foregroundColor(EinkColorPalette.text)
                Text(series.finishedLabel)
                    .font(.system(size: 10))
                    .foregroundColor(EinkColorPalette.muted)
                Text("Start \(series.nextLabel)")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(.white)
                    .padding(.vertical, 5)
                    .padding(.horizontal, 8)
                    .background(Color(hex: 0xf5_9e_0b))
                    .cornerRadius(10)
            }
            .widgetURL(URL(string: "readest://book/\(series.nextHash)"))
        } else {
            VStack(spacing: 4) {
                Text("No series in progress")
                    .font(.system(size: 12))
                    .foregroundColor(EinkColorPalette.muted)
            }
            .widgetURL(URL(string: "readest://library"))
        }
    }
    .padding(10)
    .widgetCard()
}

struct NextInSeriesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "NextInSeriesWidget", provider: NextInSeriesProvider()) { entry in
            NextInSeriesWidgetView(entry: entry)
        }
        .configurationDisplayName("Next in Series")
        .description("Continue to the next volume of a series you finished")
        .supportedFamilies([.systemSmall])
    }
}
