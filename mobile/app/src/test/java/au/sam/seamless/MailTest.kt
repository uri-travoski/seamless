package au.sam.seamless

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class MailTest {
    private fun res(name: String) = javaClass.classLoader!!.getResource(name)!!.readText()
    private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true; coerceInputValues = true }

    // ---- query building ----
    @Test fun filterForInboxQuickAndScope() {
        val f = MailQuery.filter("category:2", "u:inbox", Quick.Unread)
        assertEquals("u:inbox", f["inMailbox"]!!.jsonPrimitive.content)
        assertEquals("is:unread", f["text"]!!.jsonPrimitive.content)
        assertEquals("category:2", f["scope"]!!.jsonPrimitive.content)
        val all = MailQuery.filter(MailQuery.UNIFIED, "u:inbox", Quick.All)
        assertFalse(all.containsKey("text")); assertFalse(all.containsKey("scope"))
        assertEquals("has:attachment", MailQuery.filter("unified", "u:inbox", Quick.Attachments)["text"]!!.jsonPrimitive.content)
    }

    @Test fun searchAndSmartViewsSearchEverything() {
        val s = MailQuery.filter("account:3", "u:inbox", Quick.Unread, search = " crossword ")
        assertFalse(s.containsKey("inMailbox")); assertEquals("crossword", s["text"]!!.jsonPrimitive.content)
        assertEquals("account:3", s["scope"]!!.jsonPrimitive.content)
        val v = MailQuery.filter("unified", "u:inbox", Quick.View(1, "Waiting", "is:waiting"))
        assertFalse(v.containsKey("inMailbox")); assertEquals("is:waiting", v["text"]!!.jsonPrimitive.content)
    }

    @Test fun mailboxDotOnlyWhenMixed() {
        val ov = ApiCategoryOverview(categories = listOf(ApiCategory(1, accountIds = listOf(1, 2)), ApiCategory(2, accountIds = listOf(3))))
        assertTrue(MailQuery.showsMailboxDot("unified", ov))
        assertTrue(MailQuery.showsMailboxDot("category:1", ov))
        assertFalse(MailQuery.showsMailboxDot("category:2", ov))
        assertFalse(MailQuery.showsMailboxDot("account:1", ov))
    }

    @Test fun searchOptionsBecomeWebOperators() {
        val o = SearchOptions(from = "bob@x.test", subject = "quote request", words = "invoice", hasAttachment = true, sizeMb = "5", after = "2026-01-01", before = "nonsense")
        assertEquals("from:bob@x.test subject:\"quote request\" invoice has:attachment size>5mb after:2026-01-01", o.toQuery())
        assertEquals("size<2.5mb", SearchOptions(sizeOver = false, sizeMb = "2.5").toQuery())
        assertEquals("", SearchOptions().toQuery())
    }

    // ---- formatting ----
    @Test fun gmailStyleTimes() {
        val now = Instant.parse("2026-11-13T04:00:00Z"); val perth = ZoneId.of("Australia/Perth")
        assertEquals("9:30 am", Format.time("2026-11-13T01:30:00Z", now, perth))
        assertEquals("11 Nov", Format.time("2026-11-11T01:42:22.000Z", now, perth))
        assertEquals("26/7/25", Format.time("2025-07-25T17:10:00Z", now, perth))
        assertEquals("", Format.time("garbage", now, perth))
        assertEquals("1,238", Format.count(1238)); assertEquals("300 results", Format.results(300)); assertEquals("No results", Format.results(0))
    }

    // ---- parsing real server output ----
    @Test fun parsesRealSamples() {
        val ov = json.decodeFromString<ApiCategoryOverview>(res("categories.json"))
        assertEquals(3, ov.categories.size); assertTrue(ov.mailboxes.any { it.email == "sam@acmecleaning.test" }); assertTrue(ov.unifiedUnread > 0)
        assertTrue(json.decodeFromString<List<ApiLabel>>(res("labels.json")).any { it.parentId != null })
        assertTrue(json.decodeFromString<List<ApiSavedView>>(res("views.json")).first().pinned)
    }

    @Test fun accountProblemDetection() {
        assertFalse(ApiAccountStatus(1, "ok", "").hasProblem)
        assertFalse(ApiAccountStatus(1, "connecting", "").hasProblem)
        assertTrue(ApiAccountStatus(1, "error", "auth failed").hasProblem)
    }

    // ---- api ----
    private lateinit var server: MockWebServer
    @Before fun up() { server = MockWebServer().also { it.start() } }
    @After fun down() { server.shutdown() }
    private fun api() = Api(PersistentCookieJar(MemoryStore()), "0.1.0", "Test", allowEmulatorHost = true)
    private fun base() = server.url("/").toString().trimEnd('/')

    @Test fun emailPageQueriesThenFetchesInOrder() {
        val sample = json.parseToJsonElement(res("email_page.json")).let { it as kotlinx.serialization.json.JsonObject }
        val responses = sample["methodResponses"] as kotlinx.serialization.json.JsonArray
        val query = """{"methodResponses":[${responses[0]}]}"""
        val ids = (((responses[0] as kotlinx.serialization.json.JsonArray)[1] as kotlinx.serialization.json.JsonObject)["ids"] as kotlinx.serialization.json.JsonArray).map { it.jsonPrimitive.content }
        val get = """{"methodResponses":[${responses[1]}]}"""
        server.enqueue(MockResponse().setBody(query)); server.enqueue(MockResponse().setBody(get))
        val r = api().emailPage(base(), MailQuery.filter("unified", "u:inbox", Quick.All), 0) as ApiResult.Ok
        assertEquals(ids, r.value.emails.map { it.id }); assertEquals(1237, r.value.total)
        val q = server.takeRequest().body.readUtf8()
        assertTrue(q.contains("Email/query")); assertTrue(q.contains("\"limit\":50")); assertTrue(q.contains("u:inbox"))
        assertTrue(server.takeRequest().body.readUtf8().contains("Email/get"))
        assertTrue(r.value.emails.first().sender.isNotBlank())
    }

    @Test fun emailPageErrorsBecomeWords() {
        server.enqueue(MockResponse().setResponseCode(500))
        val r = api().emailPage(base(), MailQuery.filter("unified", "u:inbox", Quick.All), 0)
        assertTrue(r is ApiResult.Failed && r.message.contains("server had a problem"))
    }

    @Test fun bulkSendsIdsActionAndValue() {
        server.enqueue(MockResponse().setBody("""{"affected":2,"undoToken":"abc","undoable":true}"""))
        val r = api().bulk(base(), listOf("m1", "m2"), "snooze", kotlinx.serialization.json.JsonPrimitive(1234L)) as ApiResult.Ok
        assertEquals("abc", r.value.undoToken)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"ids\":[\"m1\",\"m2\"]") && body.contains("\"action\":\"snooze\"") && body.contains("\"value\":1234"))
    }

    // ---- paging ----
    private fun mail(i: Int) = ApiEmail(id = "m$i", receivedAt = "2026-01-01T00:00:00Z")

    @Test fun pagesAreRequestedOnceAndStopAtTheEnd() = runBlocking {
        val asked = mutableListOf<Int>()
        val m = ListModel { pos -> asked += pos; ApiResult.Ok(EmailPage(120, (pos until minOf(pos + 50, 120)).map(::mail))) }
        m.reload(); assertEquals(50, m.items.size); assertFalse(m.endReached)
        m.loadMore(); m.loadMore(); assertEquals(120, m.items.size.coerceAtMost(120)); assertTrue(m.endReached)
        m.loadMore(); assertEquals(listOf(0, 50, 100), asked)
    }

    @Test fun errorKeepsRowsAndRetryWorks() = runBlocking {
        var fail = false
        val m = ListModel { pos -> if (fail) ApiResult.Network("Can't reach the server.") else ApiResult.Ok(EmailPage(100, (pos until pos + 50).map(::mail))) }
        m.reload(); fail = true; m.loadMore()
        assertEquals(ListStatus.Error("Can't reach the server."), m.status); assertEquals(50, m.items.size)
        fail = false; m.loadMore(); assertEquals(100, m.items.size); assertEquals(ListStatus.Idle, m.status)
    }

    @Test fun removeRestoreAndPatch() = runBlocking {
        val m = ListModel { ApiResult.Ok(EmailPage(3, (0 until 3).map(::mail))) }
        m.reload()
        m.remove(setOf("m1")); assertEquals(listOf("m0", "m2"), m.items.map { it.id }); assertEquals(2, m.total)
        m.restore(listOf(mail(1))); assertEquals(3, m.items.size)
        m.patch(setOf("m0")) { it.copy(keywords = mapOf("\$seen" to true)) }
        assertFalse(m.items.first { it.id == "m0" }.unread); assertTrue(m.items.first { it.id == "m2" }.unread)
    }

    @Test fun unauthorizedFlagsSignOut() = runBlocking {
        val m = ListModel { ApiResult.Unauthorized }
        m.reload(); assertTrue(m.signedOut)
    }

    // ---- misc ----
    @Test fun recentSearchesAreDedupedAndCapped() {
        val store = MemoryStore(); val s = Session(store, PersistentCookieJar(store))
        for (i in 1..12) s.addRecentSearch("q$i")
        s.addRecentSearch("Q5")
        assertEquals(10, s.recentSearches.size); assertEquals("Q5", s.recentSearches.first()); assertEquals(1, s.recentSearches.count { it.equals("q5", true) })
        assertEquals("unified", s.scope); s.scope = "account:3"; assertEquals("account:3", s.scope)
    }

    @Test fun snackbarWording() {
        assertEquals("Conversation archived", MailViewModel.confirmation("archive", 1))
        assertEquals("3 conversations moved to Trash", MailViewModel.confirmation("delete", 3))
        assertNull(MailViewModel.confirmation("star", 1))
    }
}
