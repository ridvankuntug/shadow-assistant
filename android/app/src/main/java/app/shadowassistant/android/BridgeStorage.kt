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
 *
 * Connection pair: the UI saves the Core address and the device token as two
 * separate writes (address first, token last). Background work that sends the
 * token ([connection]) must never pair a new address with the old token, so
 * writing the address marks the pair "dirty" and a successful token write marks
 * it clean again; [connection] returns the pair only while it is clean. The flag
 * is persisted in [secret] (the page cannot read it: [get] only exposes
 * [TOKEN_KEY] from there), so a process death between the two writes leaves the
 * pair dirty. No flag at all (installs from before the flag) counts as clean.
 * All of it runs under [PAIR_LOCK], shared by every instance in the process (the
 * activity and the worker each open their own [BridgeStorage]).
 */
class BridgeStorage(
    private val plain: KeyValueStore,
    private val secret: KeyValueStore,
    private val cipher: TokenCipher,
    private val log: (String) -> Unit,
) {
    fun get(key: String): String? {
        if (key != TOKEN_KEY) return plain.get(key)
        return synchronized(PAIR_LOCK) { readToken() }
    }

    private fun readToken(): String? {
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
    fun set(key: String, value: String): Boolean = synchronized(PAIR_LOCK) {
        when (key) {
            CORE_URL_KEY -> {
                // Dirty before the address changes: a crash in between leaves it dirty, never a clean new pair.
                secret.put(PAIR_DIRTY_KEY, "1")
                plain.put(key, value)
                true
            }
            TOKEN_KEY -> try {
                secret.put(TOKEN_KEY, cipher.encrypt(value))
                // Only a stored token completes the pair; a failed write leaves it dirty.
                secret.remove(PAIR_DIRTY_KEY)
                true
            } catch (e: Exception) {
                log("device token could not be encrypted (${e.javaClass.simpleName}); not stored")
                false
            }
            else -> {
                plain.put(key, value)
                true
            }
        }
    }

    fun remove(key: String) = synchronized(PAIR_LOCK) {
        if (key == TOKEN_KEY) secret.remove(TOKEN_KEY) else plain.remove(key)
    }

    /** Core address and device token, both present. */
    data class Connection(val coreUrl: String, val token: String) {
        override fun toString() = "Connection(coreUrl=$coreUrl, token=<redacted>)"
    }

    /**
     * The address and token as one consistent snapshot, or null if either is
     * missing or the UI is between writing the address and the token (dirty pair).
     */
    fun connection(): Connection? = synchronized(PAIR_LOCK) {
        if (secret.get(PAIR_DIRTY_KEY) != null) return@synchronized null
        val url = plain.get(CORE_URL_KEY) ?: return@synchronized null
        val token = readToken() ?: return@synchronized null
        Connection(url, token)
    }

    fun hasToken(): Boolean = secret.get(TOKEN_KEY) != null

    /**
     * First run only: prefill the Core address with the home address so the
     * UI's connect screen shows it ([CoreAddress.DEFAULT_URL]). [flags] is a
     * store the page cannot read, so removing the key later stays removed.
     */
    fun seedDefaults(flags: KeyValueStore) {
        if (flags.get(SEEDED_FLAG) != null) return
        // Through set(): an address change, so the pair is dirty until a token is saved with it.
        if (plain.get(CORE_URL_KEY) == null) set(CORE_URL_KEY, CoreAddress.DEFAULT_URL)
        flags.put(SEEDED_FLAG, "1")
    }

    companion object {
        const val TOKEN_KEY = "shadow.deviceToken"
        const val CORE_URL_KEY = "shadow.coreUrl"
        const val SEEDED_FLAG = "coreUrlSeeded"

        /** In the secret store, never readable by the page; present = address written, matching token not yet. */
        const val PAIR_DIRTY_KEY = "connectionPairDirty"
        private val PAIR_LOCK = Any()
    }
}
