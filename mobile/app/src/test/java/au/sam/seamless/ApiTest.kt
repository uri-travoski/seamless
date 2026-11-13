package au.sam.seamless
import okhttp3.HttpUrl.Companion.toHttpUrl

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ApiTest {
    private lateinit var server: MockWebServer
    private lateinit var base: String
    private lateinit var api: Api
    private var unauthorized = 0
    private fun res(name: String) = javaClass.classLoader!!.getResource(name)!!.readText()

    @Before fun up() {
        server = MockWebServer().also { it.start() }
        base = server.url("/").toString().trimEnd('/')
        api = Api(PersistentCookieJar(MemoryStore()), "0.1.0", "Test Phone", allowEmulatorHost = true, onUnauthorized = { unauthorized++ })
    }
    @After fun down() { server.shutdown() }

    @Test fun parsesRealServerSamples() {
        val out = Api(PersistentCookieJar(MemoryStore()), "0", "d").json.decodeFromString<MeResponse>(res("me_signed_out.json"))
        assertFalse(out.loggedIn); assertEquals("Seamless", out.server?.name); assertEquals("2.0.0", out.server?.version)
        val inn = Api(PersistentCookieJar(MemoryStore()), "0", "d").json.decodeFromString<MeResponse>(res("me_signed_in.json"))
        assertTrue(inn.loggedIn); assertEquals("reallybasic@gmail.com", inn.user?.email); assertEquals("admin", inn.user?.role)
        val cfg = Api(PersistentCookieJar(MemoryStore()), "0", "d").json.decodeFromString<MobileConfig>(res("mobile_config.json"))
        assertEquals("live", cfg.mode)
    }

    @Test fun serverInfoShowsNameAndVersion() {
        server.enqueue(MockResponse().setBody(res("me_signed_out.json")))
        val r = api.serverInfo(base) as ApiResult.Ok
        assertEquals("2.0.0", r.value.server?.version)
        val req = server.takeRequest()
        assertEquals("android/0.1.0", req.getHeader("X-Seamless-Client"))
        assertEquals("Test Phone", req.getHeader("X-Seamless-Device"))
    }

    @Test fun notSeamlessIsExplained() {
        server.enqueue(MockResponse().setBody("{\"hello\":1}"))
        assertTrue(api.serverInfo(base) is ApiResult.Failed)
        server.enqueue(MockResponse().setBody("<html>nope</html>"))
        assertTrue((api.serverInfo(base) as ApiResult.Network).message.contains("Seamless"))
        server.enqueue(MockResponse().setResponseCode(404).setBody("Not found"))
        assertTrue((api.serverInfo(base) as ApiResult.Failed).message.contains("Seamless"))
    }

    @Test fun wrongPasswordUsesServerWordsAndIsNotAnAppSignOut() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"wrong email or password\"}"))
        val r = api.login(base, "a@b.c", "x") as ApiResult.Failed
        assertEquals(401, r.status); assertEquals("Wrong email or password.", r.message)
        assertEquals(0, unauthorized)
    }

    @Test fun rateLimitAndServerErrorsGetPlainWords() {
        server.enqueue(MockResponse().setResponseCode(429).setBody("{\"error\":\"too many attempts, try later\"}"))
        assertEquals("Too many attempts, try later.", (api.login(base, "a@b.c", "x") as ApiResult.Failed).message)
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>"))
        assertTrue((api.login(base, "a@b.c", "x") as ApiResult.Failed).message.contains("problem"))
    }

    @Test fun mfaStepAndCookieSession() {
        server.enqueue(MockResponse().setBody("{\"ok\":false,\"mfaRequired\":true,\"mfaToken\":\"t1\"}"))
        val l = (api.login(base, "a@b.c", "pw") as ApiResult.Ok).value
        assertTrue(l.mfaRequired); assertEquals("t1", l.mfaToken)
        server.takeRequest()
        server.enqueue(MockResponse().setBody("{\"ok\":true}").addHeader("Set-Cookie", "smsession=abc; Path=/; HttpOnly; Max-Age=7776000"))
        assertTrue(api.loginMfa(base, "t1", " 123456 ") is ApiResult.Ok)
        assertEquals("{\"mfaToken\":\"t1\",\"code\":\"123456\"}", server.takeRequest().body.readUtf8())
        assertTrue(api.jar.hasCookies())
        server.enqueue(MockResponse().setBody(res("me_signed_in.json")))
        assertTrue(api.me(base) is ApiResult.Ok)
        assertEquals("smsession=abc", server.takeRequest().getHeader("Cookie"))
    }

    @Test fun revokedSessionClearsCookiesAndNotifiesOnce() {
        server.enqueue(MockResponse().setBody("{\"ok\":true}").addHeader("Set-Cookie", "smsession=abc; Path=/; Max-Age=7776000"))
        api.login(base, "a@b.c", "pw")
        assertTrue(api.jar.hasCookies())
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"unauthorized\"}"))
        assertTrue(api.mobileConfig(base) is ApiResult.Unauthorized)
        assertFalse(api.jar.hasCookies())
        assertEquals(1, unauthorized)
    }

    @Test fun networkFailuresBecomeWords() {
        val dead = base
        server.shutdown()
        val r = api.me(dead) as ApiResult.Network
        assertTrue(r.message.isNotBlank())
        assertTrue((api.me("http://nonexistent.invalid") as ApiResult.Network).message.isNotBlank())
    }

    @Test fun plainHttpToPublicHostIsBlockedBeforeSending() {
        val r = api.me("http://example.com") as ApiResult.Network
        assertTrue(r.message.contains("home network"))
    }

    @Test fun sessionRemembersAddressAndForgetsCookie() {
        val store = MemoryStore(); val jar = PersistentCookieJar(store)
        val s = Session(store, jar)
        assertFalse(s.hasSession)
        s.serverUrl = base
        jar.saveFromResponse(base.toHttpUrl(), listOf(okhttp3.Cookie.Builder().name("smsession").value("x").hostOnlyDomain(server.hostName).path("/").expiresAt(System.currentTimeMillis() + 100000).build()))
        assertTrue(s.hasSession)
        s.clear()
        assertFalse(s.hasSession); assertEquals(base, s.serverUrl)
    }
}
