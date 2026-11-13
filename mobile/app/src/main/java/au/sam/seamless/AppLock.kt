package au.sam.seamless

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

sealed interface PinResult {
    data object Ok : PinResult
    data class Wrong(val triesBeforeDelay: Int) : PinResult
    data class Locked(val seconds: Int) : PinResult
}

/**
 * The app lock: a 6-digit PIN (stored only as a salted PBKDF2 hash, inside the encrypted preferences) and an optional
 * fingerprint shortcut. Too many wrong PINs make the app wait: 30 s after 5 misses, doubling each time, up to 10 minutes.
 */
class AppLock(private val store: KeyValueStore, private val now: () -> Long = System::currentTimeMillis) {
    val enabled: Boolean get() = !store.get("pinHash").isNullOrEmpty()
    var biometric: Boolean
        get() = enabled && store.get("pinBio") == "true"
        set(v) = store.put("pinBio", v.toString())
    private var fails: Int
        get() = store.get("pinFails")?.toIntOrNull() ?: 0
        set(v) = store.put("pinFails", v.toString())
    private var lockedUntil: Long
        get() = store.get("pinLockedUntil")?.toLongOrNull() ?: 0L
        set(v) = store.put("pinLockedUntil", v.toString())

    fun setPin(pin: String) {
        require(isValid(pin)) { "PIN must be 6 digits" }
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        store.put("pinSalt", hex(salt)); store.put("pinHash", hex(hash(pin, salt)))
        fails = 0; lockedUntil = 0
    }

    fun remove() {
        for (k in listOf("pinSalt", "pinHash", "pinBio", "pinFails", "pinLockedUntil")) store.put(k, null)
    }

    fun secondsLeft(): Int = ((lockedUntil - now() + 999) / 1000).toInt().coerceAtLeast(0)

    fun verify(pin: String): PinResult {
        val wait = secondsLeft()
        if (wait > 0) return PinResult.Locked(wait)
        val salt = unhex(store.get("pinSalt").orEmpty()); val want = store.get("pinHash").orEmpty()
        if (want.isNotEmpty() && isValid(pin) && MessageDigest.isEqual(hex(hash(pin, salt)).toByteArray(), want.toByteArray())) {
            fails = 0; lockedUntil = 0
            return PinResult.Ok
        }
        val n = fails + 1
        fails = n
        if (n >= 5) {
            val secs = minOf(30L shl (n - 5).coerceAtMost(5), 600L)
            lockedUntil = now() + secs * 1000
            return PinResult.Locked(secs.toInt())
        }
        return PinResult.Wrong(5 - n)
    }

    /** A fingerprint success clears the miss counter, like a right PIN. */
    fun biometricOk() { fails = 0; lockedUntil = 0 }

    companion object {
        fun isValid(pin: String) = pin.length == 6 && pin.all { it in '0'..'9' }
        private fun hash(pin: String, salt: ByteArray): ByteArray =
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(PBEKeySpec(pin.toCharArray(), salt, 120_000, 256)).encoded
        private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
        private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
