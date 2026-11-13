package au.sam.seamless

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/** Where cookies are kept between launches (EncryptedSharedPreferences in the app, a map in tests). */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

class MemoryStore : KeyValueStore {
    private val m = HashMap<String, String>()
    override fun get(key: String) = m[key]
    override fun put(key: String, value: String?) { if (value == null) m.remove(key) else m[key] = value }
}

@Serializable
private data class StoredCookie(
    val name: String, val value: String, val expiresAt: Long, val domain: String,
    val path: String, val secure: Boolean, val httpOnly: Boolean, val hostOnly: Boolean,
)

/** Cookie jar that survives process death; expired cookies are dropped on load and save. */
class PersistentCookieJar(private val store: KeyValueStore, private val now: () -> Long = System::currentTimeMillis) : CookieJar {
    private val json = Json { ignoreUnknownKeys = true }
    private var cookies: MutableList<Cookie> = load()

    @Synchronized private fun load(): MutableList<Cookie> {
        val raw = store.get(KEY) ?: return mutableListOf()
        return try {
            json.decodeFromString<List<StoredCookie>>(raw).map {
                Cookie.Builder().name(it.name).value(it.value).expiresAt(it.expiresAt).path(it.path).apply {
                    if (it.hostOnly) hostOnlyDomain(it.domain) else domain(it.domain)
                    if (it.secure) secure()
                    if (it.httpOnly) httpOnly()
                }.build()
            }.filter { it.expiresAt > now() }.toMutableList()
        } catch (_: Exception) { mutableListOf() }
    }

    @Synchronized private fun save() {
        cookies.removeAll { it.expiresAt <= now() }
        store.put(KEY, json.encodeToString(cookies.map {
            StoredCookie(it.name, it.value, it.expiresAt, it.domain, it.path, it.secure, it.httpOnly, it.hostOnly)
        }))
    }

    @Synchronized override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (c in cookies) {
            this.cookies.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }
            this.cookies.add(c) // an already-expired cookie (server clearing it) is removed by save()
        }
        save()
    }

    @Synchronized override fun loadForRequest(url: HttpUrl): List<Cookie> =
        cookies.filter { it.expiresAt > now() && it.matches(url) }

    @Synchronized fun hasCookies(): Boolean = cookies.any { it.expiresAt > now() }

    @Synchronized fun clear() { cookies.clear(); store.put(KEY, null) }

    private companion object { const val KEY = "cookies" }
}
