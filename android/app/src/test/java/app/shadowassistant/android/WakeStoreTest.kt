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
        assertTrue(s.save(address, token))
        assertFalse(store.map.values.any { it.contains(token) })
        assertTrue(store.map.getValue(WakeStore.TOKEN_KEY).startsWith("v1:"))
        assertEquals(address, store.map[WakeStore.ADDRESS_KEY])
        assertEquals(WakeStore.Config(address, token), s.config())
        assertFalse(s.config().toString().contains(token))
        assertTrue(logs.isEmpty())
    }

    @Test
    fun addressAndTokenAreOneWrite() {
        val store = MapStore()
        val s = WakeStore(store, cipher) {}
        s.save(address, token)
        s.save(address, null)
        assertEquals(listOf(setOf(WakeStore.TOKEN_KEY, WakeStore.ADDRESS_KEY), setOf(WakeStore.ADDRESS_KEY)), store.writes)
    }

    @Test
    fun emptyTokenFieldKeepsTheStoredToken() {
        val s = WakeStore(MapStore(), cipher) {}
        s.save(address, token)
        assertTrue(s.save("https://wake.example.test:8443", null))
        assertEquals(WakeStore.Config("https://wake.example.test:8443", token), s.config())
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
        assertFalse(s.save(address, token))
        assertTrue(store.map.isEmpty())
        assertFalse(logs.any { it.contains(token) })
        assertNull(s.config())
    }

    @Test
    fun undecryptableTokenIsClearedAndNotLogged() {
        val store = MapStore()
        val logs = mutableListOf<String>()
        WakeStore(store, cipher) {}.save(address, token)
        val other = WakeStore(store, AesGcmTokenCipher({ newKey() }, WakeStore.TOKEN_AAD)) { logs += it }
        assertNull(other.config())
        assertFalse(other.hasToken())
        assertEquals(address, other.address())
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
            assertFalse(bad, s.save(address, bad))
        }
        assertTrue(store.map.isEmpty())
    }

    @Test
    fun clearRemovesBoth() {
        val store = MapStore()
        val s = WakeStore(store, cipher) {}
        s.save(address, token)
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
        WakeStore(wakeFile, cipher) {}.save(address, token)
        assertNull(bridge.get(WakeStore.TOKEN_KEY))
        assertNull(bridge.get(WakeStore.ADDRESS_KEY))
    }

    // --- address and dialog checks ----------------------------------------------------

    private val home = "192.0.2.10"

    @Test
    fun cleartextOnlyToTheBuildsWakeHost() {
        assertEquals(
            WakeAddress.Check.Ok(WakeAddress.Endpoint(false, home, 8704)),
            WakeAddress.check("http://192.0.2.10:8704", home),
        )
        assertEquals(WakeAddress.Check.Ok(WakeAddress.Endpoint(false, home, 80)), WakeAddress.check(" http://192.0.2.10/ ", home))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://192.0.2.11:8704", home))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://192.168.1.2:8704", home))
        assertEquals(WakeAddress.Check.CleartextNotAllowed, WakeAddress.check("http://192.0.2.10:8704", ""))
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
        assertEquals("http://192.168.1.2:8700/health", WakeAddress.coreHealthUrl(CoreAddress.DEFAULT_URL))
        assertEquals("https://core.example.test:443/health", WakeAddress.coreHealthUrl("wss://core.example.test/ws"))
        assertEquals("http://[::1]:8700/health", WakeAddress.coreHealthUrl("ws://[::1]:8700/ws"))
        assertNull(WakeAddress.coreHealthUrl("http://192.168.1.2:8700"))
        assertNull(WakeAddress.coreHealthUrl(null))
    }

    @Test
    fun dialogValidation() {
        val ok = WakeSettingsForm.validate("http://192.0.2.10:8704/", " $token ", hasStoredToken = false, cleartextHost = home)
        assertEquals(WakeSettingsForm.Result.Ok("http://192.0.2.10:8704", token), ok)
        assertFalse(ok.toString().contains(token))
        assertEquals(
            WakeSettingsForm.Result.Ok("http://192.0.2.10:8704", null),
            WakeSettingsForm.validate("http://192.0.2.10:8704", "", hasStoredToken = true, cleartextHost = home),
        )
        assertEquals(
            WakeSettingsForm.Result.Invalid(WakeSettingsForm.Problem.TOKEN_MISSING),
            WakeSettingsForm.validate("http://192.0.2.10:8704", "  ", hasStoredToken = false, cleartextHost = home),
        )
        assertEquals(
            WakeSettingsForm.Result.Invalid(WakeSettingsForm.Problem.TOKEN_INVALID),
            WakeSettingsForm.validate("http://192.0.2.10:8704", "two words", hasStoredToken = true, cleartextHost = home),
        )
        assertEquals(
            WakeSettingsForm.Result.Invalid(WakeSettingsForm.Problem.ADDRESS_CLEARTEXT),
            WakeSettingsForm.validate("http://198.51.100.7:8704", token, hasStoredToken = false, cleartextHost = home),
        )
        assertEquals(
            WakeSettingsForm.Result.Invalid(WakeSettingsForm.Problem.ADDRESS_NO_CLEARTEXT_HOST),
            WakeSettingsForm.validate("http://192.0.2.10:8704", token, hasStoredToken = false, cleartextHost = ""),
        )
        assertEquals(
            WakeSettingsForm.Result.Invalid(WakeSettingsForm.Problem.ADDRESS_INVALID),
            WakeSettingsForm.validate("http://192.0.2.10:8704/wake", token, hasStoredToken = false, cleartextHost = home),
        )
    }

    @Test
    fun theBuildsWakeHostIsAPlainHostOrNothing() {
        val host = WakeAddress.CLEARTEXT_HOST
        assertTrue(host, host.isEmpty() || Regex("""^[A-Za-z0-9.-]+$""").matches(host))
    }
}
