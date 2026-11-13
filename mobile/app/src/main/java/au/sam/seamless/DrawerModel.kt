package au.sam.seamless

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** One system folder in the drawer. `id` is what the list filter understands (`u:<role>` or `q:<search>`). */
data class DrawerFolder(val key: String, val title: String, val id: String, val role: String?)

/** The web app's sidebar layout (`settings.sidebar` = {order, more}), so the order carries over to the phone. */
data class SidebarLayout(val order: List<String>, val more: List<String>)

object Sidebar {
    val DEFAULT = listOf("inbox", "starred", "drafts", "scheduled", "snoozed", "sent", "templates", "spam", "archive", "bin")

    /** Folders the phone can show. "templates" is a web-only editor, so it is left out. */
    private val KNOWN = mapOf(
        "inbox" to DrawerFolder("inbox", "Inbox", "u:inbox", "inbox"),
        "starred" to DrawerFolder("starred", "Starred", "q:is:starred", null),
        "drafts" to DrawerFolder("drafts", "Drafts", "u:drafts", "drafts"),
        "scheduled" to DrawerFolder("scheduled", "Scheduled", "u:scheduled", "scheduled"),
        "snoozed" to DrawerFolder("snoozed", "Snoozed", "q:is:snoozed", null),
        "sent" to DrawerFolder("sent", "Sent", "u:sent", "sent"),
        "spam" to DrawerFolder("spam", "Spam", "u:junk", "junk"),
        "archive" to DrawerFolder("archive", "Archive", "u:archive", "archive"),
        "bin" to DrawerFolder("bin", "Bin", "u:trash", "trash"),
    )

    /** Same clean-up as the web's `normaliseSidebar`: old entries dropped, Snoozed and Archive brought out of "More". */
    fun normalise(order: List<String>?, more: List<String>?): SidebarLayout {
        val gone = setOf("readlater", "waiting")
        val o = (order ?: DEFAULT).filter { it !in gone }.toMutableList()
        val m = (more ?: emptyList()).filter { it !in gone }.toMutableList()
        fun bring(f: String, place: (List<String>) -> Int) {
            m.remove(f)
            if (f !in o) o.add(place(o).coerceIn(0, o.size), f)
        }
        bring("snoozed") { l -> l.indexOf("scheduled").let { if (it >= 0) it + 1 else l.size } }
        bring("archive") { l -> l.indexOf("bin").let { if (it >= 0) it else l.size } }
        // anything the saved layout has never heard of goes to the end of "More"
        DEFAULT.filter { it !in o && it !in m }.forEach { m.add(it) }
        return SidebarLayout(o, m)
    }

    fun fromSettings(settings: JsonObject?): SidebarLayout {
        val sb = settings?.get("sidebar") as? JsonObject
        fun list(k: String) = (sb?.get(k) as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        return normalise(list("order"), list("more"))
    }

    fun folders(layout: SidebarLayout): Pair<List<DrawerFolder>, List<DrawerFolder>> =
        layout.order.mapNotNull { KNOWN[it] } to layout.more.mapNotNull { KNOWN[it] }

    /** The number shown next to a folder: unread for Inbox/Spam, the total for Drafts/Scheduled, nothing elsewhere. */
    fun badge(f: DrawerFolder, mailboxes: List<ApiMailbox>): Int {
        val mb = mailboxes.firstOrNull { it.id == f.id } ?: return 0
        return when (f.key) {
            "inbox", "spam" -> mb.unreadEmails
            "drafts", "scheduled" -> mb.totalEmails
            else -> 0
        }
    }
}

data class LabelRow(val label: ApiLabel, val depth: Int)

object LabelTree {
    /** Parents first, children indented under them (sorted by name); labels hidden from the sidebar are left out. */
    fun flatten(labels: List<ApiLabel>, honourVisibility: Boolean = true): List<LabelRow> {
        val own = labels.filter { !it.shared }
        val ids = own.map { it.id }.toSet()
        val kids = own.groupBy { l -> l.parentId?.takeIf { it in ids } }
        val out = mutableListOf<LabelRow>()
        fun walk(parent: Int?, depth: Int, seen: Set<Int>) {
            for (l in (kids[parent] ?: emptyList()).sortedBy { it.name.lowercase() }) {
                if (l.id in seen) continue
                out += LabelRow(l, depth)
                walk(l.id, depth + 1, seen + l.id)
            }
        }
        walk(null, 0, emptySet())
        val shared = labels.filter { it.shared }.sortedBy { it.name.lowercase() }.map { LabelRow(it, 0) }
        val all = out + shared
        if (!honourVisibility) return all
        return all.filter { r ->
            when (r.label.sidebarVisibility) {
                "hidden" -> false
                "unread" -> r.label.unread > 0 || hasUnreadBelow(r.label, own)
                else -> true
            }
        }
    }

    private fun hasUnreadBelow(l: ApiLabel, all: List<ApiLabel>): Boolean =
        all.any { it.parentId == l.id && (it.unread > 0 || hasUnreadBelow(it, all)) }

    /** The search that lists a label's mail (the same `label:` operator the web search uses). */
    fun query(l: ApiLabel): String = "label:\"" + l.name.replace("\"", "") + "\""

    /** Labels a label may be nested under: not itself, not anything below it, not other people's shared labels. */
    fun parentChoices(labels: List<ApiLabel>, editing: Int?): List<LabelRow> {
        val below = mutableSetOf<Int>()
        fun collect(id: Int) { labels.filter { it.parentId == id && below.add(it.id) }.forEach { collect(it.id) } }
        if (editing != null) { below += editing; collect(editing) }
        return flatten(labels, honourVisibility = false).filter { !it.label.shared && it.label.id !in below }
    }

    /** Why a name can't be saved, or null. The server refuses exact duplicates, so only those are checked. */
    fun validate(name: String, labels: List<ApiLabel>, editing: Int?): String? {
        val n = name.trim()
        if (n.isEmpty()) return "Give the label a name."
        if (n.length > 80) return "That name is too long."
        if (labels.any { !it.shared && it.id != editing && it.name == n }) return "You already have a label with that name."
        return null
    }
}

/** The colours offered for a label (the web picker's palette). */
val LABEL_COLORS = listOf(
    "#e05656", "#f0a838", "#e8c33a", "#4caf7a", "#2f9e9e", "#2f7ed8", "#5b6fd6", "#8e5bd0", "#d05f8e", "#7c8794", "#8a6d4b", "#3b4252",
)

/** Whether a shared-labels offer should show its banner now. */
fun ApiLabelOffer.showBanner(now: Long): Boolean = status == "pending" && (hideBannerUntil == null || hideBannerUntil <= now)

/** What a swipe does. Stored as its key in the app settings. */
enum class SwipeAction(val key: String, val title: String) {
    Archive("archive", "Archive"), Delete("delete", "Delete"), ToggleRead("read", "Mark read / unread"),
    Star("star", "Star / unstar"), None("none", "Nothing");

    companion object {
        fun of(key: String?, fallback: SwipeAction) = entries.firstOrNull { it.key == key } ?: fallback
    }

    /** The bulk action to send for `e`, or null for "nothing". */
    fun bulkFor(e: ApiEmail): String? = when (this) {
        Archive -> "archive"
        Delete -> "delete"
        ToggleRead -> if (e.unread) "read" else "unread"
        Star -> if (e.starred) "unstar" else "star"
        None -> null
    }

    /** Archive and Delete take the row out of the list; the others leave it where it is. */
    val removesRow: Boolean get() = this == Archive || this == Delete
}

enum class ThemeChoice(val key: String, val title: String) {
    System("system", "Match the phone"), Light("light", "Light"), Dark("dark", "Dark");
    companion object { fun of(key: String?) = entries.firstOrNull { it.key == key } ?: System }
}
