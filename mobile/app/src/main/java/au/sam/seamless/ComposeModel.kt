package au.sam.seamless

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One uploaded attachment waiting to be sent (`POST /api/upload` answered with `id`). */
@Serializable data class ApiUpload(val id: String = "", val filename: String = "", val contentType: String = "", val size: Long = 0)

/** `POST /api/send` answer: either sent at once or held for the undo countdown. */
@Serializable data class SendResult(val ok: Boolean = true, val queued: Boolean = false, val jobId: Long? = null, val releaseAt: Long? = null)

@Serializable data class SignatureResponse(val html: String = "")

/** What the compose screen was asked to open. */
sealed interface ComposeRequest {
    data class New(val to: List<ApiAddress> = emptyList(), val cc: List<ApiAddress> = emptyList(), val subject: String = "", val text: String = "",
                   val attachmentUris: List<String> = emptyList()) : ComposeRequest
    data class Reply(val kind: String, val email: ApiEmail) : ComposeRequest   // reply | replyAll | forward
    data class Draft(val email: ApiEmail) : ComposeRequest
    /** Undo send: the held message comes back exactly as it was. */
    data class Restore(val payload: JsonObject) : ComposeRequest
}

/** Pure helpers: addresses, reply prefill, text⇄HTML. Kept free of Android so they are unit-tested on the JVM. */
object ComposeLogic {
    private val EMAIL = Regex("^[^\\s@<>,;\"]+@[^\\s@<>,;\"]+\\.[^\\s@<>,;\"]+$")

    fun isEmail(s: String) = EMAIL.matches(s.trim())

    /** "Ann <ann@x.com>", "ann@x.com" or a bare address → one address, or null when it is not one. */
    fun parseAddress(raw: String): ApiAddress? {
        val t = raw.trim().trim(',', ';').trim()
        if (t.isEmpty()) return null
        val m = Regex("^\"?([^\"<]*?)\"?\\s*<([^>]+)>$").matchEntire(t)
        if (m != null) return m.groupValues[2].trim().takeIf { isEmail(it) }?.let { ApiAddress(name = m.groupValues[1].trim(), email = it) }
        return if (isEmail(t)) ApiAddress(name = "", email = t) else null
    }

    /** Pasted text with several addresses separated by commas / semicolons / spaces / new lines. */
    fun parseAddressList(raw: String): Pair<List<ApiAddress>, List<String>> {
        val good = mutableListOf<ApiAddress>(); val bad = mutableListOf<String>()
        // split on separators that are not inside <...> or "..."
        val parts = mutableListOf<String>(); val cur = StringBuilder(); var angle = false; var quote = false
        for (c in raw) {
            when {
                c == '"' -> { quote = !quote; cur.append(c) }
                c == '<' && !quote -> { angle = true; cur.append(c) }
                c == '>' && !quote -> { angle = false; cur.append(c) }
                (c == ',' || c == ';' || c == '\n') && !angle && !quote -> { parts.add(cur.toString()); cur.clear() }
                else -> cur.append(c)
            }
        }
        parts.add(cur.toString())
        for (p in parts) {
            val t = p.trim(); if (t.isEmpty()) continue
            val a = parseAddress(t)
            if (a != null) good.add(a)
            else if (!t.contains('<') && t.contains(' ')) {
                // "a@x.com b@y.com" separated by spaces
                t.split(Regex("\\s+")).filter { it.isNotEmpty() }.forEach { w -> parseAddress(w)?.let(good::add) ?: bad.add(w) }
            } else bad.add(t)
        }
        return good to bad
    }

    fun dedupe(list: List<ApiAddress>): List<ApiAddress> {
        val seen = HashSet<String>()
        return list.filter { seen.add(it.email.lowercase()) }
    }

    fun escape(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    fun prefixed(subject: String, prefix: String): String {
        val re = Regex("^\\s*$prefix:\\s*", RegexOption.IGNORE_CASE)
        return if (re.containsMatchIn(subject)) subject.trim() else "$prefix: ${subject.trim()}".trim()
    }

    /** Recipients for a reply / reply-all, the same rules as the web app (own addresses dropped, Reply-To wins). */
    fun replyRecipients(kind: String, e: ApiEmail, own: Set<String>): Pair<List<ApiAddress>, List<ApiAddress>> {
        if (kind == "forward") return emptyList<ApiAddress>() to emptyList()
        val target = e.replyTo.ifEmpty { e.from }
        var to = target.filter { it.email.lowercase() !in own }
        if (to.isEmpty()) to = e.to
        var cc = emptyList<ApiAddress>()
        if (kind == "replyAll") {
            val seen = to.map { it.email.lowercase() }.toMutableSet()
            cc = (e.to + e.cc).filter { val lc = it.email.lowercase(); lc !in own && seen.add(lc) }
        }
        return dedupe(to) to cc
    }

    fun quoteHeader(e: ApiEmail, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val from = e.from.firstOrNull()
        val whenText = try {
            DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM, java.time.format.FormatStyle.SHORT).withLocale(locale)
                .format(Instant.parse(e.receivedAt).atZone(zone))
        } catch (_: Exception) { e.receivedAt }
        return "On ${escape(whenText)}, ${escape(from?.name?.ifBlank { from.email } ?: "")} &lt;${escape(from?.email ?: "")}&gt; wrote:"
    }

    /** The quoted original under a reply or forward (HTML, like the web app builds it). */
    fun quotedHtml(kind: String, e: ApiEmail, bodyHtml: String?, bodyText: String?): String {
        val inner = bodyHtml ?: "<p>${escape(bodyText.orEmpty()).replace("\n", "<br>")}</p>"
        return if (kind == "forward") {
            val from = e.from.firstOrNull()
            val head = "---------- Forwarded message ----------<br>From: ${escape(from?.name?.ifBlank { from.email } ?: "")} &lt;${escape(from?.email ?: "")}&gt;<br>" +
                "Subject: ${escape(e.subject)}<br>To: ${escape(e.to.joinToString(", ") { it.email })}"
            "<p>$head</p><blockquote>$inner</blockquote>"
        } else "<p>${quoteHeader(e)}</p><blockquote>$inner</blockquote>"
    }

    // ---- text ⇄ HTML (the editor is plain text; **bold**, _italic_ and "- " lists become HTML) ----

    private val boldRe = Regex("\\*\\*(.+?)\\*\\*")
    private val italicRe = Regex("(?<![\\w_])_(.+?)_(?![\\w_])")

    private fun inline(line: String): String {
        var s = escape(line)
        s = boldRe.replace(s) { "<strong>${it.groupValues[1]}</strong>" }
        s = italicRe.replace(s) { "<em>${it.groupValues[1]}</em>" }
        return s
    }

    /** Typed text → HTML paragraphs / lists. Blank text gives "" so the caller can tell "nothing typed". */
    fun textToHtml(text: String): String {
        if (text.isBlank()) return ""
        val out = StringBuilder()
        var inList = false
        val para = mutableListOf<String>()
        fun flush() { if (para.isNotEmpty()) { out.append("<p>").append(para.joinToString("<br>")).append("</p>"); para.clear() } }
        for (raw in text.replace("\r\n", "\n").split("\n")) {
            val li = Regex("^\\s*[-*•]\\s+(.*)$").matchEntire(raw)
            if (li != null) {
                flush()
                if (!inList) { out.append("<ul>"); inList = true }
                out.append("<li>").append(inline(li.groupValues[1])).append("</li>")
            } else {
                if (inList) { out.append("</ul>"); inList = false }
                if (raw.isBlank()) flush() else para.add(inline(raw))
            }
        }
        flush(); if (inList) out.append("</ul>")
        return out.toString()
    }

    /** HTML of an old draft → the editor's text (best effort; formatting we can't show is dropped). */
    fun htmlToText(html: String): String {
        var s = html
        s = Regex("<\\s*br\\s*/?>", RegexOption.IGNORE_CASE).replace(s, "\n")
        s = Regex("</\\s*(p|div)\\s*>", RegexOption.IGNORE_CASE).replace(s, "\n\n")
        s = Regex("<\\s*li[^>]*>", RegexOption.IGNORE_CASE).replace(s, "- ")
        s = Regex("</\\s*li\\s*>", RegexOption.IGNORE_CASE).replace(s, "\n")
        s = Regex("</?\\s*(strong|b)\\b[^>]*>", RegexOption.IGNORE_CASE).replace(s, "**")
        s = Regex("</?\\s*(em|i)\\b[^>]*>", RegexOption.IGNORE_CASE).replace(s, "_")
        s = Regex("<[^>]+>").replace(s, "")
        s = s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
        return s.replace(Regex("\n{3,}"), "\n\n").trim()
    }

    /** A draft's HTML split into what the user typed and the part kept as-is (signature + quoted original). */
    fun splitDraft(html: String): Pair<String, String> {
        val idx = listOf(html.indexOf("<div data-seamless-signature"), html.indexOf("<blockquote"))
            .filter { it >= 0 }.minOrNull() ?: return html to ""
        // keep the "On … wrote:" paragraph with the quote
        var cut = idx
        if (html.startsWith("<blockquote", idx)) {
            val p = html.lastIndexOf("<p>", idx)
            if (p >= 0 && html.substring(p, idx).contains("wrote:")) cut = p
        }
        return html.substring(0, cut) to html.substring(cut)
    }

    /** Splits the kept tail into (signature, quoted) so the signature can follow the From identity. */
    fun splitTail(tail: String): Pair<String, String> {
        val start = tail.indexOf("<div data-seamless-signature")
        if (start < 0) return "" to tail
        // the signature div has no nested <div> in cleanSigHtml output we care about: find the matching close by depth
        var depth = 0; var i = start
        val re = Regex("<div\\b|</div>")
        for (m in re.findAll(tail, start)) {
            if (m.value == "</div>") { depth--; if (depth == 0) { i = m.range.last + 1; break } } else depth++
        }
        return tail.substring(start, i) to tail.substring(i)
    }

    fun assembleHtml(text: String, signatureHtml: String, quotedHtml: String): String {
        val body = textToHtml(text).ifEmpty { "<p></p>" }
        return body + signatureHtml + quotedHtml
    }

    /** Which identity a new message starts from: the saved default, else the viewed mailbox's, else the server default. */
    fun pickIdentity(identities: List<ApiIdentity>, preferEmail: String, viewedAccountId: Int?): ApiIdentity? {
        if (identities.isEmpty()) return null
        if (preferEmail.isNotBlank()) identities.firstOrNull { it.email.equals(preferEmail, true) }?.let { return it }
        if (viewedAccountId != null) {
            identities.firstOrNull { it.accountId == viewedAccountId && !it.isAlias }?.let { return it }
            identities.firstOrNull { it.accountId == viewedAccountId }?.let { return it }
        }
        return identities.firstOrNull { it.isDefault } ?: identities.first()
    }

    /** mailto:a@x.com,b@y.com?subject=…&body=…&cc=… */
    fun parseMailto(uri: String): ComposeRequest.New? {
        if (!uri.startsWith("mailto:", true)) return null
        val rest = uri.substring(7)
        val q = rest.indexOf('?')
        val path = if (q >= 0) rest.substring(0, q) else rest
        val params = if (q >= 0) rest.substring(q + 1).split('&').mapNotNull {
            val kv = it.split('=', limit = 2); if (kv.size == 2) kv[0].lowercase() to dec(kv[1]) else null
        }.toMap() else emptyMap()
        val to = parseAddressList(dec(path) + "," + params["to"].orEmpty()).first
        val cc = parseAddressList(params["cc"].orEmpty()).first
        return ComposeRequest.New(to = dedupe(to), cc = dedupe(cc), subject = params["subject"].orEmpty(), text = params["body"].orEmpty())
    }

    private fun dec(s: String) = try { java.net.URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { s }

    const val MAX_ATTACH_BYTES = 50L * 1024 * 1024  // the server's multipart fileSize limit
    const val MAX_TOTAL_BYTES = 40L * 1024 * 1024   // the request body limit is 60 MB; keep a margin for base64-free build

    /** A sentence when a file can't be attached, else null. */
    fun attachProblem(size: Long, totalSoFar: Long): String? = when {
        size > MAX_ATTACH_BYTES -> "That file is bigger than the server accepts (${MAX_ATTACH_BYTES / 1048576} MB)."
        totalSoFar + size > MAX_TOTAL_BYTES -> "Attachments are limited to ${MAX_TOTAL_BYTES / 1048576} MB in total."
        else -> null
    }

    fun addressJson(a: ApiAddress) = buildJsonObject { put("email", a.email); put("name", a.name) }
}

/** The toolbar's text edits (pure, so they are tested without a screen). */
object Editing {
    /** Result: new text and the selection (start, end). */
    data class Edit(val text: String, val start: Int, val end: Int)

    /** Wraps the selection in `marker` (** or _); with no selection puts the cursor between a new pair; unwraps when already wrapped. */
    fun wrap(text: String, start: Int, end: Int, marker: String): Edit {
        val s = start.coerceIn(0, text.length); val e = end.coerceIn(s, text.length)
        val m = marker.length
        if (s >= m && e + m <= text.length && text.substring(s - m, s) == marker && text.substring(e, e + m) == marker)
            return Edit(text.removeRange(e, e + m).removeRange(s - m, s), s - m, e - m)
        if (e - s >= 2 * m && text.substring(s, s + m) == marker && text.substring(e - m, e) == marker)
            return Edit(text.substring(0, s) + text.substring(s + m, e - m) + text.substring(e), s, e - 2 * m)
        return Edit(text.substring(0, s) + marker + text.substring(s, e) + marker + text.substring(e), s + m, e + m)
    }

    /** Makes every line touched by the selection a "- " list item, or removes the dash when all of them already are. */
    fun toggleList(text: String, start: Int, end: Int): Edit {
        val s = start.coerceIn(0, text.length); val e = end.coerceIn(s, text.length)
        val ls = if (s == 0) 0 else text.lastIndexOf('\n', s - 1) + 1
        val le = text.indexOf('\n', e).let { if (it < 0) text.length else it }
        val lines = text.substring(ls, le).split('\n')
        val all = lines.all { it.startsWith("- ") }
        val out = lines.joinToString("\n") { if (all) it.removePrefix("- ") else if (it.startsWith("- ")) it else "- $it" }
        val delta = out.length - (le - ls)
        return Edit(text.substring(0, ls) + out + text.substring(le), s + (if (all) -2 else 2).coerceAtLeast(-s), e + delta)
    }
}

/** Android intents that should open compose: SENDTO/VIEW mailto:, SEND and SEND_MULTIPLE (a share). */
object IntentCompose {
    fun parse(intent: android.content.Intent?): ComposeRequest? {
        intent ?: return null
        return when (intent.action) {
            android.content.Intent.ACTION_SENDTO, android.content.Intent.ACTION_VIEW -> {
                val data = intent.dataString ?: return null
                val m = ComposeLogic.parseMailto(data) ?: return null
                extras(intent, m)
            }
            android.content.Intent.ACTION_SEND, android.content.Intent.ACTION_SEND_MULTIPLE -> extras(intent, ComposeRequest.New())
            else -> null
        }
    }

    @Suppress("DEPRECATION")
    private fun extras(intent: android.content.Intent, base: ComposeRequest.New): ComposeRequest.New {
        fun list(key: String) = intent.getStringArrayExtra(key)?.toList().orEmpty().flatMap { ComposeLogic.parseAddressList(it).first }
        val to = ComposeLogic.dedupe(base.to + list(android.content.Intent.EXTRA_EMAIL))
        val cc = ComposeLogic.dedupe(base.cc + list(android.content.Intent.EXTRA_CC))
        val subject = base.subject.ifBlank { intent.getStringExtra(android.content.Intent.EXTRA_SUBJECT).orEmpty() }
        val text = base.text.ifBlank { intent.getCharSequenceExtra(android.content.Intent.EXTRA_TEXT)?.toString().orEmpty() }
        val uris = mutableListOf<String>()
        if (intent.action == android.content.Intent.ACTION_SEND_MULTIPLE) {
            intent.getParcelableArrayListExtra<android.net.Uri>(android.content.Intent.EXTRA_STREAM)?.forEach { uris.add(it.toString()) }
        } else (intent.getParcelableExtra<android.net.Uri>(android.content.Intent.EXTRA_STREAM))?.let { uris.add(it.toString()) }
        return ComposeRequest.New(to = to, cc = cc, subject = subject, text = text, attachmentUris = uris.filter { it.startsWith("content:") })
    }
}
