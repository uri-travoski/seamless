package au.sam.seamless

import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class DrawerTest {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    // ---- sidebar order ----
    @Test fun defaultOrderMatchesTheWebApp() {
        val (main, more) = Sidebar.folders(Sidebar.fromSettings(null))
        assertEquals(listOf("inbox", "starred", "drafts", "scheduled", "snoozed", "sent", "spam", "archive", "bin"), main.map { it.key })
        assertTrue(more.isEmpty()) // templates is web-only
    }

    @Test fun savedOrderCarriesOver() {
        val s = json.parseToJsonElement("""{"sidebar":{"order":["inbox","sent","drafts"],"more":["spam","bin","readlater"]}}""").jsonObject
        val layout = Sidebar.fromSettings(s)
        val (main, more) = Sidebar.folders(layout)
        // snoozed / archive are pulled out of More into place, the removed ones vanish, unknown-to-layout go to More at the end
        assertEquals(listOf("inbox", "sent", "drafts", "snoozed", "archive"), main.map { it.key }.take(5))
        assertFalse(layout.order.contains("readlater") || layout.more.contains("readlater"))
        assertTrue(more.map { it.key }.containsAll(listOf("spam", "bin")))
    }

    @Test fun foldersMapToListFilters() {
        val all = Sidebar.folders(Sidebar.fromSettings(null)).first.associateBy { it.key }
        assertEquals("u:junk", all["spam"]!!.id); assertEquals("u:trash", all["bin"]!!.id)
        assertEquals("q:is:starred", all["starred"]!!.id)
        val f = MailQuery.filter("unified", "q:is:starred", Quick.Unread)
        assertFalse(f.containsKey("inMailbox")); assertEquals("is:starred is:unread", f["text"]!!.jsonPrimitive.content)
        assertEquals("is:snoozed", MailQuery.filter("unified", "q:is:snoozed", Quick.All)["text"]!!.jsonPrimitive.content)
    }

    @Test fun badgesUseUnreadForInboxAndTotalForDrafts() {
        val boxes = listOf(ApiMailbox("u:inbox", "Inbox", "inbox", totalEmails = 50, unreadEmails = 7), ApiMailbox("u:drafts", "Drafts", "drafts", totalEmails = 3, unreadEmails = 0), ApiMailbox("u:sent", "Sent", "sent", totalEmails = 9, unreadEmails = 9))
        val f = Sidebar.folders(Sidebar.fromSettings(null)).first.associateBy { it.key }
        assertEquals(7, Sidebar.badge(f["inbox"]!!, boxes)); assertEquals(3, Sidebar.badge(f["drafts"]!!, boxes)); assertEquals(0, Sidebar.badge(f["sent"]!!, boxes))
    }

    // ---- labels ----
    private val labels = listOf(
        ApiLabel(1, "Clients", "#2f7ed8"), ApiLabel(3, "Harbour Dental", "#d05f8e", parentId = 1, unread = 2), ApiLabel(2, "Bills", "#f0a838", unread = 1),
        ApiLabel(4, "Zed", sidebarVisibility = "hidden"), ApiLabel(5, "Quiet", sidebarVisibility = "unread"), ApiLabel(6, "Orphan", parentId = 99),
        ApiLabel(7, "Shared one", shared = true, sharedBy = "Alice"),
    )

    @Test fun nestedLabelsAreIndentedUnderTheirParent() {
        val rows = LabelTree.flatten(labels)
        assertEquals(listOf("Bills", "Clients", "Harbour Dental", "Orphan", "Shared one"), rows.map { it.label.name })
        assertEquals(listOf(0, 0, 1, 0, 0), rows.map { it.depth })
    }

    @Test fun hiddenAndQuietLabelsFollowTheirSidebarSetting() {
        val names = LabelTree.flatten(labels).map { it.label.name }
        assertFalse("Zed" in names); assertFalse("Quiet" in names)
        assertTrue("Quiet" in LabelTree.flatten(labels.map { if (it.id == 5) it.copy(unread = 1) else it }).map { it.label.name })
        assertTrue("Zed" in LabelTree.flatten(labels, honourVisibility = false).map { it.label.name })
    }

    @Test fun cyclesDoNotLoopForever() {
        val loop = listOf(ApiLabel(1, "A", parentId = 2), ApiLabel(2, "B", parentId = 1))
        assertTrue(LabelTree.flatten(loop).size <= 2)
    }

    @Test fun parentChoicesExcludeSelfAndDescendantsAndSharedLabels() {
        val ids = LabelTree.parentChoices(labels, editing = 1).map { it.label.id }
        assertFalse(1 in ids); assertFalse(3 in ids); assertFalse(7 in ids)
        assertTrue(2 in ids)
        assertTrue(1 in LabelTree.parentChoices(labels, editing = null).map { it.label.id })
    }

    @Test fun nameValidation() {
        assertEquals("Give the label a name.", LabelTree.validate("  ", labels, null))
        assertNotNull(LabelTree.validate("Bills", labels, null))
        assertNull(LabelTree.validate("Bills", labels, editing = 2)) // renaming to itself is fine
        assertNull(LabelTree.validate("Shared one", labels, null)) // someone else's label name doesn't block yours
        assertNull(LabelTree.validate("New", labels, null))
    }

    @Test fun labelSearchQuotesTheName() {
        assertEquals("label:\"Harbour Dental\"", LabelTree.query(labels[1]))
        assertEquals("label:\"Say hi\"", LabelTree.query(ApiLabel(9, "Say \"hi\"")))
    }

    // ---- offers ----
    @Test fun bannerShowsOnlyForPendingOffersNotPostponed() {
        val now = 1_000L
        assertTrue(ApiLabelOffer(1, status = "pending").showBanner(now))
        assertFalse(ApiLabelOffer(1, status = "pending", hideBannerUntil = 2_000).showBanner(now))
        assertTrue(ApiLabelOffer(1, status = "pending", hideBannerUntil = 500).showBanner(now))
        assertFalse(ApiLabelOffer(1, status = "accepted").showBanner(now))
        assertFalse(ApiLabelOffer(1, status = "rejected").showBanner(now))
    }

    // ---- swipe + theme ----
    @Test fun swipeActionsTurnIntoBulkActions() {
        val unread = ApiEmail("m1"); val read = ApiEmail("m2", keywords = mapOf("\$seen" to true, "\$flagged" to true))
        assertEquals("archive", SwipeAction.Archive.bulkFor(unread)); assertEquals("delete", SwipeAction.Delete.bulkFor(unread))
        assertEquals("read", SwipeAction.ToggleRead.bulkFor(unread)); assertEquals("unread", SwipeAction.ToggleRead.bulkFor(read))
        assertEquals("star", SwipeAction.Star.bulkFor(unread)); assertEquals("unstar", SwipeAction.Star.bulkFor(read))
        assertNull(SwipeAction.None.bulkFor(unread))
        assertTrue(SwipeAction.Archive.removesRow); assertFalse(SwipeAction.Star.removesRow)
        assertEquals(SwipeAction.Delete, SwipeAction.of("nonsense", SwipeAction.Delete))
        assertEquals(ThemeChoice.System, ThemeChoice.of(null)); assertEquals(ThemeChoice.Dark, ThemeChoice.of("dark"))
    }

    @Test fun phoneSettingsHaveSensibleDefaultsAndPersist() {
        val store = MemoryStore()
        val s = Session(store, PersistentCookieJar(store))
        assertEquals("archive", s.swipeRight); assertEquals("delete", s.swipeLeft)
        assertTrue(s.conversationView); assertTrue(s.notifyMail); assertTrue(s.notifyAlerts); assertFalse(s.hideContent)
        assertEquals("system", s.theme); assertEquals("", s.defaultFrom)
        s.swipeLeft = "star"; s.hideContent = true; s.theme = "dark"; s.conversationView = false
        val again = Session(store, PersistentCookieJar(store))
        assertEquals("star", again.swipeLeft); assertTrue(again.hideContent); assertEquals("dark", again.theme); assertFalse(again.conversationView)
    }

    // ---- requests ----
    private lateinit var server: MockWebServer
    private lateinit var base: String
    private lateinit var api: Api
    @Before fun up() {
        server = MockWebServer().also { it.start() }
        base = server.url("/").toString().trimEnd('/')
        api = Api(PersistentCookieJar(MemoryStore()), "0.1.0", "Test Phone", allowEmulatorHost = true)
    }
    @After fun down() { server.shutdown() }

    @Test fun labelCreateUpdateDeleteUseTheWebEndpoints() {
        server.enqueue(MockResponse().setBody("""{"id":12}"""))
        assertEquals(12, (api.createLabel(base, " Taxes ", "#e05656", 3) as ApiResult.Ok).value)
        var r = server.takeRequest()
        assertEquals("POST", r.method); assertEquals("/api/labels", r.path)
        val b = json.parseToJsonElement(r.body.readUtf8()).jsonObject
        assertEquals("Taxes", b["name"]!!.jsonPrimitive.content); assertEquals(3, b["parentId"]!!.jsonPrimitive.int)

        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        assertTrue(api.updateLabel(base, 12, "Tax", "#2f7ed8", null) is ApiResult.Ok)
        r = server.takeRequest()
        assertEquals("PUT", r.method); assertEquals("/api/labels/12", r.path)
        assertTrue(json.parseToJsonElement(r.body.readUtf8()).jsonObject["parentId"] is JsonNull)

        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        assertTrue(api.deleteLabel(base, 12) is ApiResult.Ok)
        r = server.takeRequest()
        assertEquals("DELETE", r.method); assertEquals("/api/labels/12", r.path)
    }

    @Test fun duplicateLabelNameShowsTheServersSentence() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"a label with that name already exists"}"""))
        assertEquals("A label with that name already exists.", (api.createLabel(base, "Bills", "#fff", null) as ApiResult.Failed).message)
    }

    @Test fun sharedLabelOffersParseAndAnswer() {
        server.enqueue(MockResponse().setBody("""[{"accountId":4,"email":"a@x.test","mailbox":"Shop","ownerName":"Alice","status":"pending","count":2,"labels":[{"id":1,"name":"VIP","color":"#fff"}],"hideBannerUntil":null,"role":"viewer"}]"""))
        val o = (api.sharedLabelOffers(base) as ApiResult.Ok).value.single()
        assertEquals("Alice", o.ownerName); assertEquals(2, o.count); assertTrue(o.showBanner(0))
        server.takeRequest()
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api.respondSharedLabels(base, 4, "later")
        val r = server.takeRequest()
        assertEquals("/api/labels/shared/4/respond", r.path); assertEquals("later", json.parseToJsonElement(r.body.readUtf8()).jsonObject["action"]!!.jsonPrimitive.content)
    }

    @Test fun settingsReadTheMeObjectAndSaveTheWholeObject() {
        server.enqueue(MockResponse().setBody("""{"loggedIn":true,"settings":{"theme":"x","sidebar":{"order":["inbox"],"more":[]}}}"""))
        val s = (api.userSettings(base) as ApiResult.Ok).value
        assertEquals("x", s["theme"]!!.jsonPrimitive.content)
        server.takeRequest()
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api.saveUserSettings(base, s)
        val r = server.takeRequest()
        assertEquals("PUT", r.method); assertEquals("/api/settings", r.path)
        assertEquals(s, json.parseToJsonElement(r.body.readUtf8()).jsonObject)
    }

    @Test fun undoDelayAndMuteListUseServerEndpoints() {
        server.enqueue(MockResponse().setBody("""{"undoSendSeconds":20,"snoozeWakeOnReply":true}"""))
        assertEquals(20, (api.serverSettings(base) as ApiResult.Ok).value.undoSendSeconds); server.takeRequest()
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api.saveUndoSeconds(base, 30)
        var r = server.takeRequest()
        assertEquals("PUT", r.method); assertEquals("/api/settings/server", r.path); assertEquals(30, json.parseToJsonElement(r.body.readUtf8()).jsonObject["undoSendSeconds"]!!.jsonPrimitive.int)
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api.saveMutedAccounts(base, listOf(2, 5))
        r = server.takeRequest()
        assertEquals("/api/notification-prefs", r.path); assertEquals(2, json.parseToJsonElement(r.body.readUtf8()).jsonObject["mutedAccountIds"]!!.jsonArray.size)
        server.enqueue(MockResponse().setBody("""{"prefs":[],"mutedAccountIds":[2],"quiet":{},"sound":false}"""))
        assertEquals(listOf(2), (api.notificationPrefs(base) as ApiResult.Ok).value.mutedAccountIds)
    }
}
