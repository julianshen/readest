package com.readest.native_bridge

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import org.json.JSONObject
import java.io.File

data class ReadingWidgetSnapshot(val json: JSONObject) {
    val style: String get() = json.optString("style", "default")
    val continueReading: JSONObject? get() = json.optJSONObject("continueReading")
    val streak: JSONObject? get() = json.optJSONObject("streak")
    val nextInSeries: JSONObject? get() = json.optJSONObject("nextInSeries")
}

/**
 * Dumb persistence for widget snapshots: JSON in SharedPreferences, covers as
 * PNGs under cacheDir/widget-covers/. Providers read from here; the plugin
 * command writes through [write].
 */
class ReadingWidgetStore private constructor(
    private val prefs: SharedPreferences,
    private val coverDir: File,
) {

    var snapshot: ReadingWidgetSnapshot? = null
        private set

    fun reload() {
        snapshot = parseSnapshot(prefs.getString(KEY_SNAPSHOT, null))
    }

    /** Returns a downsampled cover bitmap for a hash, or null if missing/corrupt. */
    fun loadCover(hash: String, reqWidth: Int): Bitmap? {
        val file = File(coverDir, "$hash.png")
        if (!file.exists()) return null
        return BitmapFactory.decodeFile(file.absolutePath)
            ?: run {
                file.delete() // corrupt — let the next publish heal it
                null
            }
    }

    companion object {
        private const val PREFS_NAME = "reading_widgets"
        private const val KEY_SNAPSHOT = "snapshot"
        private const val COVER_DIR = "widget-covers"

        /** Pure JSON parsing — Context-free so unit tests can exercise it directly. */
        fun parseSnapshot(raw: String?): ReadingWidgetSnapshot? =
            raw?.let { rawJson ->
                runCatching { ReadingWidgetSnapshot(JSONObject(rawJson)) }.getOrNull()
            }

        fun from(context: Context): ReadingWidgetStore =
            ReadingWidgetStore(
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
                File(context.cacheDir, COVER_DIR).apply { mkdirs() },
            )

        /**
         * Called from NativeBridgePlugin: persists the snapshot JSON and decodes
         * base64 covers into cache files. Commit-synchronous so providers reading
         * right after always see the new data.
         */
        fun write(context: Context, snapshotJson: String, covers: Map<String, ByteArray>) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val dir = File(context.cacheDir, COVER_DIR).apply { mkdirs() }
            covers.forEach { (hash, bytes) ->
                runCatching { File(dir, "$hash.png").writeBytes(bytes) }
            }
            prefs.edit().putString(KEY_SNAPSHOT, snapshotJson).commit()
        }
    }
}
