package au.sam.seamless

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class PushTest {
    private lateinit var server: MockWebServer
    private lateinit var base: String
    private lateinit var api: Api
    private lateinit var session: Session
    private val requests = mutableListOf<String>()
    private var unreadIds = listOf("m1", "m2")
    private var alertsJson = """{"items":[]}"""
    private var muted = "[]"

    @Before fun up() {
        server = MockWebServer().also { it.start() }
        base = server.url("/").toString().trimEnd('/')
        val jar = PersistentCookieJar(MemoryStore())
        api = Api(jar, "0.1.0", "Test Phone", allowEmulatorHost = true)
        session = Session(MemoryStore(), jar)
        session.serverUrl = base
        jar.saveFromResponse(base.toHttpUrl(), listOf(Cookie.Builder().name("smsession").value("x").domain(base.toHttpUrl().host).path("/").build()))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += "${request.method} ${request.path}"
                val path = request.path.orEmpty()
                return when {
                    path.startsWith("/api/notification-prefs") -> MockResponse().setBody("""{"mutedAccountIds":$muted}""")
                    path.startsWith("/api/alerts/summary") -> MockResponse().setBody(alertsJson)
                    path.startsWith("/jmap/api") -> {
                        val body = request.body.readUtf8()
                        if (body.contains("Email/query")) MockResponse().setBody(
                            """{"methodResponses":[["Email/query",{"ids":[${unreadIds.joinToString(",") { "\"$it\"" }}],"total":${unreadIds.size}},"a"]]}""")
                        else MockResponse().setBody("""{"methodResponses":[["Email/get",{"list":[${unreadIds.joinToString(",") { id ->
                            """{"id":"$id","accountId":${if (id == "m3") 7 else 1},"from":[{"name":"Ann","email":"ann@x.test"}],"subject":"Subject $id","preview":"Preview $id","keywords":{}}""" }}]},"a"]]}""")
                    }
                    path.startsWith("/api/bulk") -> MockResponse().setBody("""{"affected":1}""")
                    path.startsWith("/api/mobile/device") && request.method == "POST" -> MockResponse().setBody("""{"ok":true,"id":1,"pushEnabled":true}""")
                    path.startsWith("/api/mobile/device") -> MockResponse().setBody("""{"ok":true,"removed":1}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }
    @After fun down() { server.shutdown() }

    // ---- payload and display ----
    @Test fun parsesTheServersDataMessage() {
        val p = Push.parse(mapOf("type" to "mail", "messageId" to "42", "accountId" to "3", "sender" to "Ann Lee", "subject" to "Hi", "snippet" to "Body"))!!
        assertEquals(42L, p.messageId); assertEquals(3, p.accountId); assertEquals("Ann Lee", p.sender); assertFalse(p.hidden)
        assertTrue(Push.parse(mapOf("type" to "mail", "hidden" to "1", "messageId" to "5"))!!.hidden)
        assertNull(Push.parse(mapOf("type" to "surprise")))
        assertNull(Push.parse(emptyMap()))
        assertEquals("alert", Push.parse(mapOf("type" to "alert", "alertId" to "9"))!!.type)
        assertEquals(42L, Push.parse(mapOf("type" to "read", "messageId" to "42"))!!.messageId)
    }

    @Test fun mailNotificationShowsSenderSubjectAndSnippetInTheMailboxGroup() {
        val s = Push.spec(PushPayload("mail", 42, 3, sender = "Ann Lee", subject = "Quarterly", snippet = "Numbers inside"), false, "Work")!!
        assertEquals(Push.CH_MAIL, s.channel); assertEquals("Ann Lee", s.title); assertEquals("Quarterly", s.text)
        assertEquals("Quarterly\nNumbers inside", s.bigText); assertEquals("mailbox-3", s.group); assertEquals("Work", s.subText)
        assertEquals(42L, s.openMessageId); assertTrue(s.canAct)
    }

    @Test fun hiddenContentShowsOnlyNewMail() {
        val server = Push.spec(PushPayload("mail", 42, 3, subject = "New mail", hidden = true), false, null)!!
        assertEquals("New mail", server.title); assertFalse(server.bigText.contains("Quarterly"))
        val local = Push.spec(PushPayload("mail", 42, 3, sender = "Ann Lee", subject = "Secret", snippet = "Plans"), true, null)!!
        assertEquals("New mail", local.title); assertFalse((local.text + local.bigText).contains("Secret"))
    }

    @Test fun alertsUseTheAlertChannelAndOpenTheAlert() {
        val s = Push.spec(PushPayload("alert", alertId = 9, subject = "Mailbox stopped", snippet = "Sign-in failed"), false, null)!!
        assertEquals(Push.CH_ALERTS, s.channel); assertEquals(9, s.openAlertId); assertFalse(s.canAct); assertNull(s.group)
        val h = Push.spec(PushPayload("alert", alertId = 9, hidden = true), false, null)!!
        assertEquals("Seamless needs attention", h.title)
        assertNull(Push.spec(PushPayload("mail"), false, null))           // no message id: nothing to show
        assertNull(Push.spec(PushPayload("read", 5), false, null))        // "read" is a cancel, not a notification
    }

    @Test fun idsAreStableAndSummaryTextIsPlain() {
        assertEquals(Push.noteId(42), Push.noteId(42)); assertNotEquals(Push.noteId(42), Push.noteId(43))
        assertEquals("mailbox-5", Push.groupKey(5)); assertNotEquals(Push.summaryId(5), Push.summaryId(6))
        assertEquals("1 new message", Push.summaryText(1)); assertEquals("4 new messages", Push.summaryText(4))
        assertEquals("m42", Push.emailId(42))
    }

    @Test fun deepLinkTargets() {
        assertEquals(OpenTarget.Message(5), OpenTarget.fromExtras(5, 0, 0))
        assertEquals(OpenTarget.Reply(5), OpenTarget.fromExtras(5, 5, 0))
        assertEquals(OpenTarget.Alert(9), OpenTarget.fromExtras(0, 0, 9))
        assertNull(OpenTarget.fromExtras(0, 0, 0)); assertNull(OpenTarget.fromExtras(null, null, null))
    }

    @Test fun composeShortcutOpensAnEmptyMessage() {
        val m = ComposeLogic.parseMailto("mailto:")!!
        assertTrue(m.to.isEmpty()); assertEquals("", m.subject)
    }

    // ---- fallback sync ----
    private fun e(id: String, acct: Int = 1) = ApiEmail(id = id, accountId = acct, from = listOf(ApiAddress("Ann", "a@x.test")), subject = "S$id")

    @Test fun firstRunOnlyRecordsABaseline() {
        val r = SyncPlan.newMail(listOf(e("m1"), e("m2")), null, emptySet())
        assertTrue(r.fresh.isEmpty()); assertEquals(listOf("m1", "m2"), r.seen)
    }

    @Test fun laterRunsReportOnlyUnseenMailAndSkipMutedMailboxes() {
        val r = SyncPlan.newMail(listOf(e("m3", 7), e("m4", 2), e("m1")), listOf("m1", "m2"), setOf(7))
        assertEquals(listOf("m4"), r.fresh.map { it.id })
        assertEquals(listOf("m3", "m4", "m1", "m2"), r.seen)
    }

    @Test fun seenListStaysBounded() {
        val many = (1..SyncPlan.KEEP + 50).map { "m$it" }
        assertEquals(SyncPlan.KEEP, SyncPlan.newMail(listOf(e("mX")), many, emptySet()).seen.size)
    }

    @Test fun alertsAreAnnouncedOnce() {
        val open = listOf(ApiAlert(1, title = "A"), ApiAlert(2, title = "B", state = "read"))
        assertEquals(listOf(1), SyncPlan.newAlerts(open, emptySet()).map { it.id })
        assertTrue(SyncPlan.newAlerts(open, setOf(1)).isEmpty())
    }

    @Test fun syncRunnerBaselineThenNotifies() {
        val posted = mutableListOf<PushPayload>()
        val first = SyncRunner.run(api, session, { posted += it })
        assertEquals(0, first.newMail); assertTrue(posted.isEmpty()); assertNull(first.error)
        assertEquals(listOf("m1", "m2"), session.syncSeen)
        unreadIds = listOf("m9", "m1", "m2")
        val second = SyncRunner.run(api, session, { posted += it })
        assertEquals(1, second.newMail)
        assertEquals("mail", posted.single().type); assertEquals(9L, posted.single().messageId); assertEquals("Ann", posted.single().sender)
        assertEquals("Preview m9", posted.single().snippet)
    }

    @Test fun syncRunnerHonoursMutedMailboxesAndSwitches() {
        val posted = mutableListOf<PushPayload>()
        SyncRunner.run(api, session, { posted += it })
        unreadIds = listOf("m3", "m1", "m2"); muted = "[7]"           // m3 belongs to mailbox 7
        assertEquals(0, SyncRunner.run(api, session, { posted += it }).newMail)
        session.notifyMail = false; unreadIds = listOf("m5", "m3", "m1")
        requests.clear()
        SyncRunner.run(api, session, { posted += it })
        assertTrue(posted.isEmpty()); assertFalse(requests.any { it.startsWith("POST /jmap") })   // mail switch off: no mail call at all
    }

    @Test fun syncRunnerRaisesAlertsOnce() {
        val posted = mutableListOf<PushPayload>()
        alertsJson = """{"items":[{"id":4,"kind":"mailbox.sync","title":"Mailbox stopped","body":"Sign-in failed","state":"open"}]}"""
        assertEquals(1, SyncRunner.run(api, session, { posted += it }).newAlerts)
        assertEquals(0, SyncRunner.run(api, session, { posted += it }).newAlerts)
        assertEquals("alert", posted.single().type); assertEquals(4, posted.single().alertId)
        session.notifyAlerts = false; alertsJson = """{"items":[{"id":5,"title":"Other","state":"open"}]}"""
        assertEquals(0, SyncRunner.run(api, session, { posted += it }).newAlerts)
    }

    @Test fun syncStaysQuietWhenPushWorksUnlessForced() {
        session.pushActive = true
        val posted = mutableListOf<PushPayload>()
        val r = SyncRunner.run(api, session, { posted += it })
        assertTrue(r.skipped); assertTrue(requests.isEmpty())
        assertFalse(SyncRunner.run(api, session, { posted += it }, force = true).skipped)
    }

    @Test fun syncReportsOfflineAndSignedOut() {
        server.shutdown()
        val r = SyncRunner.run(api, session, {})
        assertNotNull(r.error); assertFalse(r.signedOut)
        // a fresh server answering 401
        val s2 = MockWebServer().also { it.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(401) }; it.start() }
        session.serverUrl = s2.url("/").toString().trimEnd('/')
        assertTrue(SyncRunner.run(api, session, {}).signedOut)
        s2.shutdown()
    }

    @Test fun signedOutPhoneDoesNothing() {
        session.clear()
        assertTrue(SyncRunner.run(api, session, { fail("must not notify") }).skipped)
    }

    // ---- registration ----
    @Test fun registersAndUnregistersTheDevice() {
        val r = api.registerDevice(base, "tok".repeat(10), notifyMail = true, notifyAlerts = false, hideContent = true) as ApiResult.Ok
        assertTrue(r.value)
        val post = server.takeRequest(); assertEquals("POST", post.method); assertEquals("/api/mobile/device", post.path)
        val body = post.body.readUtf8()
        assertTrue(body.contains("\"fcmToken\":\"${"tok".repeat(10)}\"")); assertTrue(body.contains("\"notifyAlerts\":false")); assertTrue(body.contains("\"hideContent\":true"))
        assertEquals("android/0.1.0", post.getHeader("X-Seamless-Client")); assertEquals("Test Phone", post.getHeader("X-Seamless-Device"))
        assertTrue(api.unregisterDevice(base, "a b") is ApiResult.Ok)
        val del = server.takeRequest(); assertEquals("DELETE", del.method); assertEquals("/api/mobile/device?fcmToken=a+b", del.path)
    }

    @Test fun signOutClearsPushState() {
        session.pushActive = true; session.syncSeen = listOf("m1"); session.syncAlerts = setOf(3); session.accountNames = mapOf(1 to "Work")
        assertEquals(mapOf(1 to "Work"), session.accountNames)
        session.clear()
        assertFalse(session.pushActive); assertNull(session.syncSeen); assertTrue(session.syncAlerts.isEmpty()); assertTrue(session.accountNames.isEmpty())
    }
}
