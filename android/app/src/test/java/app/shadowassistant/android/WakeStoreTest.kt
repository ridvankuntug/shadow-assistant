package app.shadowassistant.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class WakeStoreTest {
    private fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    private class MapStore : KeyValueStore {
        val map = HashMap<String, String>()
        val writes = mutableListOf<Set<String>>()
        override fun putAll(values: Map<String, String>) {
            writes += values.keys
            map.putAll(values)
        }
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) {
            map[key] = value
        }
        override fun remove(key: String) {
            map.remove(key)
        }
    }

    private val key = newKey()
    private val cipher = AesGcmTokenCipher({ key }, WakeStore.TOKEN_AAD)
    private val token = "wake-token_0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZabc"
    private val address = "http://192.0.2.10:8704"

    // --- store ------------------------------------------------------------------------

    @Test
    fun tokenIsStoredOnlyEncrypted() {
        val store = MapStore()
        val logs = mutableListOf<String>()
        val s = WakeStore(store, cipher) { logs += it }
        assertTrue(s.save(null, address, token))
        assertFalse(store.map.values.any { it.contains(token) })
        assertTrue(store.map.getValue(WakeStore.TOKEN_KEY).startsWith("v1:"))
        assertEquals(address, store.map[WakeStore.ADDRESS_KEY])
        assertEquals(WakeStore.Config(null, address, token), s.config())
        assertFalse(s.config().toString().contains(token))
        assertTrue(logs.isEmpty())
    }

    @Test
    fun addressAndTokenAreOneWrite() {
        val store = MapStore()
        val s = WakeStore(store, cipher) {}
        s.save(null, address, token)
        s.save(null, address, null)
        val addresses = setOf(WakeStore.HOME_KEY, WakeStore.ADDRESS_KEY)
        assertEquals(listOf(addresses + WakeStore.TOKEN_KEY, addresses), store.writes)
    }

    @Test
    fun emptyTokenFieldKeepsTheStoredToken() {
        val s = WakeStore(MapStore(), cipher) {}
        s.save(null, address, token)
        assertTrue(s.save(null, "https://wake.example.test:8443", null))
        assertEquals(WakeStore.Config(null, "https://wake.example.test:8443", token), s.config())
    }

    @Test
    fun encryptionFailureStoresNothing() {
        val store = MapStore()
        val logs = mutableListOf<String>()
        val failing = object : TokenCipher {
            override fun encrypt(plain: String): String = throw GeneralSecurityException("keystore unavailable")
            override fun decrypt(blob: String): String? = null
        }
        val s = WakeStore(store, failing) { logs += it }
        assertFalse(s.save(null, address, token))
        assertTrue(store.map.isEmpty())
        assertFalse(logs.any { it.contains(token) })
        assertNull(s.config())
    }

    @Test
    fun undecryptableTokenIsClearedAndNotLogged() {
        val store = MapStore()
        val logs = mutableListOf<String>()
        WakeStore(store, cipher) {}.save(null, address, token)
        val other = WakeStore(store, AesGcmTokenCipher({ newKey() }, WakeStore.TOKEN_AAD)) { logs += it }
        assertNull(other.config())
        assertFalse(other.hasToken())
        assertEquals(address, other.away())
        assertEquals(1, logs.size)
        assertFalse(logs.any { it.contains(token) })
    }

    @Test
    fun deviceTokenBlobIsNotAcceptedAsAWakeToken() {
        // Same key, other purpose: the AAD binds a blob to the wake store.
        val deviceBlob = AesGcmTokenCipher({ key }, BridgeStorage.TOKEN_KEY.toByteArray()).encrypt(token)
        assertNull(cipher.decrypt(deviceBlob))
        assertNotEquals(BridgeStorage.TOKEN_KEY, String(WakeStore.TOKEN_AAD))
    }

    @Test
    fun invalidTokenIsRefused() {
        val store = MapStore()
        val s = WakeStore(store, cipher) {}
        for (bad in listOf("", "with space", "line\nbreak", "tab\t", "ünicode", "x".repeat(513))) {
            assertFalse(bad, s.save(null, address, bad))
        }
        assertTrue(store.map.isEmpty())
    }

    @Test
    fun clearRemovesBoth() {
        val store = MapStore()
        val s = WakeStore(store, cipher) {}
        s.save(null, address, token)
        s.clear()
        assertTrue(store.map.isEmpty())
        assertNull(s.config())
        assertFalse(s.hasToken())
    }

    @Test
    fun ownFileAndOwnKeyNotReachableThroughTheBridge() {
        val bridgeFiles = setOf(AppStorage.PREFS_PLAIN, AppStorage.PREFS_SECRET, AppStorage.PREFS_FLAGS)
        assertFalse(AppStorage.PREFS_WAKE in bridgeFiles)
        assertNotEquals(AppStorage.KEY_ALIAS, AppStorage.WAKE_KEY_ALIAS)
        assertEquals("shadow.wakeToken.v1", AppStorage.WAKE_KEY_ALIAS)
        // The page reads BridgeStorage only; the wake keys mean nothing there.
        val bridge = BridgeStorage(MapStore(), MapStore(), cipher) {}
        val wakeFile = MapStore()
        WakeStore(wakeFile, cipher) {}.save(null, address, token)
        assertNull(bridge.get(WakeStore.TOKEN_KEY))
        assertNull(bridge.get(WakeStore.ADDRESS_KEY))
    }

    // --- address and dialog checks ----------------------------------------------------

    private val home = "192.0.2.10"

    @Test
    fun cleartextOnlyToPrivateIpv4OrTheBuildsWakeHost() {
        // Private IPv4 literals: always (T21.3.3), with or without a build host.
        assertEquals(WakeAddress.Check.Ok(WakeAddress.Endpoint(false, "10.0.0.5", 8704)), WakeAddress.check("http://10.0.0.5:8704", ""))
        assertEquals(WakeAddress.Check.Ok(WakeAddress.Endpoint(false, "172.16.0.5", 80)), WakeAddress.check(" http://172.16.0.5/ ", ""))
        // Public / documentation addresses and hostnames: only the build's development host.
        assertEquals(
            WakeAddress.Check.Ok(WakeAddress.Endpoint(false, home, 8704)),
            WakeAddress.check("http://192.0.2.10:8704", home),
        )
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://192.0.2.11:8704", home))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://192.0.2.10:8704", ""))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://box.example.test:8704", ""))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://10.0.0.5.example.test:8704", ""))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://172.32.0.5:8704", ""))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://010.0.0.5:8704", ""))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://[fd00::1]:8704", ""))
        // User info is refused outright (it could hide the real host).
        assertEquals(WakeAddress.Check.Invalid, WakeAddress.check("http://10.0.0.5@box.example.test:8704", ""))
        assertEquals(
            WakeAddress.Check.Ok(WakeAddress.Endpoint(true, "wake.example.test", 443)),
            WakeAddress.check("HTTPS://Wake.Example.Test", home),
        )
    }

    @Test
    fun onlySchemeHostAndPortAreAccepted() {
        for (bad in listOf(
            "", "  ", "192.0.2.10:8704", "ws://192.0.2.10:8704", "ftp://192.0.2.10",
            "http://192.0.2.10:8704/wake", "http://192.0.2.10:8704/?x=1", "http://192.0.2.10:8704/#f",
            "http://user:pw@192.0.2.10:8704", "http://192.0.2.10:99999", "http://:8704", "not a url",
        )) {
            assertEquals(bad, WakeAddress.Check.Invalid, WakeAddress.check(bad, home))
        }
    }

    @Test
    fun endpointUrls() {
        val e = WakeAddress.Endpoint(false, home, 8704)
        assertEquals("http://192.0.2.10:8704", e.baseUrl)
        assertEquals("http://192.0.2.10:8704/wake", e.wakeUrl)
        assertEquals("https://[fd00::1]:8443/wake", WakeAddress.Endpoint(true, "fd00::1", 8443).wakeUrl)
        assertEquals("http://192.0.2.10:8704", WakeAddress.defaultUrl(home))
        assertEquals("", WakeAddress.defaultUrl(""))
    }

    @Test
    fun coreHealthUrlFollowsTheCoreAddress() {
        assertEquals("http://192.0.2.10:8700/health", WakeAddress.coreHealthUrl("ws://192.0.2.10:8700/ws"))
        assertEquals("https://core.example.test:443/health", WakeAddress.coreHealthUrl("wss://core.example.test/ws"))
        assertEquals("http://[::1]:8700/health", WakeAddress.coreHealthUrl("ws://[::1]:8700/ws"))
        assertNull(WakeAddress.coreHealthUrl("http://192.0.2.10:8700"))
        assertNull(WakeAddress.coreHealthUrl(null))
    }

    private fun form(
        coreHome: String? = null,
        wakeHome: String? = null,
        wakeAway: String? = null,
        token: String? = null,
        hasStoredToken: Boolean = false,
    ) = WakeSettingsForm.validate(coreHome, wakeHome, wakeAway, token, hasStoredToken, coreCleartextHost = "", wakeCleartextHost = "")

    private fun invalid(field: WakeSettingsForm.Field, problem: WakeSettingsForm.Problem) = WakeSettingsForm.Result.Invalid(field, problem)

    @Test
    fun dialogValidation() {
        val ok = form("ws://10.0.0.2:8700/ws", "http://10.0.0.5:8704/", "https://wake.example.test:8443", " $token ")
        assertEquals(
            WakeSettingsForm.Result.Ok("ws://10.0.0.2:8700/ws", "http://10.0.0.5:8704", "https://wake.example.test:8443", token),
            ok,
        )
        assertFalse(ok.toString().contains(token))
        // Everything is optional: no addresses, no token is "nothing configured".
        assertEquals(WakeSettingsForm.Result.Ok(null, null, null, null), form())
        assertEquals(WakeSettingsForm.Result.Ok("wss://core.example.test/ws", null, null, null), form("wss://core.example.test/ws"))
        // One wake address is enough; an empty token field keeps a stored token.
        assertEquals(
            WakeSettingsForm.Result.Ok(null, "http://10.0.0.5:8704", null, null),
            form(wakeHome = "http://10.0.0.5:8704", token = "", hasStoredToken = true),
        )
        assertEquals(invalid(WakeSettingsForm.Field.TOKEN, WakeSettingsForm.Problem.TOKEN_MISSING), form(wakeAway = "https://wake.example.test", token = "  "))
        assertEquals(
            invalid(WakeSettingsForm.Field.TOKEN, WakeSettingsForm.Problem.TOKEN_INVALID),
            form(wakeAway = "https://wake.example.test", token = "two words", hasStoredToken = true),
        )
        assertEquals(invalid(WakeSettingsForm.Field.WAKE_AWAY, WakeSettingsForm.Problem.ADDRESS_MISSING), form(token = token))
        // The cleartext gate on every address field.
        assertEquals(invalid(WakeSettingsForm.Field.CORE_HOME, WakeSettingsForm.Problem.ADDRESS_CLEARTEXT), form("ws://core.example.test:8700/ws"))
        assertEquals(invalid(WakeSettingsForm.Field.CORE_HOME, WakeSettingsForm.Problem.ADDRESS_CLEARTEXT), form("ws://198.51.100.7:8700/ws"))
        assertEquals(invalid(WakeSettingsForm.Field.CORE_HOME, WakeSettingsForm.Problem.ADDRESS_CLEARTEXT), form("ws://user@10.0.0.2:8700/ws"))
        assertEquals(invalid(WakeSettingsForm.Field.CORE_HOME, WakeSettingsForm.Problem.ADDRESS_INVALID), form("http://10.0.0.2:8700"))
        // The Core's home address is stored as the page will use it.
        assertEquals(WakeSettingsForm.Result.Ok("ws://10.0.0.2:8700/ws", null, null, null), form(" WS://10.0.0.2:8700 "))
        assertEquals(WakeSettingsForm.Result.Ok("ws://10.0.0.2:8700/ws", null, null, null), form("ws://10.0.0.2:8700/"))
        for (bad in listOf("ws://10.0.0.2:8700/ws#x", "ws://10.0.0.2:8700/ws?x=1", "ws://10.0.0.2:99999/ws")) {
            assertEquals(bad, invalid(WakeSettingsForm.Field.CORE_HOME, WakeSettingsForm.Problem.ADDRESS_INVALID), form(bad))
        }
        assertEquals(invalid(WakeSettingsForm.Field.WAKE_HOME, WakeSettingsForm.Problem.ADDRESS_CLEARTEXT), form(wakeHome = "http://198.51.100.7:8704", token = token))
        assertEquals(invalid(WakeSettingsForm.Field.WAKE_AWAY, WakeSettingsForm.Problem.ADDRESS_CLEARTEXT), form(wakeAway = "http://wake.example.test", token = token))
        assertEquals(invalid(WakeSettingsForm.Field.WAKE_HOME, WakeSettingsForm.Problem.ADDRESS_INVALID), form(wakeHome = "http://10.0.0.5:8704/wake", token = token))
    }

    @Test
    fun migrationKeepsHttpsAwayAndMovesAPrivateHttpAddressHome() {
        fun migrated(old: String, homeBefore: String? = null): Pair<String?, String?> {
            val store = MapStore()
            store.put(WakeStore.ADDRESS_KEY, old)
            homeBefore?.let { store.put(WakeStore.HOME_KEY, it) }
            val s = WakeStore(store, cipher) {}
            s.migrate(cleartextHost = "")
            return s.home() to s.away()
        }
        assertEquals(null to "https://wake.example.test:8443", migrated("https://wake.example.test:8443"))
        assertEquals("http://10.0.0.5:8704" to null, migrated("http://10.0.0.5:8704"))
        // Not allowed any more (a hostname / public address): dropped, the dialog asks again.
        assertEquals(null to null, migrated("http://wake.example.test:8704"))
        assertEquals(null to null, migrated("http://198.51.100.7:8704"))
        // A home address already set is not replaced.
        assertEquals("http://10.0.0.6:8704" to null, migrated("http://10.0.0.5:8704", "http://10.0.0.6:8704"))
    }

    @Test
    fun migrationRunsOnceAndLeavesLaterAddressesAlone() {
        val store = MapStore()
        val s = WakeStore(store, cipher) {}
        s.migrate(cleartextHost = "")
        // Saved by the dialog afterwards: a private http:// away address is valid and stays.
        assertTrue(s.save("http://10.0.0.5:8704", "http://10.0.0.6:8704", token))
        s.migrate(cleartextHost = "")
        assertEquals("http://10.0.0.5:8704", s.home())
        assertEquals("http://10.0.0.6:8704", s.away())
    }

    @Test
    fun theBuildsWakeHostIsAPlainHostOrNothing() {
        val host = WakeAddress.CLEARTEXT_HOST
        assertTrue(host, host.isEmpty() || Regex("""^[A-Za-z0-9.-]+$""").matches(host))
    }
}
