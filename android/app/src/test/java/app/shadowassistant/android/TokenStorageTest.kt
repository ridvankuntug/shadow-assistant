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
    fun seedsCoreUrlOnceOnly() {
        val plain = MapStore()
        val flags = MapStore()
        val s = BridgeStorage(plain, MapStore(), cipher) {}
        s.seedDefaults(flags)
        assertEquals(CoreAddress.DEFAULT_URL, s.get(BridgeStorage.CORE_URL_KEY))
        s.remove(BridgeStorage.CORE_URL_KEY)
        s.seedDefaults(flags)
        assertNull(s.get(BridgeStorage.CORE_URL_KEY))
    }

    @Test
    fun seedingKeepsAUserValue() {
        val plain = MapStore()
        plain.put(BridgeStorage.CORE_URL_KEY, "wss://example.test/ws")
        BridgeStorage(plain, MapStore(), cipher) {}.seedDefaults(MapStore())
        assertEquals("wss://example.test/ws", plain.map[BridgeStorage.CORE_URL_KEY])
    }
}
