package app.shadowassistant.android

import android.content.Context

/**
 * The app's stores, opened the same way by the activity and by background work
 * (the case battery worker reads the Core address and device token from here; no
 * second configuration place). SharedPreferences instances are per-process
 * singletons, so the activity and a worker share the same thread-safe objects.
 */
object AppStorage {
    private const val PREFS_PLAIN = "shadow_storage"
    private const val PREFS_SECRET = "shadow_secure"
    private const val PREFS_FLAGS = "shadow_native"
    private const val KEY_ALIAS = "shadow.deviceToken.v1"

    /** Bridge storage (UI keys; the device token encrypted with the Keystore key). [log] never receives the token. */
    fun bridge(context: Context, log: (String) -> Unit): BridgeStorage {
        val app = context.applicationContext
        return BridgeStorage(
            plain = SharedPrefsStore(app.getSharedPreferences(PREFS_PLAIN, Context.MODE_PRIVATE)),
            secret = SharedPrefsStore(app.getSharedPreferences(PREFS_SECRET, Context.MODE_PRIVATE)),
            cipher = AesGcmTokenCipher({ AndroidKeystoreKey.getOrCreate(KEY_ALIAS) }, BridgeStorage.TOKEN_KEY.toByteArray()),
            log = log,
        )
    }

    /** Native-only flags the page cannot read. */
    fun flags(context: Context): KeyValueStore =
        SharedPrefsStore(context.applicationContext.getSharedPreferences(PREFS_FLAGS, Context.MODE_PRIVATE))
}
