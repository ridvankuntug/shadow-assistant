package app.shadowassistant.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.GeneralSecurityException
import java.util.Base64
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class TokenStorageTest {
    private fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    private val key = newKey()
    private val aad = BridgeStorage.TOKEN_KEY.toByteArray()
    private val cipher = AesGcmTokenCipher({ key }, aad)
    private val token = "a-device-token-0123456789abcdef"

    private class MapStore : KeyValueStore {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) {
            map[key] = value
        }
        override fun remove(key: String) {
            map.remove(key)
        }
    }

    // --- cipher ---------------------------------------------------------------

    @Test
    fun roundTrip() {
        val blob = cipher.encrypt(token)
        assertTrue(blob.startsWith("v1:"))
        assertFalse(blob.contains(token))
        assertEquals(token, cipher.decrypt(blob))
    }

    @Test
    fun freshIvEveryTime() {
        val a = cipher.encrypt(token)
        val b = cipher.encrypt(token)
        assertNotEquals(a, b)
        assertNotEquals(a.split(':')[1], b.split(':')[1])
        assertEquals(12, Base64.getDecoder().decode(a.split(':')[1]).size)
    }

    @Test
    fun tamperedCiphertextIsRejected() {
        val parts = cipher.encrypt(token).split(':')
        val ct = Base64.getDecoder().decode(parts[2])
        ct[0] = (ct[0].toInt() xor 1).toByte()
        assertNull(cipher.decrypt("v1:${parts[1]}:${Base64.getEncoder().encodeToString(ct)}"))
    }

    @Test
    fun otherKeyOrPurposeIsRejected() {
        val blob = cipher.encrypt(token)
        assertNull(AesGcmTokenCipher({ newKey() }, aad).decrypt(blob))
        assertNull(AesGcmTokenCipher({ key }, "shadow.coreUrl".toByteArray()).decrypt(blob))
    }

    @Test
    fun malformedBlobsAreRejected() {
        for (bad in listOf("", "v1", "v2:AAAA:AAAA", "v1:%%%:AAAA", "v1:AAAA:AAAA", token)) {
            assertNull(bad, cipher.decrypt(bad))
        }
    }

    // --- storage routing ------------------------------------------------------

    @Test
    fun tokenIsOnlyStoredEncrypted() {
        val plain = MapStore()
        val secret = MapStore()
        val s = BridgeStorage(plain, secret, cipher) {}
        assertTrue(s.set(BridgeStorage.TOKEN_KEY, token))
        assertTrue(plain.map.isEmpty())
        assertFalse(secret.map.values.any { it.contains(token) })
        assertEquals(token, s.get(BridgeStorage.TOKEN_KEY))
        assertTrue(s.hasToken())
        s.remove(BridgeStorage.TOKEN_KEY)
        assertNull(s.get(BridgeStorage.TOKEN_KEY))
        assertFalse(s.hasToken())
    }

    @Test
    fun otherKeysArePlain() {
        val plain = MapStore()
        val secret = MapStore()
        val s = BridgeStorage(plain, secret, cipher) {}
        s.set("shadow.quality", "low")
        assertEquals("low", plain.map["shadow.quality"])
        assertEquals("low", s.get("shadow.quality"))
        assertTrue(secret.map.isEmpty())
        s.remove("shadow.quality")
        assertNull(s.get("shadow.quality"))
    }

    @Test
    fun undecryptableTokenIsClearedAndNotLogged() {
        val secret = MapStore()
        val logs = mutableListOf<String>()
        BridgeStorage(MapStore(), secret, cipher) { logs += it }.set(BridgeStorage.TOKEN_KEY, token)
        val other = BridgeStorage(MapStore(), secret, AesGcmTokenCipher({ newKey() }, aad)) { logs += it }
        assertNull(other.get(BridgeStorage.TOKEN_KEY))
        assertTrue(secret.map.isEmpty())
        assertEquals(1, logs.size)
        assertFalse(logs.any { it.contains(token) })
    }

    @Test
    fun encryptionFailureNeverFallsBackToPlainText() {
        val plain = MapStore()
        val secret = MapStore()
        val logs = mutableListOf<String>()
        val failing = object : TokenCipher {
            override fun encrypt(plain: String): String = throw GeneralSecurityException("keystore unavailable")
            override fun decrypt(blob: String): String? = null
        }
        val s = BridgeStorage(plain, secret, failing) { logs += it }
        assertFalse(s.set(BridgeStorage.TOKEN_KEY, token))
        assertTrue(plain.map.isEmpty())
        assertTrue(secret.map.isEmpty())
        assertFalse(logs.any { it.contains(token) })
    }

    @Test
    fun noAddressIsSeeded() {
        // T21.3.3: no built-in Core address; the UI's connect screen asks on first launch.
        val plain = MapStore()
        val s = BridgeStorage(plain, MapStore(), cipher) {}
        assertFalse(s.forgetUnusableCoreUrl(cleartextHost = ""))
        assertNull(s.get(BridgeStorage.CORE_URL_KEY))
        assertTrue(plain.map.isEmpty())
    }

    @Test
    fun anOldPlainAddressIsForgottenButTheTokenKept() {
        // An install upgraded from a version that seeded / stored a plain ws:// LAN address.
        val plain = MapStore()
        val secret = MapStore()
        val logs = mutableListOf<String>()
        val s = BridgeStorage(plain, secret, cipher) { logs += it }
        s.set(BridgeStorage.CORE_URL_KEY, "ws://192.0.2.10:8700/ws")
        s.set(BridgeStorage.TOKEN_KEY, token)
        assertTrue(s.forgetUnusableCoreUrl(cleartextHost = ""))
        assertNull(s.get(BridgeStorage.CORE_URL_KEY))
        assertEquals(token, s.get(BridgeStorage.TOKEN_KEY))
        assertNull(s.connection())
        assertFalse(logs.any { it.contains("192.0.2.10") || it.contains(token) })
        // Entering the new address and saving the token again makes a clean pair.
        s.set(BridgeStorage.CORE_URL_KEY, "wss://box.example.ts.net/ws")
        assertNull(s.connection())
        s.set(BridgeStorage.TOKEN_KEY, token)
        assertEquals("wss://box.example.ts.net/ws", s.connection()?.coreUrl)
    }

    @Test
    fun usableAddressesAreKept() {
        val plain = MapStore()
        val s = BridgeStorage(plain, MapStore(), cipher) {}
        for (url in listOf("wss://box.example.ts.net/ws", "not a url")) {
            plain.put(BridgeStorage.CORE_URL_KEY, url)
            assertFalse(s.forgetUnusableCoreUrl(cleartextHost = ""))
            assertEquals(url, plain.map[BridgeStorage.CORE_URL_KEY])
        }
        // A development build's own cleartext host stays.
        plain.put(BridgeStorage.CORE_URL_KEY, "ws://192.0.2.10:8700/ws")
        assertFalse(s.forgetUnusableCoreUrl(cleartextHost = "192.0.2.10"))
        assertEquals("ws://192.0.2.10:8700/ws", plain.map[BridgeStorage.CORE_URL_KEY])
    }

    // --- home / away Core address (T21.3.3) ---------------------------------------

    private val away = "wss://box.example.ts.net/ws"
    private val home = "ws://10.0.0.2:8700/ws"

    @Test
    fun pageReadsTheSelectedAddressAndHomeStaysNativeOnly() {
        val plain = MapStore()
        val secret = MapStore()
        val s = BridgeStorage(plain, secret, cipher) {}
        s.set(BridgeStorage.CORE_URL_KEY, away)
        s.set(BridgeStorage.TOKEN_KEY, token)
        s.setHomeCoreUrl(home)
        // Not selected yet: the away address.
        assertEquals(away, s.get(BridgeStorage.CORE_URL_KEY))
        s.selectHome(true)
        assertEquals(home, s.get(BridgeStorage.CORE_URL_KEY))
        assertEquals(BridgeStorage.Connection(home, token), s.connection())
        // The page cannot read or write the native keys.
        assertNull(s.get(BridgeStorage.CORE_HOME_KEY))
        assertNull(s.get(BridgeStorage.USE_HOME_KEY))
        assertFalse(plain.map.values.contains(home))
        s.selectHome(false)
        assertEquals(away, s.get(BridgeStorage.CORE_URL_KEY))
    }

    @Test
    fun onlyAHomeAddressIsUsedWithoutSelection() {
        val s = BridgeStorage(MapStore(), MapStore(), cipher) {}
        s.setHomeCoreUrl(home)
        assertEquals(home, s.get(BridgeStorage.CORE_URL_KEY))
    }

    @Test
    fun aHomeAddressTheGateRefusesIsNeverHandedOut() {
        val secret = MapStore()
        val s = BridgeStorage(MapStore(), secret, cipher) {}
        s.set(BridgeStorage.CORE_URL_KEY, away)
        // Written behind the dialog's back (or by an older build): still refused.
        secret.put(BridgeStorage.CORE_HOME_KEY, "ws://box.example.test:8700/ws")
        s.selectHome(true)
        assertEquals(away, s.get(BridgeStorage.CORE_URL_KEY))
        secret.put(BridgeStorage.CORE_HOME_KEY, "ws://10.0.0.2@evil.example:8700/ws")
        assertEquals(away, s.get(BridgeStorage.CORE_URL_KEY))
    }

    @Test
    fun savingBackTheShownHomeAddressKeepsTheAwayAddress() {
        val plain = MapStore()
        val s = BridgeStorage(plain, MapStore(), cipher) {}
        s.set(BridgeStorage.CORE_URL_KEY, away)
        s.setHomeCoreUrl(home)
        s.selectHome(true)
        // The connect screen shows the address in use (home) and saves it again with a new token.
        s.set(BridgeStorage.CORE_URL_KEY, home)
        assertNull(s.connection())
        s.set(BridgeStorage.TOKEN_KEY, token)
        assertEquals(away, plain.map[BridgeStorage.CORE_URL_KEY])
        assertEquals(BridgeStorage.Connection(home, token), s.connection())
        // Same host and port, another path: a new address, not the home one written back.
        s.set(BridgeStorage.CORE_URL_KEY, "ws://10.0.0.2:8700/other")
        assertEquals("ws://10.0.0.2:8700/other", plain.map[BridgeStorage.CORE_URL_KEY])
        s.setHomeCoreUrl("ws://10.0.0.9:8700/ws")
        s.setHomeCoreUrl(home)
        s.selectHome(true)
        // A really new address replaces the away one and is used until the next check picks home.
        s.set(BridgeStorage.CORE_URL_KEY, newUrl)
        assertEquals(newUrl, plain.map[BridgeStorage.CORE_URL_KEY])
        assertEquals(newUrl, s.get(BridgeStorage.CORE_URL_KEY))
    }

    @Test
    fun changingTheHomeAddressResetsTheSelection() {
        val s = BridgeStorage(MapStore(), MapStore(), cipher) {}
        s.set(BridgeStorage.CORE_URL_KEY, away)
        s.setHomeCoreUrl(home)
        s.selectHome(true)
        s.setHomeCoreUrl(" $home ") // unchanged: selection kept
        assertEquals(home, s.get(BridgeStorage.CORE_URL_KEY))
        s.setHomeCoreUrl("ws://10.0.0.3:8700/ws")
        assertEquals(away, s.get(BridgeStorage.CORE_URL_KEY))
        s.setHomeCoreUrl(null)
        assertNull(s.homeCoreUrl())
        assertEquals(away, s.get(BridgeStorage.CORE_URL_KEY))
    }

    @Test
    fun anExistingWssAddressStaysTheAwayAddress() {
        // Upgrade from a version with one address: nothing to migrate, it is the away address.
        val plain = MapStore()
        plain.put(BridgeStorage.CORE_URL_KEY, away)
        val s = BridgeStorage(plain, MapStore(), cipher) {}
        assertFalse(s.forgetUnusableCoreUrl(cleartextHost = ""))
        assertEquals(away, s.awayCoreUrl())
        assertNull(s.homeCoreUrl())
    }

    // --- connection pair (address + token as one snapshot) ---------------------

    private val newUrl = "wss://new.example.test/ws"

    @Test
    fun addressWithoutItsTokenIsNotAPair() {
        val s = BridgeStorage(MapStore(), MapStore(), cipher) {}
        s.set(BridgeStorage.CORE_URL_KEY, "wss://old.example.test/ws")
        s.set(BridgeStorage.TOKEN_KEY, "old-token")
        // UI saving a new connection: address written, token not yet.
        s.set(BridgeStorage.CORE_URL_KEY, newUrl)
        assertNull(s.connection())
        // The page still sees both keys as before (bridge contract unchanged).
        assertEquals(newUrl, s.get(BridgeStorage.CORE_URL_KEY))
        assertEquals("old-token", s.get(BridgeStorage.TOKEN_KEY))
    }

    @Test
    fun tokenWriteCompletesThePair() {
        val s = BridgeStorage(MapStore(), MapStore(), cipher) {}
        s.set(BridgeStorage.CORE_URL_KEY, newUrl)
        s.set(BridgeStorage.TOKEN_KEY, token)
        assertEquals(BridgeStorage.Connection(newUrl, token), s.connection())
        assertFalse(s.connection().toString().contains(token))
    }

    @Test
    fun installWithoutTheFlagIsClean() {
        // Address and token saved by a version before the flag existed.
        val plain = MapStore()
        val secret = MapStore()
        BridgeStorage(plain, secret, cipher) {}.set(BridgeStorage.TOKEN_KEY, token)
        plain.put(BridgeStorage.CORE_URL_KEY, newUrl)
        assertNull(secret.get(BridgeStorage.PAIR_DIRTY_KEY))
        assertEquals(BridgeStorage.Connection(newUrl, token), BridgeStorage(plain, secret, cipher) {}.connection())
    }

    @Test
    fun failedTokenWriteLeavesThePairDirty() {
        val plain = MapStore()
        val secret = MapStore()
        BridgeStorage(plain, secret, cipher) {}.set(BridgeStorage.TOKEN_KEY, "old-token")
        val failing = object : TokenCipher {
            override fun encrypt(plain: String): String = throw GeneralSecurityException("keystore unavailable")
            override fun decrypt(blob: String): String? = cipher.decrypt(blob)
        }
        val s = BridgeStorage(plain, secret, failing) {}
        s.set(BridgeStorage.CORE_URL_KEY, newUrl)
        assertFalse(s.set(BridgeStorage.TOKEN_KEY, token))
        assertNull(s.connection())
    }

    @Test
    fun dirtyFlagSurvivesARestart() {
        // Process died between the two writes: a new instance over the same stores is still dirty.
        val plain = MapStore()
        val secret = MapStore()
        BridgeStorage(plain, secret, cipher) {}.apply {
            set(BridgeStorage.TOKEN_KEY, "old-token")
            set(BridgeStorage.CORE_URL_KEY, newUrl)
        }
        val reopened = BridgeStorage(plain, secret, cipher) {}
        assertNull(reopened.connection())
        reopened.set(BridgeStorage.TOKEN_KEY, token)
        assertEquals(BridgeStorage.Connection(newUrl, token), reopened.connection())
    }

    @Test
    fun dirtyFlagIsNotVisibleToThePage() {
        val s = BridgeStorage(MapStore(), MapStore(), cipher) {}
        s.set(BridgeStorage.CORE_URL_KEY, newUrl)
        assertNull(s.get(BridgeStorage.PAIR_DIRTY_KEY))
        // The page writing or removing that key name touches only its own plain key.
        s.remove(BridgeStorage.PAIR_DIRTY_KEY)
        assertNull(s.connection())
    }

    @Test
    fun missingHalfIsNotAPair() {
        val s = BridgeStorage(MapStore(), MapStore(), cipher) {}
        s.set(BridgeStorage.TOKEN_KEY, token)
        assertNull(s.connection())
        s.set(BridgeStorage.CORE_URL_KEY, newUrl)
        s.set(BridgeStorage.TOKEN_KEY, token)
        s.remove(BridgeStorage.TOKEN_KEY)
        assertNull(s.connection())
    }
}
