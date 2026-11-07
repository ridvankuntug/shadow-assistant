package app.shadowassistant.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * System notifications (docs/03 §4.1, docs/08 §T7.w.5 Delivery), three channels:
 *
 * - confirmations ([notify]): high importance, one notification that the next
 *   confirmation request replaces;
 * - inbox items ([notifyItem]): "Bildirimler", default importance without
 *   sound or vibration;
 * - urgent inbox items: "Acil bildirimler", high importance with the default sound.
 *
 * Every inbox item is its own notification (tag from the item id), so two
 * items show as two and raising one again replaces only that one. Tapping
 * brings the app back; dismissing only removes the system notification and
 * never touches the item (there is no delete intent). Without the
 * notification permission (Android 13+) every call is ignored.
 */
class Notifier(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        val items = NotificationChannel(ITEMS_CHANNEL, context.getString(R.string.notification_channel_items), NotificationManager.IMPORTANCE_DEFAULT)
            .apply {
                setSound(null, null)
                enableVibration(false)
            }
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL, context.getString(R.string.notification_channel), NotificationManager.IMPORTANCE_HIGH),
                items,
                NotificationChannel(URGENT_CHANNEL, context.getString(R.string.notification_channel_urgent), NotificationManager.IMPORTANCE_HIGH),
            ),
        )
    }

    /** A confirmation request (replaces the previous one). */
    fun notify(title: String, body: String) {
        val notification = build(CHANNEL, title, body)?.setCategory(Notification.CATEGORY_REMINDER)?.build() ?: return
        manager.notify(NOTIFICATION_ID, notification)
    }

    /** An inbox item, on the quiet or ([urgent]) the urgent channel, keyed by [itemId]. */
    fun notifyItem(itemId: String, title: String, body: String, urgent: Boolean) {
        val builder = build(itemChannel(urgent), title, body) ?: return
        if (urgent) builder.setCategory(Notification.CATEGORY_REMINDER)
        manager.notify(itemTag(itemId), ITEM_NOTIFICATION_ID, builder.build())
    }

    /** The common builder, or null without the notification permission. */
    private fun build(channel: String, title: String, body: String): Notification.Builder? {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return null
        }
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_shadow)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
    }

    companion object {
        const val CHANNEL = "shadow_confirmations"
        const val ITEMS_CHANNEL = "shadow_notifications"
        const val URGENT_CHANNEL = "shadow_notifications_urgent"
        /** The confirmation notification (one at a time). */
        const val NOTIFICATION_ID = 1
        /**
         * Inbox items share this id and differ by tag (Android keys a
         * notification by tag + id), so no item can replace the confirmation
         * or another item, whatever its id.
         */
        const val ITEM_NOTIFICATION_ID = 2
        /** Core item ids are `n-` + 16 hex characters; anything longer is refused. */
        const val MAX_ITEM_ID = 128

        fun itemChannel(urgent: Boolean): String = if (urgent) URGENT_CHANNEL else ITEMS_CHANNEL

        fun itemTag(itemId: String): String = "item:$itemId"

        /** The item id as the bridge accepts it, or null (blank, too long or with control characters). */
        fun validItemId(raw: String?): String? {
            if (raw.isNullOrBlank() || raw.length > MAX_ITEM_ID) return null
            return if (raw.any { it.isISOControl() }) null else raw
        }
    }
}
