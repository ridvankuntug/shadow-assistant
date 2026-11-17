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
 * - addresses: plain, validated by [WakeAddress.check] before they get here;
 *   a home and an away one (T21.3.3), either may be empty. The away one keeps
 *   the key of the single address of earlier versions ([ADDRESS_KEY]), so an
 *   existing `https://` address stays the away address; [migrate] moves an old
 *   `http://` one to the home slot if the cleartext gate now allows it.
 *
 * The token never reaches [log] or `toString`.
 */
class WakeStore(
    private val store: KeyValueStore,
    private val cipher: TokenCipher,
    private val log: (String) -> Unit,
) {
    /** At least one address and the token. */
    data class Config(val home: String?, val away: String?, val token: String) {
        override fun toString() = "Config(home=$home, away=$away, token=<redacted>)"
    }

    fun home(): String? = synchronized(this) { read(HOME_KEY) }

    fun away(): String? = synchronized(this) { read(ADDRESS_KEY) }

    private fun read(key: String) = store.get(key)?.takeIf { it.isNotBlank() }

    fun hasToken(): Boolean = synchronized(this) { store.get(TOKEN_KEY) != null }

    /** Addresses and decrypted token, or null if there is no address, no token or it is unreadable. */
    fun config(): Config? = synchronized(this) {
        val home = read(HOME_KEY)
        val away = read(ADDRESS_KEY)
        if (home == null && away == null) return@synchronized null
        val blob = store.get(TOKEN_KEY) ?: return@synchronized null
        val token = cipher.decrypt(blob)
        if (token == null) {
            store.remove(TOKEN_KEY)
            log("stored wake token could not be decrypted; it was cleared")
            return@synchronized null
        }
        Config(home, away, token)
    }

    /**
     * Saves both addresses (null: that slot is emptied) and, if [token] is not
     * null, a new token. [token] null keeps the stored one (the dialog never
     * shows it back). Returns false and changes nothing if the token cannot be
     * encrypted or is not a valid token.
     */
    fun save(home: String?, away: String?, token: String?): Boolean = synchronized(this) {
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
        // One write: a crash can never leave a new token paired with old addresses (or the reverse).
        val addresses = mapOf(HOME_KEY to home.orEmpty(), ADDRESS_KEY to away.orEmpty())
        store.putAll(if (blob != null) addresses + (TOKEN_KEY to blob) else addresses)
        true
    }

    /** Deletes the addresses and the token. */
    fun clear() = synchronized(this) {
        store.remove(TOKEN_KEY)
        store.remove(ADDRESS_KEY)
        store.remove(HOME_KEY)
    }

    /**
     * Called at every start, does its work once (T21.3.3, marker [MIGRATED_KEY]):
     * earlier versions had one address, kept in the away slot. A plain
     * `http://` one there moves to the empty home slot if the cleartext gate
     * allows it now (a private IPv4 address); one it refuses is dropped, so the
     * dialog asks again. `https://` stays put. Later `http://` away addresses
     * saved by the dialog are never touched.
     */
    fun migrate(cleartextHost: String = WakeAddress.CLEARTEXT_HOST) = synchronized(this) {
        if (store.get(MIGRATED_KEY) != null) return@synchronized
        val old = read(ADDRESS_KEY)
        if (old == null || !old.trim().startsWith("http://", ignoreCase = true)) {
            store.put(MIGRATED_KEY, "1")
            return@synchronized
        }
        val ok = WakeAddress.check(old, cleartextHost) as? WakeAddress.Check.Ok
        val home = if (read(HOME_KEY) == null && ok != null) ok.endpoint.baseUrl else read(HOME_KEY).orEmpty()
        store.putAll(mapOf(HOME_KEY to home, ADDRESS_KEY to "", MIGRATED_KEY to "1"))
        log("stored plain wake address left the away slot (home slot: ${if (home.isEmpty()) "empty" else "set"})")
    }

    companion object {
        /** The away address (the single address of versions before T21.3.3). */
        const val ADDRESS_KEY = "wakeAddress"
        const val HOME_KEY = "wakeHomeAddress"

        /** Present once [migrate] has run. */
        const val MIGRATED_KEY = "wakeAddressesV2"
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
