package au.sam.seamless

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ConversationTest {
    private lateinit var server: MockWebServer
    private lateinit var base: String
    private lateinit var api: Api

    @Before fun up() {
        server = MockWebServer().also { it.start() }
        base = server.url("/").toString().trimEnd('/')
        api = Api(PersistentCookieJar(MemoryStore()), "0.1.0", "Test Phone", allowEmulatorHost = true)
    }
    @After fun down() { server.shutdown() }

    private fun email(id: String, unread: Boolean = false, at: String = "2026-11-01T10:00:00Z") =
        ApiEmail(id = id, receivedAt = at, keywords = if (unread) emptyMap() else mapOf("\$seen" to true))

    // ---- links ----
    @Test fun linksOpenOnlyAfterTheRealAddressIsShown() {
        val ok = LinkGuard.check("https://example.com/a?b=1") as LinkVerdict.Allowed
        assertEquals("example.com", ok.host); assertEquals("https://example.com/a?b=1", ok.url)
        assertTrue(LinkGuard.check("http://example.com") is LinkVerdict.Allowed)
        assertTrue(LinkGuard.check("mailto:a@b.com?subject=x") is LinkVerdict.Allowed)
    }

    @Test fun dangerousLinkKindsAreBlocked() {
        for (u in listOf("file:///sdcard/x", "content://media/1", "javascript:alert(1)", "intent://x#Intent;end", "data:text/html,hi", "FILE:///etc/passwd", "no-scheme", "https://"))
            assertTrue("$u should be blocked", LinkGuard.check(u) is LinkVerdict.Blocked)
    }

    // ---- html wrapper ----
    @Test fun pageBlocksRemotePicturesUntilAllowed() {
        val blocked = BodyHtml.page("<p>Hi</p><img src=\"/api/blob/m1/0\">", null, false, false, "http://10.0.2.2:4901")
        assertTrue(blocked.contains("img-src data: http://10.0.2.2:4901"))
        assertTrue(blocked.contains("default-src 'none'"))
        assertFalse(blocked.contains("script-src"))
        val shown = BodyHtml.page("<img class=\"md-blocked-img\" data-md-src=\"https://x.test/p.png\">", null, false, true, "http://s")
        assertTrue(shown.contains("img-src https: http: data:"))
        assertTrue(shown.contains("src=\"https://x.test/p.png\""))
    }

    @Test fun darkModeInjectsColoursAndPlainTextIsEscaped() {
        val d = BodyHtml.page(null, "a <b> & c", true, false, "http://s")
        assertTrue(d.contains("color-scheme:dark")); assertTrue(d.contains("a &lt;b&gt; &amp; c"))
        assertFalse(BodyHtml.page("<p>x</p>", null, false, false, "http://s").contains("color-scheme:dark"))
        assertTrue(BodyHtml.page(null, null, false, false, "http://s").contains("(No content)"))
    }

    // ---- thread ----
    @Test fun newestAndUnreadMessagesStartExpanded() {
        val t = listOf(email("m1"), email("m2", unread = true), email("m3"))
        assertEquals(setOf("m2", "m3"), initiallyExpanded(t))
        assertEquals(setOf("m1"), initiallyExpanded(listOf(email("m1"))))
        assertTrue(initiallyExpanded(emptyList()).isEmpty())
    }

    @Test fun recipientLineSaysMe() {
        val to = listOf(ApiAddress("Me", "me@x.test"), ApiAddress("Sam", "sam@x.test"), ApiAddress("", "c@x.test"))
        assertEquals("to me, Sam +1", ConvFormat.toLine(to, setOf("me@x.test")))
        assertEquals("to (no recipients)", ConvFormat.toLine(emptyList(), emptySet()))
        assertEquals("1.5 MB", ConvFormat.size(1_572_864)); assertEquals("12 KB", ConvFormat.size(12_300))
    }

    // ---- parsing ----
    @Test fun parsesBodyWithInviteAttachmentsAndBadges() {
        val b = api.json.decodeFromString<ApiBody>("""{"id":"m5","html":"<p>x</p>","text":null,"hasBlockedRemote":true,"note":"",
          "attachments":[{"partId":"0","filename":"a.pdf","contentType":"application/pdf","size":2048,"cid":null,"inline":false},
                         {"partId":"1","filename":"logo.png","contentType":"image/png","size":10,"cid":"c1","inline":true}],
          "headers":{"deliveredTo":null},"tracking":null,
          "invite":{"id":7,"summary":"Standup","startsAt":1700000000000,"allDay":false,"location":"Room 1","organizer":{"name":"Al","email":"al@x.test"},"attendees":[],"status":"active","myPartstat":null,"canRsvp":true,"method":"REQUEST"},
          "pgp":{"encrypted":true,"decrypted":true,"signature":"verified"},"smime":{"encrypted":false,"decrypted":false,"signature":"bad"}}""")
        assertTrue(b.hasBlockedRemote); assertEquals(listOf("a.pdf"), b.attachments.filter { it.listed }.map { it.filename })
        assertEquals(7, b.invite!!.id); assertTrue(b.invite!!.canRsvp)
        assertEquals("OpenPGP: decrypted, signature verified", b.pgp!!.badge("OpenPGP"))
        assertEquals("S/MIME: BAD signature", b.smime!!.badge("S/MIME"))
        assertNull(ApiCrypto().badge("OpenPGP"))
    }

    @Test fun parsesWhyAndRisk() {
        val w = api.json.decodeFromString<ApiWhy>("""{"visible":true,"filedBy":"ai","corrected":false,"confidence":0.92,"reason":"looks like a receipt","labels":[{"id":3,"name":"Receipts"}]}""")
        assertEquals("Filed by AI · 92 %", w.line())
        assertEquals("Fixed by you", w.copy(corrected = true, confidence = null).line())
        assertEquals("Filed by a rule", w.copy(filedBy = "rule").line())
        assertFalse(api.json.decodeFromString<ApiWhy>("""{"visible":false}""").visible)
        val e = api.json.decodeFromString<ApiEmail>("""{"id":"m1","risk":{"level":"high","reasons":[{"code":"x","severity":"high","text":"Link text hides the real address"}]}}""")
        assertEquals("Link text hides the real address", e.risk!!.reasons.first().text)
    }

    // ---- requests ----
    @Test fun threadAndBodyRequests() {
        server.enqueue(MockResponse().setBody("""{"methodResponses":[["Thread/get",{"list":[{"id":"t1","emailIds":["m1","m2"]}]},"a"]]}"""))
        assertEquals(listOf("m1", "m2"), (api.threadEmailIds(base, "t1") as ApiResult.Ok).value)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"Thread/get\""))
        server.enqueue(MockResponse().setBody("""{"id":"m2","html":"<p>hi</p>","hasBlockedRemote":false,"attachments":[]}"""))
        api.body(base, "m2", remote = true)
        assertEquals("/api/message/m2/body?remote=1", server.takeRequest().path)
        server.enqueue(MockResponse().setBody("""{"id":"m2","html":"x"}"""))
        api.body(base, "m2", remote = false)
        assertEquals("/api/message/m2/body", server.takeRequest().path)
    }

    @Test fun rsvpCorrectionAndDownloadRequests() {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        assertTrue(api.rsvp(base, 7, "ACCEPTED") is ApiResult.Ok)
        val r = server.takeRequest(); assertEquals("/api/invites/7/rsvp", r.path); assertEquals("""{"partstat":"ACCEPTED"}""", r.body.readUtf8())
        server.enqueue(MockResponse().setBody("""{"correctionId":12,"remembered":true,"offerRule":null}"""))
        assertEquals(12, (api.correct(base, "m1", 3, true) as ApiResult.Ok).value)
        val c = server.takeRequest(); assertEquals("/api/message/m1/correct", c.path); assertEquals("""{"labelId":3,"remember":true}""", c.body.readUtf8())
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api.correct(base, "m1", null, false)
        assertEquals("""{"labelId":null,"remember":false}""", server.takeRequest().body.readUtf8())
        server.enqueue(MockResponse().setBody("PDFDATA").setHeader("Content-Type", "application/pdf"))
        val out = java.io.ByteArrayOutputStream()
        assertEquals(7L, (api.downloadAttachment(base, "m1", "0", out) as ApiResult.Ok).value); assertEquals("PDFDATA", out.toString())
        assertEquals("/api/blob/m1/0?download=1", server.takeRequest().path)
        server.enqueue(MockResponse().setResponseCode(404))
        assertTrue(api.downloadAttachment(base, "m1", "9", java.io.ByteArrayOutputStream()) is ApiResult.Failed)
    }

    @Test fun alwaysShowImagesIsRememberedPerSender() {
        val s = Session(MemoryStore(), PersistentCookieJar(MemoryStore()))
        assertTrue(s.imageSenders.isEmpty())
        s.imageSenders = s.imageSenders + "news@x.test"
        assertEquals(setOf("news@x.test"), s.imageSenders)
    }
}
