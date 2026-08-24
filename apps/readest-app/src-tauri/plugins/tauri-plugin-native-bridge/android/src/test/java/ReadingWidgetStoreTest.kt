package com.readest.native_bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReadingWidgetStoreTest {
    @Test
    fun parseSnapshot_preservesFields() {
        val snap = ReadingWidgetStore.parseSnapshot(
            """{"version":1,"style":"eink","continueReading":{"hash":"h","progressPct":62}}""",
        )
        assertEquals("eink", snap?.style)
        assertEquals("h", snap?.continueReading?.optString("hash"))
        assertEquals(62, snap?.continueReading?.optInt("progressPct"))
    }

    @Test
    fun parseSnapshot_handlesMissingSections() {
        val snap = ReadingWidgetStore.parseSnapshot("""{"version":1,"style":"default"}""")
        assertEquals("default", snap?.style)
        assertNull(snap?.continueReading)
        assertNull(snap?.nextInSeries)
    }

    @Test
    fun corruptJson_treatedAsAbsent() {
        assertNull(ReadingWidgetStore.parseSnapshot("{not json"))
        assertNull(ReadingWidgetStore.parseSnapshot(null))
    }
}
