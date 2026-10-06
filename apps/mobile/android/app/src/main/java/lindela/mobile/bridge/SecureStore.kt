package lindela.mobile.bridge

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The API key, encrypted under a key that lives in the Android Keystore.
 *
 * The single most valuable thing this shell adds. Today the key sits in
 * `localStorage`, which any script that reaches the origin can read, and there is
 * no browser API that changes that — a lost handset publishes somebody else's
 * district for as long as the token is valid.
 *
 * AES-GCM with a per-value random IV, and the key generated inside the Keystore
 * and never leaving it. `EncryptedSharedPreferences` would be fewer lines and is
 * deprecated in current AndroidX; the Keystore call underneath is the same one,
 * and doing it directly means the storage format is one this file owns.
 *
 * `setUserAuthenticationRequired` is deliberately false: a health worker locking
 * their phone and finding their queued reports unable to send is a worse failure
 * than a key that does not need a biometric. The threat here is a lost or stolen
 * handset being unlocked by whoever has it, not a shoulder-surfer.
 */
object SecureStore {

    private const val KEY_ALIAS = "lindela_api_key"
    private const val PREFS = "lindela_secure_store"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_LENGTH = 12
    private const val TAG_LENGTH_BITS = 128

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    fun write(context: Context, key: String, value: String): Boolean = try {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        // IV and ciphertext together: the IV is not secret, and a store that kept
        // it separately would need two writes that could disagree.
        val payload = Base64.encodeToString(cipher.iv + ciphertext, Base64.NO_WRAP)
        prefs(context).edit().putString(key, payload).apply()
        true
    } catch (error: Exception) {
        // A keystore that has been invalidated — a restored backup, a changed
        // screen lock — throws here. Refusing to store is the honest answer:
        // the page falls back to localStorage and says the key is not secure.
        Log.e("LindelaSecureStore", "could not store $key", error)
        false
    }

    fun read(context: Context, key: String): String? {
        return try {
            val payload = prefs(context).getString(key, null)
            if (payload.isNullOrBlank()) return null
            val raw = Base64.decode(payload, Base64.NO_WRAP)
            if (raw.size <= IV_LENGTH) return null
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE, secretKey(),
                GCMParameterSpec(TAG_LENGTH_BITS, raw, 0, IV_LENGTH)
            )
            String(cipher.doFinal(raw, IV_LENGTH, raw.size - IV_LENGTH), Charsets.UTF_8)
        } catch (error: Exception) {
            // A key the Keystore no longer holds — a restored backup, a changed
            // screen lock — throws here. `null` is the answer, and the page
            // falls back rather than reading a value it cannot decrypt.
            Log.e("LindelaSecureStore", "could not read $key", error)
            null
        }
    }

    fun remove(context: Context, key: String): Boolean = try {
        prefs(context).edit().remove(key).apply()
        true
    } catch (error: Exception) {
        Log.e("LindelaSecureStore", "could not remove $key", error)
        false
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
