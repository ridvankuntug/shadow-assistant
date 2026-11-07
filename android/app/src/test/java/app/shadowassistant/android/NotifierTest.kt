package app.shadowassistant.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotifierTest {
    @Test
    fun itemsUseTheirOwnChannelsNotTheConfirmationOne() {
        assertEquals(Notifier.ITEMS_CHANNEL, Notifier.itemChannel(urgent = false))
        assertEquals(Notifier.URGENT_CHANNEL, Notifier.itemChannel(urgent = true))
        val channels = setOf(Notifier.CHANNEL, Notifier.ITEMS_CHANNEL, Notifier.URGENT_CHANNEL)
        assertEquals(3, channels.size)
    }

    @Test
    fun everyItemHasItsOwnKeyAndNoneIsTheConfirmation() {
        // Android keys a notification by (tag, id): items differ by tag, the confirmation has no tag.
        assertNotEquals(Notifier.NOTIFICATION_ID, Notifier.ITEM_NOTIFICATION_ID)
        assertNotEquals(Notifier.itemTag("n-0000000000000001"), Notifier.itemTag("n-0000000000000002"))
        assertEquals(Notifier.itemTag("n-0000000000000001"), Notifier.itemTag("n-0000000000000001"))
    }

    @Test
    fun bridgeAcceptsOnlyPlainItemIds() {
        assertEquals("n-0123456789abcdef", Notifier.validItemId("n-0123456789abcdef"))
        assertNull(Notifier.validItemId(null))
        assertNull(Notifier.validItemId(""))
        assertNull(Notifier.validItemId("   "))
        assertNull(Notifier.validItemId("n-1\n2"))
        assertNull(Notifier.validItemId("x".repeat(Notifier.MAX_ITEM_ID + 1)))
        assertEquals(Notifier.MAX_ITEM_ID, Notifier.validItemId("x".repeat(Notifier.MAX_ITEM_ID))?.length)
    }
}
