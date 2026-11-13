package au.sam.seamless

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class CookieStoreTest {
    private val url = "http://192.168.1.5:4901/api/me".toHttpUrl()
    private var clock = 1_000_000L

    private fun session(value: String = "tok", maxAgeMs: Long = 90L * 86_400_000) =
        Cookie.Builder().name("smsession").value(value).hostOnlyDomain("192.168.1.5").path("/").httpOnly().expiresAt(clock + maxAgeMs).build()

    @Test fun survivesRestart() {
        val store = MemoryStore()
        PersistentCookieJar(store) { clock }.saveFromResponse(url, listOf(session()))
        val reborn = PersistentCookieJar(store) { clock } // new process, same storage
        assertTrue(reborn.hasCookies())
        val sent = reborn.loadForRequest(url)
        assertEquals(1, sent.size)
        assertEquals("tok", sent[0].value)
        assertTrue(sent[0].httpOnly)
    }

    @Test fun notSentToOtherHosts() {
        val jar = PersistentCookieJar(MemoryStore()) { clock }
        jar.saveFromResponse(url, listOf(session()))
        assertTrue(jar.loadForRequest("http://192.168.1.6:4901/".toHttpUrl()).isEmpty())
    }

    @Test fun replacesSameCookieAndDropsExpired() {
        val store = MemoryStore()
        val jar = PersistentCookieJar(store) { clock }
        jar.saveFromResponse(url, listOf(session("a")))
        jar.saveFromResponse(url, listOf(session("b")))
        assertEquals(listOf("b"), jar.loadForRequest(url).map { it.value })
        clock += 91L * 86_400_000
        assertTrue(jar.loadForRequest(url).isEmpty())
        assertFalse(PersistentCookieJar(store) { clock }.hasCookies())
    }

    @Test fun serverClearingTheCookieRemovesIt() {
        val jar = PersistentCookieJar(MemoryStore()) { clock }
        jar.saveFromResponse(url, listOf(session()))
        jar.saveFromResponse(url, listOf(session("").let { Cookie.Builder().name("smsession").value("").hostOnlyDomain("192.168.1.5").path("/").expiresAt(0).build() }))
        assertFalse(jar.hasCookies())
    }

    @Test fun clearForgetsEverythingAndCorruptStorageIsIgnored() {
        val store = MemoryStore()
        val jar = PersistentCookieJar(store) { clock }
        jar.saveFromResponse(url, listOf(session()))
        jar.clear()
        assertFalse(PersistentCookieJar(store) { clock }.hasCookies())
        store.put("cookies", "not json")
        assertFalse(PersistentCookieJar(store) { clock }.hasCookies())
    }
}
