import SwiftUI
import WidgetKit

@main
struct ReadestWidgetsBundle: WidgetBundle {
    var body: some Widget {
        ContinueReadingWidget()
        StreakWidget()
        NextInSeriesWidget()
    }
}
