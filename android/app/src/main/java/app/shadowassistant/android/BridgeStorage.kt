package app.shadowassistant.android

import android.content.SharedPreferences
import androidx.core.content.edit

/** Minimal key/value store, so [BridgeStorage] can be tested without Android. */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

class SharedPrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)

    // commit = true: the bridge call returns only after the value is on disk
    // (tiny values; runs on the WebView's JavaBridge thread, not the UI thread).
    override fun put(key: String, value: String) = prefs.edit(commit = true) { putString(key, value) }

    override fun remove(key: String) = prefs.edit(commit = true) { remove(key) }
}

/**
 * Storage behind the bridge `getItem` / `setItem` / `removeItem` (docs/03 §1
 * storage keys). `shadow.deviceToken` is only ever written encrypted
 * ([TokenCipher], Android Keystore key) into its own store; every other key is
 * plain. The token value never reaches [log].
 *
 * Called on the WebView's JavaBridge thread; the stores are thread-safe.
 */
class BridgeStorage(
    private val plain: KeyValueStore,
    private val secret: KeyValueStore,
    private val cipher: TokenCipher,
    private val log: (String) -> Unit,
) {
    fun get(key: String): String? {
        if (key != TOKEN_KEY) return plain.get(key)
        val blob = secret.get(TOKEN_KEY) ?: return null
        val token = cipher.decrypt(blob)
        if (token == null) {
            // Key lost (e.g. app data restored to another device) or blob damaged:
            // forget it so the UI asks for the token again.
            secret.remove(TOKEN_KEY)
            log("stored device token could not be decrypted; it was cleared")
        }
        return token
    }

    /** Returns false if the value could not be stored (the token is never stored in plain text). */
    fun set(key: String, value: String): Boolean {
        if (key != TOKEN_KEY) {
            plain.put(key, value)
            return true
        }
        return try {
            secret.put(TOKEN_KEY, cipher.encrypt(value))
            true
        } catch (e: Exception) {
            log("device token could not be encrypted (${e.javaClass.simpleName}); not stored")
            false
        }
    }

    fun remove(key: String) {
        if (key == TOKEN_KEY) secret.remove(TOKEN_KEY) else plain.remove(key)
    }

    fun hasToken(): Boolean = secret.get(TOKEN_KEY) != null

    /**
     * First run only: prefill the Core address with the home address so the
     * UI's connect screen shows it ([CoreAddress.DEFAULT_URL]). [flags] is a
     * store the page cannot read, so removing the key later stays removed.
     */
    fun seedDefaults(flags: KeyValueStore) {
        if (flags.get(SEEDED_FLAG) != null) return
        if (plain.get(CORE_URL_KEY) == null) plain.put(CORE_URL_KEY, CoreAddress.DEFAULT_URL)
        flags.put(SEEDED_FLAG, "1")
    }

    companion object {
        const val TOKEN_KEY = "shadow.deviceToken"
        const val CORE_URL_KEY = "shadow.coreUrl"
        const val SEEDED_FLAG = "coreUrlSeeded"
    }
}
