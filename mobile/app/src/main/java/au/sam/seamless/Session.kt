package au.sam.seamless

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class PrefsStore(private val p: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = p.getString(key, null)
    override fun put(key: String, value: String?) { p.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply() }
}

/** What is remembered between launches: the server address, who is signed in, and (via the jar) the cookie. */
class Session(private val store: KeyValueStore, val jar: PersistentCookieJar) {
    var serverUrl: String
        get() = store.get("server").orEmpty()
        set(v) = store.put("server", v)
    var email: String
        get() = store.get("email").orEmpty()
        set(v) = store.put("email", v)

    val hasSession: Boolean get() = serverUrl.isNotEmpty() && jar.hasCookies()

    /** Forget the sign-in but keep the address, so the login screen is pre-filled. */
    fun clear() { jar.clear() }

    companion object {
        fun create(ctx: Context): Session {
            val prefs = try {
                val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
                EncryptedSharedPreferences.create(ctx, "seamless_secure", key,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
            } catch (_: Exception) {
                // Keystore damaged (restored phone, etc.): start clean rather than crash.
                ctx.deleteSharedPreferences("seamless_secure")
                try {
                    val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
                    EncryptedSharedPreferences.create(ctx, "seamless_secure", key,
                        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
                } catch (_: Exception) { ctx.getSharedPreferences("seamless_plain", Context.MODE_PRIVATE) }
            }
            val store = PrefsStore(prefs)
            return Session(store, PersistentCookieJar(store))
        }
    }
}
