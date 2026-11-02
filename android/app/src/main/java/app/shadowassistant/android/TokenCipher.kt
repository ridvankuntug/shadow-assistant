package app.shadowassistant.android

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts small secrets (the device token) for storage at rest. */
interface TokenCipher {
    /** Returns an opaque, storable blob. Throws [GeneralSecurityException] if encryption is impossible. */
    fun encrypt(plain: String): String

    /** Returns the plaintext, or null if the blob is malformed, tampered with or the key is gone. */
    fun decrypt(blob: String): String?
}

/**
 * AES-256-GCM with a 96-bit IV chosen by the cipher provider for every
 * encryption and a 128-bit tag. Blob format: `v1:<base64 iv>:<base64 ciphertext+tag>`.
 * [aad] binds a blob to its purpose (a blob cannot be replayed under another name).
 *
 * The key comes from [key]; on the device that is a non-exportable Android
 * Keystore key ([AndroidKeystoreKey]), in unit tests a software key.
 */
class AesGcmTokenCipher(
    private val key: () -> SecretKey,
    private val aad: ByteArray,
) : TokenCipher {
    override fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        // No IV passed: the provider generates a fresh random one (the Keystore requires this).
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(aad)
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv ?: throw GeneralSecurityException("cipher returned no IV")
        val b64 = Base64.getEncoder()
        return "$VERSION:${b64.encodeToString(iv)}:${b64.encodeToString(ct)}"
    }

    override fun decrypt(blob: String): String? {
        val parts = blob.split(':')
        if (parts.size != 3 || parts[0] != VERSION) return null
        return try {
            val dec = Base64.getDecoder()
            val iv = dec.decode(parts[1])
            val ct = dec.decode(parts[2])
            if (iv.size != IV_BYTES || ct.size < TAG_BITS / 8) return null
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(aad)
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null // bad base64
        }
    }

    companion object {
        const val VERSION = "v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

/**
 * An AES-256 key that lives in the Android Keystore: generated on first use,
 * never leaves secure hardware/the keystore daemon (not exportable), usable
 * only for AES-GCM with randomized IVs. No user authentication is required:
 * the app must connect without a prompt when opened from the power button.
 */
object AndroidKeystoreKey {
    private const val PROVIDER = "AndroidKeyStore"

    @Synchronized
    fun getOrCreate(alias: String): SecretKey {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }
}
