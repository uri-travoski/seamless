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

    var lastUser: String
        get() = store.get("lastUser").orEmpty()
        set(v) = store.put("lastUser", v)

    /** Which mailbox/category the list shows; survives restarts. */
    var scope: String
        get() = store.get("scope") ?: "unified"
        set(v) = store.put("scope", v)

    var recentSearches: List<String>
        get() = store.get("recent")?.split('\n')?.filter { it.isNotBlank() }.orEmpty()
        set(v) = store.put("recent", v.joinToString("\n"))

    /** Newest first, no duplicates, at most 10. */
    fun addRecentSearch(q: String) {
        val t = q.trim().replace('\n', ' ')
        if (t.isEmpty()) return
        recentSearches = (listOf(t) + recentSearches.filter { !it.equals(t, true) }).take(10)
    }

    // ---- app settings that stay on this phone (T9.4) ----
    var swipeRight: String
        get() = store.get("swipeRight") ?: "archive"
        set(v) = store.put("swipeRight", v)
    var swipeLeft: String
        get() = store.get("swipeLeft") ?: "delete"
        set(v) = store.put("swipeLeft", v)
    var conversationView: Boolean
        get() = store.get("conversationView") != "false"
        set(v) = store.put("conversationView", v.toString())
    var notifyMail: Boolean
        get() = store.get("notifyMail") != "false"
        set(v) = store.put("notifyMail", v.toString())
    var notifyAlerts: Boolean
        get() = store.get("notifyAlerts") != "false"
        set(v) = store.put("notifyAlerts", v.toString())
    var hideContent: Boolean
        get() = store.get("hideContent") == "true"
        set(v) = store.put("hideContent", v.toString())
    var theme: String
        get() = store.get("theme") ?: "system"
        set(v) = store.put("theme", v)
    /** Email of the identity new messages start from; empty = follow the mailbox being viewed. */
    var defaultFrom: String
        get() = store.get("defaultFrom").orEmpty()
        set(v) = store.put("defaultFrom", v)

    /** Senders whose remote images always load (kept on this phone). Lower-case addresses. */
    var imageSenders: Set<String>
        get() = store.get("imageSenders")?.split('\n')?.filter { it.isNotBlank() }?.toSet().orEmpty()
        set(v) = store.put("imageSenders", v.joinToString("\n"))

    // ---- push and background sync (T9.7) ----
    var fcmToken: String
        get() = store.get("fcmToken").orEmpty()
        set(v) = store.put("fcmToken", v)
    /** True once the server has accepted this phone's FCM token and has push switched on. Then the polling fallback stays quiet. */
    var pushActive: Boolean
        get() = store.get("pushActive") == "true"
        set(v) = store.put("pushActive", v.toString())
    var notifyPromptShown: Boolean
        get() = store.get("notifyPromptShown") == "true"
        set(v) = store.put("notifyPromptShown", v.toString())
    /** Message ids the fallback sync has already looked at (null = never ran: first run is a baseline). */
    var syncSeen: List<String>?
        get() = store.get("syncSeen")?.split('\n')?.filter { it.isNotBlank() }
        set(v) = store.put("syncSeen", v?.joinToString("\n"))
    var syncAlerts: Set<Int>
        get() = store.get("syncAlerts")?.split(',')?.mapNotNull { it.toIntOrNull() }?.toSet().orEmpty()
        set(v) = store.put("syncAlerts", v.joinToString(","))
    var lastSyncAt: Long
        get() = store.get("lastSyncAt")?.toLongOrNull() ?: 0L
        set(v) = store.put("lastSyncAt", v.toString())
    /** accountId → mailbox name, so a background notification can say which mailbox it is for. */
    var accountNames: Map<Int, String>
        get() = store.get("accountNames")?.split('\n')?.mapNotNull { l -> l.split('\t', limit = 2).takeIf { it.size == 2 }?.let { (a, b) -> a.toIntOrNull()?.let { it to b } } }?.toMap().orEmpty()
        set(v) = store.put("accountNames", v.entries.joinToString("\n") { "${it.key}\t${it.value.replace('\n', ' ')}" })

    val hasSession: Boolean get() = serverUrl.isNotEmpty() && jar.hasCookies()

    /** Forget the sign-in but keep the address, so the login screen is pre-filled. */
    fun clear() { jar.clear(); store.put("recent", null); store.put("pushActive", null); store.put("syncSeen", null); store.put("syncAlerts", null); store.put("accountNames", null) }

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
