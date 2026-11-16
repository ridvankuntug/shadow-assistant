package app.shadowassistant.android

import android.content.Context

/**
 * The app's stores, opened the same way by the activity and by background work
 * (the case battery worker reads the Core address and device token from here; no
 * second configuration place). SharedPreferences instances are per-process
 * singletons, so the activity and a worker share the same thread-safe objects.
 */
object AppStorage {
    // Internal (not private) so a unit test can check the wake store shares no file or key.
    internal const val PREFS_PLAIN = "shadow_storage"
    internal const val PREFS_SECRET = "shadow_secure"
    internal const val PREFS_FLAGS = "shadow_native"
    internal const val PREFS_WAKE = "shadow_wake"
    internal const val KEY_ALIAS = "shadow.deviceToken.v1"
    internal const val WAKE_KEY_ALIAS = "shadow.wakeToken.v1"

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

    /**
     * Wake endpoint address and token (docs/12 D2): its own file and its own Keystore
     * key, separate from the device token's; the page has no way to read either.
     */
    fun wake(context: Context, log: (String) -> Unit): WakeStore = WakeStore(
        store = SharedPrefsStore(context.applicationContext.getSharedPreferences(PREFS_WAKE, Context.MODE_PRIVATE)),
        cipher = AesGcmTokenCipher({ AndroidKeystoreKey.getOrCreate(WAKE_KEY_ALIAS) }, WakeStore.TOKEN_AAD),
        log = log,
    )

    /** Native-only flags the page cannot read. */
    fun flags(context: Context): KeyValueStore =
        SharedPrefsStore(context.applicationContext.getSharedPreferences(PREFS_FLAGS, Context.MODE_PRIVATE))
}
