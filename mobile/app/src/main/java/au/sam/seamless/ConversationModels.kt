package au.sam.seamless

import kotlinx.serialization.Serializable
import java.net.URI
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** `GET /api/message/:id/body` – the sanitised body plus everything shown around it. */
@Serializable data class ApiBody(
    val id: String = "",
    val html: String? = null,
    val text: String? = null,
    val hasBlockedRemote: Boolean = false,
    val note: String = "",
    val attachments: List<ApiAttachment> = emptyList(),
    val invite: ApiInvite? = null,
    val pgp: ApiCrypto? = null,
    val smime: ApiCrypto? = null,
)

@Serializable data class ApiAttachment(
    val partId: String = "", val filename: String = "", val contentType: String = "", val size: Long = 0, val cid: String? = null, val inline: Boolean = false,
) {
    /** Inline pictures are shown in the body, so the strip lists only real attachments. */
    val listed: Boolean get() = !(inline && cid != null)
}

/** Read-only OpenPGP / S-MIME status. */
@Serializable data class ApiCrypto(val encrypted: Boolean = false, val decrypted: Boolean = false, val signature: String = "none", val signer: String? = null, val locked: Boolean = false) {
    fun badge(kind: String): String? = when {
        locked -> "$kind: locked"
        encrypted && decrypted && signature == "verified" -> "$kind: decrypted, signature verified"
        encrypted && decrypted -> "$kind: decrypted"
        encrypted -> "$kind: encrypted"
        signature == "verified" -> "$kind: signature verified"
        signature == "bad" -> "$kind: BAD signature"
        signature == "unverified" -> "$kind: signed, not verified"
        else -> null
    }
}

@Serializable data class ApiInviteAttendee(val name: String = "", val email: String = "", val partstat: String = "")

@Serializable data class ApiInvite(
    val id: Int = 0, val summary: String = "", val startsAt: Long? = null, val endsAt: Long? = null, val allDay: Boolean = false,
    val location: String = "", val organizer: ApiAddress? = null, val attendees: List<ApiInviteAttendee> = emptyList(),
    val status: String = "active", val myPartstat: String? = null, val canRsvp: Boolean = false, val method: String = "",
)

@Serializable data class ApiWhyLabel(val id: Int, val name: String = "")

/** `GET /api/message/:id/why` (T8.10). */
@Serializable data class ApiWhy(
    val visible: Boolean = false, val filedBy: String = "ai", val corrected: Boolean = false, val confidence: Double? = null,
    val reason: String? = null, val labels: List<ApiWhyLabel> = emptyList(),
) {
    fun line(): String {
        val who = if (corrected) "Fixed by you" else when (filedBy) {
            "rule" -> "Filed by a rule"; "similar" -> "Filed by similar mail"; "note" -> "Filed by your note"; else -> "Filed by AI"
        }
        val pct = if (confidence != null && filedBy != "rule") " · ${Math.round(confidence * 100)} %" else ""
        return who + pct
    }
}

/** What a tapped link may do. The confirm dialog shows [Allowed.url] exactly as the message wrote it. */
sealed interface LinkVerdict {
    data class Allowed(val url: String, val host: String, val scheme: String) : LinkVerdict
    data class Blocked(val reason: String) : LinkVerdict
}

object LinkGuard {
    fun check(raw: String): LinkVerdict {
        val url = raw.trim()
        val scheme = url.substringBefore(':', "").lowercase(Locale.ROOT)
        if (scheme.isEmpty() || !url.contains(':')) return LinkVerdict.Blocked("This link has no address the app can open.")
        return when (scheme) {
            "http", "https" -> {
                val host = try { URI(url).host } catch (_: Exception) { null }
                if (host.isNullOrBlank()) LinkVerdict.Blocked("This link isn't a valid web address.") else LinkVerdict.Allowed(url, host, scheme)
            }
            "mailto" -> LinkVerdict.Allowed(url, url.removePrefix("mailto:").substringBefore('?'), scheme)
            "tel" -> LinkVerdict.Allowed(url, url.removePrefix("tel:"), scheme)
            "file", "content" -> LinkVerdict.Blocked("Links to files on this phone are blocked.")
            else -> LinkVerdict.Blocked("Links of this kind ($scheme:) are blocked.")
        }
    }
}

/** Builds the page the hardened WebView shows. JavaScript is off, so this is plain HTML + CSS. */
object BodyHtml {
    /** `serverOrigin` is the Seamless address; only that origin's inline pictures (`/api/blob/…`) load while images are blocked. */
    fun page(html: String?, text: String?, dark: Boolean, showImages: Boolean, serverOrigin: String): String {
        val content = when {
            !html.isNullOrBlank() -> unblock(html, showImages)
            !text.isNullOrBlank() -> "<pre>" + escape(text) + "</pre>"
            else -> "<p>(No content)</p>"
        }
        val imgSrc = if (showImages) "https: http: data:" else "data: $serverOrigin"
        val (fg, bg, link, quote) = if (dark) listOf("#e3e3e3", "#1b1b1f", "#9ecaff", "#444") else listOf("#1f1f1f", "#ffffff", "#0b57d0", "#ccc")
        return """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src $imgSrc">
<style>
html{-webkit-text-size-adjust:100%;color-scheme:${if (dark) "dark" else "light"}}
body{margin:0;padding:4px 0;color:$fg;background:$bg;font:15px/1.5 sans-serif;overflow-wrap:anywhere;word-break:break-word}
a{color:$link} img{max-width:100%;height:auto} table{max-width:100%!important} pre{white-space:pre-wrap;font:inherit}
blockquote{margin:8px 0 8px 4px;padding-left:10px;border-left:3px solid $quote}
${if (dark) "body *{background-color:transparent!important;color:inherit!important} a,a *{color:$link!important}" else ""}
.md-blocked-img{display:none}
</style></head><body>$content</body></html>"""
    }

    /** With images allowed the server already stripped nothing; with them blocked leave `data-md-src` unused. */
    private fun unblock(html: String, show: Boolean): String =
        if (show) html.replace(Regex("""(?i)<img([^>]*?)\sdata-md-src=("[^"]*"|'[^']*')([^>]*)>""")) { m -> "<img${m.groupValues[1]} src=${m.groupValues[2]}${m.groupValues[3]}>" }
        else html

    fun escape(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}

/** Dates and "to me" strings for the conversation header. */
object ConvFormat {
    private val day = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
    private val full = DateTimeFormatter.ofPattern("EEE, d MMM yyyy, h:mm a", Locale.getDefault())

    fun parse(iso: String, zone: ZoneId = ZoneId.systemDefault()): ZonedDateTime? =
        runCatching { Instant.parse(iso).atZone(zone) }.getOrNull()

    fun full(iso: String, zone: ZoneId = ZoneId.systemDefault()) = parse(iso, zone)?.format(full).orEmpty()
    fun short(iso: String, zone: ZoneId = ZoneId.systemDefault(), now: ZonedDateTime = ZonedDateTime.now(zone)): String {
        val d = parse(iso, zone) ?: return ""
        return if (d.toLocalDate() == now.toLocalDate()) d.format(DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())) else d.format(day)
    }

    /** "to me", "to me, Sam" … the collapsed recipient line. */
    fun toLine(to: List<ApiAddress>, myEmails: Set<String>): String {
        if (to.isEmpty()) return "to (no recipients)"
        val names = to.map { if (it.email.lowercase() in myEmails) "me" else it.name.ifBlank { it.email } }
        return "to " + names.take(2).joinToString(", ") + if (names.size > 2) " +${names.size - 2}" else ""
    }

    fun size(bytes: Long): String = when {
        bytes >= 1_048_576 -> String.format(Locale.US, "%.1f MB", bytes / 1_048_576.0)
        bytes >= 1024 -> "${bytes / 1024} KB"
        else -> "$bytes B"
    }

    fun initial(e: ApiEmail) = e.sender.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "?"
}

/** Which messages of a thread start expanded: the newest, plus any unread ones; older read ones are collapsed. */
fun initiallyExpanded(thread: List<ApiEmail>): Set<String> {
    if (thread.isEmpty()) return emptySet()
    return thread.filter { it.unread }.map { it.id }.toSet() + thread.last().id
}

/** The delay before an opened message is marked read (the server has no setting for it, so the app uses 1.5 s). */
const val MARK_READ_DELAY_MS = 1500L
