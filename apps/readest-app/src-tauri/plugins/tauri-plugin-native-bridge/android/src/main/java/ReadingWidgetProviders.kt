package com.readest.native_bridge

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.view.View
import android.widget.RemoteViews

class ContinueReadingWidgetProvider : ReadingWidgetProvider()
class StreakWidgetProvider : ReadingWidgetProvider()
class NextInSeriesWidgetProvider : ReadingWidgetProvider()

open class ReadingWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        updateWidgets(context, manager, ids)
    }
}

object ReadingWidgetProviders {
    private val providers = listOf(
        ContinueReadingWidgetProvider::class.java,
        StreakWidgetProvider::class.java,
        NextInSeriesWidgetProvider::class.java,
    )

    /** Refresh every widget after a snapshot publish. */
    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context) ?: return
        providers.forEach { cls ->
            val cn = ComponentName(context, cls)
            updateWidgets(context, manager, manager.getAppWidgetIds(cn))
        }
    }

    fun updateWidgets(context: Context, manager: AppWidgetManager, ids: IntArray) {
        if (ids.isEmpty()) return
        val store = ReadingWidgetStore.from(context).apply { reload() }
        ids.forEach { id ->
            val providerClass = manager.getAppWidgetInfo(id)?.provider?.className ?: return@forEach
            val views = when (providerClass) {
                ContinueReadingWidgetProvider::class.java.name -> continueReadingViews(context, store)
                StreakWidgetProvider::class.java.name -> streakViews(context, store)
                NextInSeriesWidgetProvider::class.java.name -> nextInSeriesViews(context, store)
                else -> null
            } ?: return@forEach
            manager.updateAppWidget(id, views)
        }
    }

    private fun isEink(store: ReadingWidgetStore) = store.snapshot?.style == "eink"

    private fun rootBackground(eink: Boolean) =
        if (eink) R.drawable.w_card_bg_eink else R.drawable.w_card_bg

    private fun continueReadingViews(ctx: Context, store: ReadingWidgetStore): RemoteViews {
        val eink = isEink(store)
        val views = RemoteViews(ctx.packageName, R.layout.widget_continue_reading)
        views.setInt(R.id.w_root, "setBackgroundResource", rootBackground(eink))
        val book = store.snapshot?.continueReading

        if (book == null) {
            views.setTextViewText(R.id.w_title, ctx.getString(R.string.widget_empty_continue))
            views.setViewVisibility(R.id.w_progress, View.GONE)
            views.setViewVisibility(R.id.w_pct, View.GONE)
            views.setOnClickPendingIntent(R.id.w_root, deepLink(ctx, null))
            return views
        }

        views.setTextViewText(R.id.w_title, book.optString("title"))
        views.setViewVisibility(R.id.w_progress, View.VISIBLE)
        views.setViewVisibility(R.id.w_pct, View.VISIBLE)
        views.setProgressBar(R.id.w_progress, 100, book.optInt("progressPct"), false)
        views.setTextViewText(R.id.w_pct, ctx.getString(R.string.widget_percent, book.optInt("progressPct")))
        applyCoverOrLetter(views, R.id.w_cover, ctx, store, book.optString("coverFile"), book.optString("title"))
        views.setOnClickPendingIntent(R.id.w_root, deepLink(ctx, book.optString("hash", "")))
        return views
    }

    @SuppressLint("RemoteViewLayout")
    private fun streakViews(ctx: Context, store: ReadingWidgetStore): RemoteViews {
        val eink = isEink(store)
        val views = RemoteViews(ctx.packageName, R.layout.widget_streak)
        views.setInt(R.id.w_root, "setBackgroundResource", rootBackground(eink))
        val streak = store.snapshot?.streak

        if (streak == null) {
            views.setTextViewText(R.id.w_streak_days, ctx.getString(R.string.widget_streak_zero))
            views.setTextViewText(R.id.w_minutes_today, "")
            views.setOnClickPendingIntent(R.id.w_root, deepLink(ctx, null))
            return views
        }

        views.setTextViewText(
            R.id.w_streak_days,
            ctx.getString(R.string.widget_streak_days, streak.optInt("days")),
        )
        views.setTextViewText(
            R.id.w_minutes_today,
            ctx.getString(R.string.widget_minutes_today, streak.optInt("minutesToday")),
        )

        // 7-day mini bars: week[6] is today. Scale each bar against the max.
        val week = streak.optJSONArray("week")
        val barIds = intArrayOf(
            R.id.w_bar0, R.id.w_bar1, R.id.w_bar2, R.id.w_bar3,
            R.id.w_bar4, R.id.w_bar5, R.id.w_bar6,
        )
        var max = 1
        if (week != null) for (i in 0 until minOf(7, week.length())) {
            max = maxOf(max, week.optInt(i))
        }
        barIds.forEachIndexed { index, barId ->
            val minutes = if (week != null && index < week.length()) week.optInt(index) else 0
            views.setInt(barId, "setBackgroundResource", if (minutes > 0) R.drawable.w_bar_filled else R.drawable.w_bar_empty)
            // Height scales linearly between 6dp (floor) and 24dp (max).
            val heightDp = 6 + (18 * minutes) / max
            views.setViewLayoutParams(barId, dp(ctx, heightDp))
        }

        views.setOnClickPendingIntent(R.id.w_root, deepLink(ctx, null))
        return views
    }

    private fun nextInSeriesViews(ctx: Context, store: ReadingWidgetStore): RemoteViews {
        val eink = isEink(store)
        val views = RemoteViews(ctx.packageName, R.layout.widget_next_in_series)
        views.setInt(R.id.w_root, "setBackgroundResource", rootBackground(eink))
        val series = store.snapshot?.nextInSeries

        if (series == null) {
            views.setTextViewText(R.id.w_series, ctx.getString(R.string.widget_no_series))
            views.setTextViewText(R.id.w_finished_label, "")
            views.setViewVisibility(R.id.w_next_pill, View.GONE)
            views.setViewVisibility(R.id.w_cover, View.GONE)
            views.setOnClickPendingIntent(R.id.w_root, deepLink(ctx, null))
            return views
        }

        views.setViewVisibility(R.id.w_next_pill, View.VISIBLE)
        views.setViewVisibility(R.id.w_cover, View.VISIBLE)
        views.setTextViewText(R.id.w_series, series.optString("series"))
        views.setTextViewText(R.id.w_finished_label, series.optString("finishedLabel"))
        views.setTextViewText(R.id.w_next_pill, ctx.getString(R.string.widget_start_next, series.optString("nextLabel")))
        applyCoverOrLetter(views, R.id.w_cover, ctx, store, series.optString("coverFile"), series.optString("series"))
        views.setOnClickPendingIntent(R.id.w_root, deepLink(ctx, series.optString("nextHash", "")))
        return views
    }

    private fun applyCoverOrLetter(
        views: RemoteViews,
        viewId: Int,
        ctx: Context,
        store: ReadingWidgetStore,
        coverFile: String,
        title: String,
    ) {
        val hash = coverFile.removeSuffix(".png")
        val bmp = store.loadCover(hash, dp(ctx, 96))
            ?: letterCover(title.ifBlank { "?" })
        views.setImageViewBitmap(viewId, bmp)
    }

    /** Fallback cover: initial letter on a flat tint — no gradients, e-ink friendly. */
    private fun letterCover(initial: String): Bitmap {
        val size = 192
        val bmp = Bitmap.createBitmap(size, size * 3 / 2, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawColor(Color.rgb(229, 231, 235))
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(75, 85, 99)
            textSize = size / 2f
            typeface = Typeface.DEFAULT_BOLD
            textAlign = android.graphics.Paint.Align.CENTER
        }
        canvas.drawText(initial.take(1).uppercase(), size / 2f, size.toFloat(), paint)
        return bmp
    }

    private fun deepLink(ctx: Context, hash: String?): PendingIntent {
        val uri = Uri.parse(if (hash.isNullOrBlank()) "readest://library" else "readest://book/$hash")
        val intent = Intent(Intent.ACTION_VIEW, uri).setPackage(ctx.packageName)
        return PendingIntent.getActivity(
            ctx,
            hash?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun dp(ctx: Context, value: Int): Int =
        (value * ctx.resources.displayMetrics.density).toInt()
}
