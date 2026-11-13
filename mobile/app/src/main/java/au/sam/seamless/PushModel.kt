package au.sam.seamless

/** The data-only FCM message the server sends (see server/src/push/mobile.ts). Pure Kotlin so it is unit tested. */
data class PushPayload(
    val type: String,
    val messageId: Long? = null,
    val accountId: Int? = null,
    val alertId: Int? = null,
    val sender: String = "",
    val subject: String = "",
    val snippet: String = "",
    val hidden: Boolean = false,
)

object Push {
    const val CH_MAIL = "mail"
    const val CH_ALERTS = "alerts"
    const val CH_SYNC = "sync"

    const val TAG_MAIL = "mail"
    const val TAG_ALERT = "alert"
    const val TAG_GROUP = "group"
    const val TAG_TEST = "test"

    fun parse(data: Map<String, String>): PushPayload? {
        val type = data["type"]?.takeIf { it in setOf("mail", "alert", "read", "test") } ?: return null
        return PushPayload(
            type = type,
            messageId = data["messageId"]?.toLongOrNull(),
            accountId = data["accountId"]?.toIntOrNull(),
            alertId = data["alertId"]?.toIntOrNull(),
            sender = data["sender"].orEmpty(), subject = data["subject"].orEmpty(), snippet = data["snippet"].orEmpty(),
            hidden = data["hidden"] == "1",
        )
    }

    /** What to put on screen for one notification. [hideContent] is this phone's own privacy switch (a second line of defence). */
    data class Spec(
        val channel: String, val tag: String, val id: Int, val group: String?,
        val title: String, val text: String, val bigText: String, val subText: String?,
        val openMessageId: Long? = null, val openAlertId: Int? = null,
        val canAct: Boolean = false,
    )

    fun spec(p: PushPayload, hideContent: Boolean, accountName: String?): Spec? = when (p.type) {
        "mail" -> {
            val mid = p.messageId ?: return null
            val hide = p.hidden || hideContent
            val title = if (hide) "New mail" else p.sender.ifBlank { "New mail" }
            val text = if (hide) "You have a new message" else p.subject.ifBlank { "(no subject)" }
            Spec(CH_MAIL, TAG_MAIL, noteId(mid), p.accountId?.let { groupKey(it) }, title, text,
                if (hide) text else listOf(p.subject.ifBlank { "(no subject)" }, p.snippet).filter { it.isNotBlank() }.joinToString("\n"),
                accountName, openMessageId = mid, canAct = true)
        }
        "alert" -> {
            val aid = p.alertId ?: return null
            val hide = p.hidden || hideContent
            val title = if (hide) "Seamless needs attention" else p.subject.ifBlank { "Seamless needs attention" }
            val text = if (hide) "Open the app to see what is wrong" else p.snippet.ifBlank { "Open the app to see what is wrong" }
            Spec(CH_ALERTS, TAG_ALERT, aid, null, title, text, text, accountName, openAlertId = aid)
        }
        "test" -> Spec(CH_MAIL, TAG_TEST, 1, null, p.subject.ifBlank { "Test push from Seamless" }, p.snippet.ifBlank { "If you can read this, push works." },
            p.snippet.ifBlank { "If you can read this, push works." }, null)
        else -> null
    }

    fun noteId(messageId: Long): Int = (messageId and 0x7fffffff).toInt()
    fun groupKey(accountId: Int) = "mailbox-$accountId"
    fun summaryId(accountId: Int) = 2_000_000_000 + accountId

    /** "3 new messages" for the group summary. */
    fun summaryText(n: Int) = if (n == 1) "1 new message" else "$n new messages"

    /** The JMAP id of a pushed message. */
    fun emailId(messageId: Long) = "m$messageId"

    /** Notification deep links: one extra says what to open. */
    const val EXTRA_OPEN_MESSAGE = "seamless.open.message"
    const val EXTRA_OPEN_ALERT = "seamless.open.alert"
    const val EXTRA_REPLY_MESSAGE = "seamless.reply.message"
}

/** Where a tap on a notification (or a shortcut) takes the user once they are signed in. */
sealed interface OpenTarget {
    data class Message(val id: Long) : OpenTarget
    data class Reply(val id: Long) : OpenTarget
    data class Alert(val id: Int) : OpenTarget

    companion object {
        fun fromExtras(message: Long?, reply: Long?, alert: Int?): OpenTarget? = when {
            reply != null && reply > 0 -> Reply(reply)
            message != null && message > 0 -> Message(message)
            alert != null && alert > 0 -> Alert(alert)
            else -> null
        }
    }
}

/**
 * Fallback sync (used when push isn't set up): which unread messages are new since the last check.
 * The first run only records a baseline, so installing the app never fires a wall of notifications.
 */
object SyncPlan {
    const val KEEP = 300

    data class Result(val fresh: List<ApiEmail>, val seen: List<String>)

    fun newMail(unread: List<ApiEmail>, seenBefore: List<String>?, mutedAccounts: Set<Int>): Result {
        val ids = unread.map { it.id }
        val merged = (ids + seenBefore.orEmpty()).distinct().take(KEEP)
        if (seenBefore == null) return Result(emptyList(), merged)
        val known = seenBefore.toHashSet()
        return Result(unread.filter { it.id !in known && it.accountId !in mutedAccounts }.take(10), merged)
    }

    fun newAlerts(open: List<ApiAlert>, notified: Set<Int>): List<ApiAlert> = open.filter { it.state == "open" && it.id !in notified }

    fun payload(e: ApiEmail): PushPayload = PushPayload("mail", e.id.removePrefix("m").toLongOrNull(), e.accountId,
        sender = e.sender, subject = e.subject, snippet = e.preview.take(100))

    fun payload(a: ApiAlert): PushPayload = PushPayload("alert", alertId = a.id, subject = a.title, snippet = a.body.take(100))
}
