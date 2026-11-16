package app.shadowassistant.android

/**
 * The wake endpoint's address and bearer token (docs/12 D2). Kept apart from
 * everything the page can reach: its own SharedPreferences file and its own
 * Keystore key ([AppStorage.wake]), never a [BridgeStorage] key, so the UI
 * can never read the token.
 *
 * - token: AES-GCM ([TokenCipher]) under the alias [AppStorage.WAKE_KEY_ALIAS]
 *   with [TOKEN_AAD]; if encryption fails nothing is stored (never plain text);
 *   a blob that cannot be decrypted (key lost, data restored elsewhere) is
 *   deleted so the dialog asks again;
 * - address: plain, validated by [WakeAddress.check] before it gets here.
 *
 * The token never reaches [log] or `toString`.
 */
class WakeStore(
    private val store: KeyValueStore,
    private val cipher: TokenCipher,
    private val log: (String) -> Unit,
) {
    /** Address and token, both present. */
    data class Config(val address: String, val token: String) {
        override fun toString() = "Config(address=$address, token=<redacted>)"
    }

    fun address(): String? = synchronized(this) { store.get(ADDRESS_KEY) }

    fun hasToken(): Boolean = synchronized(this) { store.get(TOKEN_KEY) != null }

    /** Address and decrypted token, or null if either is missing or the token is unreadable. */
    fun config(): Config? = synchronized(this) {
        val address = store.get(ADDRESS_KEY) ?: return@synchronized null
        val blob = store.get(TOKEN_KEY) ?: return@synchronized null
        val token = cipher.decrypt(blob)
        if (token == null) {
            store.remove(TOKEN_KEY)
            log("stored wake token could not be decrypted; it was cleared")
            return@synchronized null
        }
        Config(address, token)
    }

    /**
     * Saves [address] and, if [token] is not null, a new token. [token] null keeps
     * the stored one (the dialog never shows it back). Returns false and changes
     * nothing if the token cannot be encrypted or is not a valid token.
     */
    fun save(address: String, token: String?): Boolean = synchronized(this) {
        val blob = if (token == null) {
            null
        } else {
            if (!validToken(token)) return@synchronized false
            try {
                cipher.encrypt(token)
            } catch (e: Exception) {
                log("wake token could not be encrypted (${e.javaClass.simpleName}); not stored")
                return@synchronized false
            }
        }
        // One write: a crash can never leave a new token paired with the old address (or the reverse).
        store.putAll(if (blob != null) mapOf(TOKEN_KEY to blob, ADDRESS_KEY to address) else mapOf(ADDRESS_KEY to address))
        true
    }

    /** Deletes address and token. */
    fun clear() = synchronized(this) {
        store.remove(TOKEN_KEY)
        store.remove(ADDRESS_KEY)
    }

    companion object {
        const val ADDRESS_KEY = "wakeAddress"
        const val TOKEN_KEY = "wakeToken"
        val TOKEN_AAD: ByteArray get() = "shadow.wakeToken".toByteArray()
        private const val MAX_TOKEN_CHARS = 512

        /**
         * A bearer token as wake-svc issues it (base64url) or any other printable
         * ASCII without spaces: nothing that could break the `Authorization` header.
         */
        fun validToken(token: String): Boolean =
            token.length in 1..MAX_TOKEN_CHARS && token.all { it in '!'..'~' }
    }
}
