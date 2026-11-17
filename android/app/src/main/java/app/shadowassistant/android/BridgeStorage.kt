package app.shadowassistant.android

import android.content.SharedPreferences
import androidx.core.content.edit

/** Minimal key/value store, so [BridgeStorage] can be tested without Android. */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)

    /** Writes all [values] together; stores that can do it atomically override this. */
    fun putAll(values: Map<String, String>) = values.forEach { (k, v) -> put(k, v) }
}

class SharedPrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)

    // commit = true: the bridge call returns only after the value is on disk
    // (tiny values; runs on the WebView's JavaBridge thread, not the UI thread).
    override fun put(key: String, value: String) = prefs.edit(commit = true) { putString(key, value) }

    override fun remove(key: String) = prefs.edit(commit = true) { remove(key) }

    // One editor, one commit: either every value reaches the disk or none does.
    override fun putAll(values: Map<String, String>) =
        prefs.edit(commit = true) { values.forEach { (k, v) -> putString(k, v) } }
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
 *
 * Home / away (T21.3.3): the address the UI writes ([CORE_URL_KEY]) is the
 * Core's away address; the optional home address is native-only
 * ([CORE_HOME_KEY] in [secret], set by the "Adresler" dialog), as is the flag
 * that the home address is in use ([USE_HOME_KEY], set by [CoreProbe]'s
 * selection). The page reads [CORE_URL_KEY] as the address in use
 * ([activeCoreUrl]): the home address while it is selected (or when there is
 * no away address), the away address otherwise. The home address is handed out
 * only if it passes the cleartext gate ([CoreAddress.usable]). Both addresses
 * belong to the same Core, so they share the one device token.
 */
class BridgeStorage(
    private val plain: KeyValueStore,
    private val secret: KeyValueStore,
    private val cipher: TokenCipher,
    private val log: (String) -> Unit,
) {
    fun get(key: String): String? = when (key) {
        TOKEN_KEY -> synchronized(PAIR_LOCK) { readToken() }
        CORE_URL_KEY -> synchronized(PAIR_LOCK) { activeCoreUrl() }
        else -> plain.get(key)
    }

    /** The home address if it is usable and selected (or there is no away address), else the away address. */
    private fun activeCoreUrl(): String? {
        val away = plain.get(CORE_URL_KEY)?.takeIf { it.isNotBlank() }
        val home = homeCoreUrl()?.takeIf { CoreAddress.usable(it) }
        return if (home != null && (away == null || secret.get(USE_HOME_KEY) != null)) home else away
    }

    /** The Core's away address as the UI stored it. */
    fun awayCoreUrl(): String? = synchronized(PAIR_LOCK) { plain.get(CORE_URL_KEY)?.takeIf { it.isNotBlank() } }

    /** The Core's home address (native-only), or null. */
    fun homeCoreUrl(): String? = synchronized(PAIR_LOCK) { secret.get(CORE_HOME_KEY)?.takeIf { it.isNotBlank() } }

    /** Sets or (null) removes the home address; a changed one is used only once the next check picks it. Validated by the dialog. */
    fun setHomeCoreUrl(url: String?) = synchronized(PAIR_LOCK) {
        val next = url?.trim()?.takeIf { it.isNotEmpty() }
        if (next == homeCoreUrl()) return@synchronized
        secret.remove(USE_HOME_KEY)
        if (next == null) secret.remove(CORE_HOME_KEY) else secret.put(CORE_HOME_KEY, next)
    }

    /** Records [CoreProbe]'s choice. */
    fun selectHome(useHome: Boolean) = synchronized(PAIR_LOCK) {
        if (useHome) secret.put(USE_HOME_KEY, "1") else secret.remove(USE_HOME_KEY)
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
                // The page saves back the address it was shown: if that is the home address in use,
                // the stored away address stays (it is not replaced by the home one).
                val home = homeCoreUrl()?.takeIf { CoreAddress.usable(it) }
                val writesBackHome = home != null && activeCoreUrl() == home &&
                    CoreAddress.sameAddress(value, home)
                if (!writesBackHome) {
                    plain.put(key, value)
                    // A new away address: the home one is used again only once the next check picks it.
                    secret.remove(USE_HOME_KEY)
                }
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
        val url = activeCoreUrl() ?: return@synchronized null
        val token = readToken() ?: return@synchronized null
        Connection(url, token)
    }

    fun hasToken(): Boolean = secret.get(TOKEN_KEY) != null

    /**
     * At every start: forget a stored (away) Core address this build can never use
     * ([CoreAddress.unusable], e.g. a plain `ws://` to a hostname), so the UI's
     * connect screen asks for a new one
     * instead of a page that keeps failing. There is no default address any
     * more; the token stays, so only the address has to be entered again.
     * Without an address [connection] is null, and the next address write marks
     * the pair dirty as usual. Returns true if an address was removed.
     */
    fun forgetUnusableCoreUrl(cleartextHost: String = CoreAddress.CLEARTEXT_HOST): Boolean = synchronized(PAIR_LOCK) {
        if (!CoreAddress.unusable(plain.get(CORE_URL_KEY), cleartextHost)) return@synchronized false
        plain.remove(CORE_URL_KEY)
        log("stored Core address is not allowed (plain ws:// to a non-private address); it was cleared")
        true
    }

    companion object {
        const val TOKEN_KEY = "shadow.deviceToken"
        const val CORE_URL_KEY = "shadow.coreUrl"

        /** In the secret store, never readable by the page; present = address written, matching token not yet. */
        const val PAIR_DIRTY_KEY = "connectionPairDirty"

        /** In the secret store (native-only): the Core's home address, and "1" while it is the one in use. */
        const val CORE_HOME_KEY = "coreHomeUrl"
        const val USE_HOME_KEY = "coreUseHome"
        private val PAIR_LOCK = Any()
    }
}
