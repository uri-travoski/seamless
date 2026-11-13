package au.sam.seamless

import androidx.compose.ui.text.input.TextFieldValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream

class ComposeTest {
    private lateinit var server: MockWebServer
    private lateinit var base: String
    private lateinit var api: Api
    private val seen = java.util.concurrent.CopyOnWriteArrayList<RecordedRequest>()
    private var sendAnswer = """{"ok":true,"queued":true,"jobId":7,"releaseAt":${System.currentTimeMillis() + 10000}}"""
    private var sendCode = 200

    private val identitiesJson = """[{"accountId":1,"email":"me@demo.test","name":"Me","isAlias":false,"id":11,"isDefault":true},
        {"accountId":2,"email":"work@demo.test","name":"Work","isAlias":false,"id":12}]"""

    @Before fun up() {
        server = MockWebServer().also {
            it.dispatcher = object : Dispatcher() {
                override fun dispatch(r: RecordedRequest): MockResponse {
                    seen.add(r)
                    val p = r.path.orEmpty()
                    return when {
                        p == "/api/identities" -> MockResponse().setBody(identitiesJson)
                        p.startsWith("/api/identities/") && p.endsWith("/signature") -> MockResponse().setBody("""{"html":"<div data-seamless-signature><p>— Me</p></div>"}""")
                        p == "/api/identity/match" -> MockResponse().setBody("""{"email":"work@demo.test","accountId":2}""")
                        p.startsWith("/api/message/") && p.contains("/body") -> MockResponse().setBody("""{"id":"m5","html":"<p>Original</p>","text":"Original"}""")
                        p == "/api/contacts/suggest?q=an" -> MockResponse().setBody("""[{"name":"Ann Lee","email":"ann@demo.test"}]""")
                        p == "/api/send" -> MockResponse().setResponseCode(sendCode).setBody(sendAnswer)
                        p == "/api/upload" -> MockResponse().setBody("""{"id":"u1","filename":"a.txt","contentType":"text/plain","size":5}""")
                        p == "/api/send/undo" -> MockResponse().setBody("""{"payload":{"accountId":1,"fromEmail":"me@demo.test","to":[{"email":"x@demo.test","name":""}],"cc":[],"bcc":[],"subject":"Hello","html":"<p>Hi</p>","attachmentIds":[]}}""")
                        p == "/api/draft" || p == "/api/schedule" -> MockResponse().setBody("""{"ok":true}""")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            it.start()
        }
        base = server.url("/").toString().trimEnd('/')
        api = Api(PersistentCookieJar(MemoryStore()), "0.1.0", "Test Phone", allowEmulatorHost = true)
    }
    @After fun down() { server.shutdown() }

    private val files = object : FileAccess {
        override fun describe(uri: String) = if (uri == "content://big") Triple("big.bin", 60L * 1024 * 1024, "application/octet-stream") else Triple("a.txt", 5L, "text/plain")
        override fun open(uri: String) = ByteArrayInputStream("hello".toByteArray())
    }

    private fun session() = Session(MemoryStore(), PersistentCookieJar(MemoryStore())).also { it.serverUrl = base; it.email = "me@demo.test" }

    private var sent: Triple<SendResult, JsonObject, String>? = null
    private var closed = false
    private fun vm(req: ComposeRequest, viewing: Boolean = false, acct: Int? = null) = ComposeViewModel(api, session(), CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), req, acct, viewing, files,
        onSent = { r, p, s -> sent = Triple(r, p, s) }, onScheduled = {}, onClose = { closed = true }).also { it.start() }

    private fun waitFor(what: String, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + 5000
        while (!cond()) { if (System.currentTimeMillis() > end) fail("timed out: $what"); Thread.sleep(10) }
    }

    // ---- pure helpers ----
    @Test fun addressParsing() {
        assertEquals(ApiAddress(name = "Ann Lee", email = "ann@x.com"), ComposeLogic.parseAddress("Ann Lee <ann@x.com>"))
        assertEquals(ApiAddress(name = "", email = "b@x.com"), ComposeLogic.parseAddress(" b@x.com, "))
        assertNull(ComposeLogic.parseAddress("nobody"))
        val (good, bad) = ComposeLogic.parseAddressList("a@x.com, \"Smith, Bob\" <bob@x.com>; nope\nc@x.com d@x.com")
        assertEquals(listOf("a@x.com", "bob@x.com", "c@x.com", "d@x.com"), good.map { it.email })
        assertEquals("Smith, Bob", good[1].name)
        assertEquals(listOf("nope"), bad)
    }

    @Test fun replyRecipientsFollowTheWebRules() {
        val e = ApiEmail(id = "m1", from = listOf(ApiAddress(name = "Ann", email = "ann@x.com")), to = listOf(ApiAddress(name = "", email = "me@demo.test"), ApiAddress(name = "", email = "bo@x.com")),
            cc = listOf(ApiAddress(name = "", email = "cy@x.com"), ApiAddress(name = "", email = "ANN@x.com")))
        val own = setOf("me@demo.test")
        val (t, c) = ComposeLogic.replyRecipients("reply", e, own)
        assertEquals(listOf("ann@x.com"), t.map { it.email }); assertTrue(c.isEmpty())
        val (t2, c2) = ComposeLogic.replyRecipients("replyAll", e, own)
        assertEquals(listOf("ann@x.com"), t2.map { it.email }); assertEquals(listOf("bo@x.com", "cy@x.com"), c2.map { it.email })
        val withReplyTo = e.copy(replyTo = listOf(ApiAddress(name = "", email = "list@x.com")))
        assertEquals(listOf("list@x.com"), ComposeLogic.replyRecipients("reply", withReplyTo, own).first.map { it.email })
        assertTrue(ComposeLogic.replyRecipients("forward", e, own).first.isEmpty())
        val mine = e.copy(from = listOf(ApiAddress(name = "", email = "me@demo.test")), to = listOf(ApiAddress(name = "", email = "me@demo.test")))
        assertEquals(listOf("me@demo.test"), ComposeLogic.replyRecipients("reply", mine, own).first.map { it.email })
    }

    @Test fun subjectPrefixIsNotRepeated() {
        assertEquals("Re: Hello", ComposeLogic.prefixed("Hello", "Re")); assertEquals("RE: Hello", ComposeLogic.prefixed("RE: Hello", "Re"))
        assertEquals("Fwd: Hello", ComposeLogic.prefixed("Hello", "Fwd"))
    }

    @Test fun textBecomesHtmlAndBack() {
        assertEquals("", ComposeLogic.textToHtml("  \n"))
        assertEquals("<p>Hi <strong>you</strong> &amp; <em>co</em><br>line2</p><ul><li>one</li><li>two</li></ul><p>bye &lt;3</p>",
            ComposeLogic.textToHtml("Hi **you** & _co_\nline2\n- one\n- two\n\nbye <3"))
        assertEquals("snake_case_name stays", ComposeLogic.htmlToText(ComposeLogic.textToHtml("snake_case_name stays")))
        assertEquals("Hi **you**\n\n- one\n- two", ComposeLogic.htmlToText("<p>Hi <strong>you</strong></p><ul><li>one</li><li>two</li></ul>"))
    }

    @Test fun draftHtmlSplitsIntoTextSignatureAndQuote() {
        val html = "<p>Thanks</p><div data-seamless-signature><p>— Me</p></div><p>On Mon, Ann wrote:</p><blockquote><p>Q</p></blockquote>"
        val (head, tail) = ComposeLogic.splitDraft(html)
        assertEquals("<p>Thanks</p>", head)
        val (sig, quote) = ComposeLogic.splitTail(tail)
        assertTrue(sig.startsWith("<div data-seamless-signature>") && sig.endsWith("</div>"))
        assertEquals("<p>On Mon, Ann wrote:</p><blockquote><p>Q</p></blockquote>", quote)
        val (h2, t2) = ComposeLogic.splitDraft("<p>Only text</p>"); assertEquals("<p>Only text</p>", h2); assertEquals("", t2)
    }

    @Test fun toolbarEdits() {
        assertEquals(Editing.Edit("a **bc** d", 4, 6), Editing.wrap("a bc d", 2, 4, "**"))
        assertEquals(Editing.Edit("a bc d", 2, 4), Editing.wrap("a **bc** d", 4, 6, "**"))
        assertEquals(Editing.Edit("ab__cd", 3, 3), Editing.wrap("abcd", 2, 2, "_"))
        val l = Editing.toggleList("one\ntwo\nthree", 5, 6)
        assertEquals("one\n- two\nthree", l.text)
        assertEquals("one\ntwo\nthree", Editing.toggleList(l.text, 6, 7).text)
        assertEquals("- one\n- two\nthree", Editing.toggleList("one\ntwo\nthree", 0, 5).text)
    }

    @Test fun mailtoLinks() {
        val m = ComposeLogic.parseMailto("mailto:a@x.com,b@x.com?subject=Hi%20there&cc=c@x.com&body=Line%201%0ALine%202")!!
        assertEquals(listOf("a@x.com", "b@x.com"), m.to.map { it.email }); assertEquals(listOf("c@x.com"), m.cc.map { it.email })
        assertEquals("Hi there", m.subject); assertEquals("Line 1\nLine 2", m.text)
        assertNull(ComposeLogic.parseMailto("https://x.com"))
    }

    @Test fun identityChoiceDefaultsFromTheViewedMailbox() {
        val ids = listOf(ApiIdentity("me@demo.test", "Me", 1, true), ApiIdentity("work@demo.test", "Work", 2), ApiIdentity("alias@demo.test", "A", 2, false, isAlias = true))
        assertEquals("work@demo.test", ComposeLogic.pickIdentity(ids, "", 2)!!.email)
        assertEquals("me@demo.test", ComposeLogic.pickIdentity(ids, "", null)!!.email)
        assertEquals("alias@demo.test", ComposeLogic.pickIdentity(ids, "ALIAS@demo.test", 1)!!.email)
        assertNull(ComposeLogic.pickIdentity(emptyList(), "", 1))
    }

    @Test fun attachmentSizeLimits() {
        assertNull(ComposeLogic.attachProblem(1000, 0))
        assertNotNull(ComposeLogic.attachProblem(51L * 1024 * 1024, 0))
        assertNotNull(ComposeLogic.attachProblem(20L * 1024 * 1024, 30L * 1024 * 1024))
    }

    // ---- the screen's model against a fake server ----
    @Test fun newMessageSendsTheRightPayload() {
        val c = vm(ComposeRequest.New(), acct = 2)
        waitFor("loaded") { !c.loading }
        assertEquals("work@demo.test", c.identity!!.email) // the viewed mailbox decides From
        assertEquals("Add at least one recipient.", c.problemBeforeSending())
        c.setInput("to", "an")
        waitFor("suggestions") { c.suggestions.isNotEmpty() }
        assertEquals("ann@demo.test", c.suggestions[0].email)
        c.addAddress("to", c.suggestions[0])
        c.subject = "Hello"; c.text = TextFieldValue("Hi **Ann**")
        c.addAttachment("content://file1")
        waitFor("upload") { c.attachments[0].state == UploadState.Done }
        c.send()
        waitFor("sent") { sent != null }
        val body = Json.parseToJsonElement(seen.last { it.path == "/api/send" }.body.readUtf8()).jsonObject
        assertEquals(2, body["accountId"]!!.jsonPrimitive.int); assertEquals("work@demo.test", body["fromEmail"]!!.jsonPrimitive.content)
        assertEquals(12, body["identityId"]!!.jsonPrimitive.int)
        assertEquals("ann@demo.test", body["to"]!!.jsonArray[0].jsonObject["email"]!!.jsonPrimitive.content)
        assertEquals("u1", body["attachmentIds"]!!.jsonArray[0].jsonPrimitive.content)
        assertTrue(body["html"]!!.jsonPrimitive.content.startsWith("<p>Hi <strong>Ann</strong></p><div data-seamless-signature>"))
        assertTrue(sent!!.first.queued); assertEquals(7L, sent!!.first.jobId); assertTrue(closed)
        val up = seen.first { it.path == "/api/upload" }
        assertTrue(up.getHeader("Content-Type")!!.startsWith("multipart/form-data")); assertTrue(up.body.readUtf8().contains("hello"))
    }

    @Test fun replyIsPrefilledAndMarksTheOriginal() {
        val e = ApiEmail(id = "m5", accountId = 2, subject = "Plans", messageId = "<abc@x>", receivedAt = "2026-11-01T10:00:00Z",
            from = listOf(ApiAddress(name = "Ann", email = "ann@demo.test")), to = listOf(ApiAddress(name = "", email = "work@demo.test")))
        val c = vm(ComposeRequest.Reply("reply", e))
        waitFor("loaded") { !c.loading }
        assertEquals("work@demo.test", c.identity!!.email) // the address it was sent to
        assertEquals(listOf("ann@demo.test"), c.to.map { it.email }); assertEquals("Re: Plans", c.subject)
        assertTrue(c.quotedHtml.contains("<blockquote><p>Original</p></blockquote>"))
        c.text = TextFieldValue("Sure")
        c.send()
        waitFor("sent") { sent != null }
        val body = Json.parseToJsonElement(seen.last { it.path == "/api/send" }.body.readUtf8()).jsonObject
        assertEquals("<abc@x>", body["inReplyTo"]!!.jsonPrimitive.content); assertEquals("m5", body["replyToEmailId"]!!.jsonPrimitive.content)
        assertTrue(body["html"]!!.jsonPrimitive.content.endsWith("</blockquote>"))
    }

    @Test fun viewingModeAndBadInputNeverSend() {
        val v = vm(ComposeRequest.New(), viewing = true); waitFor("loaded") { !v.loading }
        v.addAddress("to", ApiAddress(name = "", email = "a@x.com")); v.send()
        assertFalse(v.canSend); assertNotNull(v.error); assertNull(sent)
        val c = vm(ComposeRequest.New()); waitFor("loaded2") { !c.loading }
        c.setInput("to", "not an address"); c.send()
        assertTrue(c.error!!.contains("isn't an email address"))
        c.toInput = ""; c.addAddress("to", ApiAddress(name = "", email = "a@x.com")); c.send()
        assertTrue(c.confirmNoSubject) // blank subject asks first
        assertTrue(seen.none { it.path == "/api/send" })
    }

    @Test fun offlineKeepsTheMessage() {
        val c = vm(ComposeRequest.New()); waitFor("loaded") { !c.loading }
        c.addAddress("to", ApiAddress(name = "", email = "a@x.com")); c.subject = "S"
        server.shutdown()
        c.send(confirmedNoSubject = true)
        waitFor("error") { c.error != null }
        assertTrue(c.error!!.startsWith("No connection")); assertFalse(closed); assertNull(sent); assertFalse(c.sending)
    }

    @Test fun serverRefusalShowsItsSentence() {
        sendCode = 502; sendAnswer = """{"error":"smtp refused"}"""
        val c = vm(ComposeRequest.New()); waitFor("loaded") { !c.loading }
        c.addAddress("to", ApiAddress(name = "", email = "a@x.com")); c.subject = "S"; c.send()
        waitFor("error") { c.error != null }
        assertEquals("Smtp refused.", c.error); assertFalse(closed)
    }

    @Test fun hugeFileIsRefusedBeforeUpload() {
        val c = vm(ComposeRequest.New()); waitFor("loaded") { !c.loading }
        c.addAttachment("content://big")
        assertTrue(c.attachments.isEmpty()); assertNotNull(c.error); assertTrue(seen.none { it.path == "/api/upload" })
    }

    @Test fun draftsSaveAndDiscardAsk() {
        val c = vm(ComposeRequest.New()); waitFor("loaded") { !c.loading }
        c.requestClose(); assertTrue(closed) // nothing written: closes at once
        closed = false
        val d = vm(ComposeRequest.New()); waitFor("loaded2") { !d.loading }
        d.subject = "Half done"; d.requestClose()
        assertTrue(d.confirmDiscard); assertFalse(closed)
        d.saveAndClose()
        waitFor("closed") { closed }
        val body = Json.parseToJsonElement(seen.last { it.path == "/api/draft" }.body.readUtf8()).jsonObject
        assertEquals("Half done", body["subject"]!!.jsonPrimitive.content)
    }

    @Test fun undoSendHandsTheMessageBack() {
        val r = api.undoSend(base, 7) as ApiResult.Ok
        val c = vm(ComposeRequest.Restore(r.value)); waitFor("loaded") { !c.loading }
        assertEquals("Hello", c.subject); assertEquals("Hi", c.text.text); assertEquals(listOf("x@demo.test"), c.to.map { it.email })
        assertEquals("me@demo.test", c.identity!!.email)
        c.requestClose(); assertTrue(c.confirmDiscard); assertFalse(closed) // an undone send must not vanish silently
    }
}
