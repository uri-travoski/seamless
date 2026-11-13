package au.sam.seamless

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The quick-filter chips under the search pill (same ones as the web app). */
sealed interface Quick {
    data object All : Quick
    data object Unread : Quick
    data object Attachments : Quick
    data class View(val id: Int, val name: String, val query: String) : Quick
}

object MailQuery {
    const val UNIFIED = "unified"

    /** The JMAP filter for a list: folder + scope + the quick chip, or a free-text search over everything. */
    fun filter(scope: String, folder: String, quick: Quick, search: String? = null): JsonObject = buildJsonObject {
        // "q:<search>" folders (Starred, Snoozed, a label) are a search rather than a mailbox
        val folderText = if (folder.startsWith("q:")) folder.drop(2) else ""
        val text = when {
            search != null -> search.trim()
            quick is Quick.Unread -> listOf(folderText, "is:unread").filter { it.isNotEmpty() }.joinToString(" ")
            quick is Quick.Attachments -> listOf(folderText, "has:attachment").filter { it.isNotEmpty() }.joinToString(" ")
            quick is Quick.View -> quick.query
            else -> folderText
        }
        if (search == null && quick !is Quick.View && folderText.isEmpty()) put("inMailbox", folder)
        if (text.isNotEmpty()) put("text", text)
        if (scope != UNIFIED) put("scope", scope)
    }

    fun accountOf(scope: String): Int? = Regex("^account:(\\d+)$").matchEntire(scope)?.groupValues?.get(1)?.toInt()
    fun categoryOf(scope: String): Int? = Regex("^category:(\\d+)$").matchEntire(scope)?.groupValues?.get(1)?.toInt()

    /** Mixed lists (unified or a category with several mailboxes) show which mailbox each row came from. */
    fun showsMailboxDot(scope: String, overview: ApiCategoryOverview?): Boolean {
        if (accountOf(scope) != null) return false
        val cat = categoryOf(scope) ?: return true
        return (overview?.categories?.firstOrNull { it.id == cat }?.accountIds?.size ?: 2) > 1
    }

    fun scopeTitle(scope: String, overview: ApiCategoryOverview?): String = when {
        categoryOf(scope) != null -> overview?.categories?.firstOrNull { it.id == categoryOf(scope) }?.name ?: "Category"
        accountOf(scope) != null -> overview?.mailboxes?.firstOrNull { it.id == accountOf(scope) }?.name ?: "Mailbox"
        else -> "All mailboxes"
    }
}

/** The "search options" sheet: each field becomes the web operator, so both search the same way. */
data class SearchOptions(
    val from: String = "", val to: String = "", val subject: String = "", val words: String = "",
    val hasAttachment: Boolean = false,
    val sizeOver: Boolean = true, val sizeMb: String = "",
    val after: String = "", val before: String = "",
) {
    fun toQuery(): String {
        val parts = mutableListOf<String>()
        fun op(name: String, v: String) { val t = v.trim(); if (t.isNotEmpty()) parts += if (t.contains(' ')) "$name:\"$t\"" else "$name:$t" }
        op("from", from); op("to", to); op("subject", subject)
        words.trim().takeIf { it.isNotEmpty() }?.let { parts += it }
        if (hasAttachment) parts += "has:attachment"
        sizeMb.trim().toDoubleOrNull()?.takeIf { it > 0 }?.let { parts += "size${if (sizeOver) ">" else "<"}${fmtNum(it)}mb" }
        validDate(after)?.let { parts += "after:$it" }
        validDate(before)?.let { parts += "before:$it" }
        return parts.joinToString(" ")
    }

    private fun fmtNum(d: Double) = if (d == Math.floor(d)) d.toInt().toString() else d.toString()
    private fun validDate(s: String): String? = s.trim().takeIf { runCatching { LocalDate.parse(it) }.isSuccess }
}

object Format {
    private val timeFmt = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
    private val dayFmt = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)
    private val fullFmt = DateTimeFormatter.ofPattern("d/M/yy", Locale.ENGLISH)

    /** Gmail style: today → time, this year → "11 Nov", older → "11/11/24". */
    fun time(iso: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val at = runCatching { Instant.parse(iso).atZone(zone) }.getOrNull() ?: return ""
        val today = now.atZone(zone).toLocalDate()
        return when {
            at.toLocalDate() == today -> timeFmt.format(at).lowercase()
            at.year == today.year -> dayFmt.format(at)
            else -> fullFmt.format(at)
        }
    }

    fun initial(s: String): String = s.trim().firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "?"

    fun count(n: Int): String = if (n >= 1000) "%,d".format(Locale.ENGLISH, n) else n.toString()

    /** "1–50 of 1,238" style line used under the search box. */
    fun results(n: Int): String = when (n) { 0 -> "No results"; 1 -> "1 result"; else -> "${count(n)} results" }
}
