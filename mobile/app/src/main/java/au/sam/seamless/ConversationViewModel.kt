package au.sam.seamless

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One message of the open conversation with whatever has been fetched for it so far. */
data class ConvMessage(
    val email: ApiEmail,
    val body: ApiBody? = null,
    val bodyError: String? = null,
    val why: ApiWhy? = null,
    val imagesShown: Boolean = false,
)

/** The conversation screen: thread, bodies, images, mark-as-read timer, toolbar actions. */
class ConversationViewModel(
    private val api: Api,
    private val session: Session,
    private val mail: MailViewModel,
    private val scope: CoroutineScope,
    private val first: ApiEmail,
    private val close: () -> Unit,
    private val myEmails: () -> Set<String>,
) {
    private val base get() = session.serverUrl

    var subject by mutableStateOf(first.subject)
    var messages by mutableStateOf(listOf(ConvMessage(first))); private set
    var expanded by mutableStateOf(setOf(first.id)); private set
    var details by mutableStateOf<Set<String>>(emptySet()); private set
    var loading by mutableStateOf(true); private set
    var error by mutableStateOf<String?>(null); private set
    var moreOpen by mutableStateOf(false)
    var sheet by mutableStateOf<ConvSheet?>(null)
    var fixFor by mutableStateOf<ConvMessage?>(null)
    var confirmLink by mutableStateOf<String?>(null)
    var blockedLink by mutableStateOf<String?>(null)
    private var readJob: Job? = null

    val me: Set<String> get() = myEmails()
    val newest: ConvMessage get() = messages.last()
    /** Ids the toolbar acts on: the whole thread (JMAP threads are handled by the server per message). */
    private val ids: Set<String> get() = if (session.conversationView) messages.map { it.email.id }.toSet() else setOf(first.id)
    val labelIds: Set<Int> get() = messages.flatMap { it.email.labelIds }.toSet()
    val anyUnreadLeft: Boolean get() = messages.any { it.email.unread }

    fun start() {
        scope.launch {
            loading = true; error = null
            val list: List<ApiEmail> = if (session.conversationView && first.threadId.isNotEmpty()) {
                when (val t = withContext(Dispatchers.IO) { api.threadEmailIds(base, first.threadId) }) {
                    is ApiResult.Ok -> when (val e = withContext(Dispatchers.IO) { api.emailsByIds(base, t.value) }) {
                        is ApiResult.Ok -> e.value.sortedBy { it.receivedAt }.ifEmpty { listOf(first) }
                        else -> listOf(first)
                    }
                    ApiResult.Unauthorized -> { loading = false; return@launch }
                    else -> listOf(first)
                }
            } else listOf(first)
            messages = list.map { ConvMessage(it, imagesShown = shouldShowImages(it)) }
            subject = list.last().subject.ifBlank { "(no subject)" }
            expanded = initiallyExpanded(list)
            loading = false
            expanded.forEach(::loadBody)
            scheduleRead(messages.last().email.id)
        }
    }

    private fun shouldShowImages(e: ApiEmail) = e.from.firstOrNull()?.email?.lowercase() in session.imageSenders

    fun toggleExpanded(id: String) {
        if (id in expanded) { expanded = expanded - id; return }
        expanded = expanded + id
        loadBody(id)
        scheduleRead(id)
    }

    fun toggleDetails(id: String) { details = if (id in details) details - id else details + id }

    private fun update(id: String, f: (ConvMessage) -> ConvMessage) { messages = messages.map { if (it.email.id == id) f(it) else it } }

    fun loadBody(id: String, remote: Boolean = false) {
        scope.launch {
            val wantRemote = remote || messages.firstOrNull { it.email.id == id }?.imagesShown == true
            when (val r = withContext(Dispatchers.IO) { api.body(base, id, wantRemote) }) {
                is ApiResult.Ok -> update(id) { it.copy(body = r.value, bodyError = null, imagesShown = wantRemote) }
                is ApiResult.Failed -> update(id) { it.copy(bodyError = r.message) }
                is ApiResult.Network -> update(id) { it.copy(bodyError = r.message) }
                ApiResult.Unauthorized -> {}
            }
            if (messages.firstOrNull { it.email.id == id }?.why == null) {
                val w = withContext(Dispatchers.IO) { api.why(base, id) }
                if (w is ApiResult.Ok && w.value.visible) update(id) { it.copy(why = w.value) }
            }
        }
    }

    fun showImages(id: String, always: Boolean) {
        if (always) messages.firstOrNull { it.email.id == id }?.email?.from?.firstOrNull()?.email?.lowercase()?.let { session.imageSenders = session.imageSenders + it }
        update(id) { it.copy(imagesShown = true) }
        loadBody(id, remote = true)
    }

    /** Marks a message read 1.5 s after it is on screen; leaving the screen first cancels it. */
    private fun scheduleRead(id: String) {
        val m = messages.firstOrNull { it.email.id == id } ?: return
        if (!m.email.unread) return
        readJob?.cancel()
        readJob = scope.launch {
            delay(MARK_READ_DELAY_MS)
            markLocal(setOf(id), read = true)
            mail.act("read", setOf(id))
        }
    }

    fun leave() { readJob?.cancel(); close() }

    private fun markLocal(targets: Set<String>, read: Boolean) {
        messages = messages.map {
            if (it.email.id in targets) it.copy(email = it.email.copy(keywords = if (read) it.email.keywords + ("\$seen" to true) else it.email.keywords - "\$seen")) else it
        }
    }

    // ---- toolbar ----
    fun archive() { mail.act("archive", ids); leave() }
    fun delete() { mail.act("delete", ids); leave() }
    fun spam() { mail.act("spam", ids); leave() }
    fun markUnread() { readJob?.cancel(); mail.act("unread", ids); leave() }
    fun move(folderId: String) { mail.act("move", ids, target = folderId); leave() }
    fun snooze(preset: SnoozePreset) { mail.act("snooze", ids, value = mail.snoozeUntil(preset)); leave() }

    fun toggleStar(id: String) {
        val m = messages.firstOrNull { it.email.id == id } ?: return
        val star = !m.email.starred
        messages = messages.map { if (it.email.id == id) it.copy(email = it.email.copy(keywords = if (star) it.email.keywords + ("\$flagged" to true) else it.email.keywords - "\$flagged")) else it }
        mail.act(if (star) "star" else "unstar", setOf(id))
    }

    /** Label picker: ticking adds the label to the thread, unticking removes it. */
    fun setLabel(labelId: Int, on: Boolean) {
        messages = messages.map { m -> m.copy(email = m.email.copy(labelIds = if (on) (m.email.labelIds + labelId).distinct() else m.email.labelIds - labelId)) }
        mail.act(if (on) "label" else "unlabel", ids, value = labelId.toLong())
    }

    fun createLabel(name: String, done: (String?) -> Unit) {
        val n = name.trim()
        if (n.isEmpty()) { done("Give the label a name."); return }
        mail.saveLabel(null, n, "#4285f4", null) { err ->
            if (err == null) {
                val created = mail.labels.firstOrNull { it.name.equals(n, true) }
                if (created != null) setLabel(created.id, true)
            }
            done(err)
        }
    }

    // ---- links ----
    fun linkTapped(url: String) {
        when (val v = LinkGuard.check(url)) {
            is LinkVerdict.Allowed -> confirmLink = v.url
            is LinkVerdict.Blocked -> blockedLink = v.reason
        }
    }

    // ---- invite, why ----
    fun rsvp(m: ConvMessage, partstat: String) {
        val inv = m.body?.invite ?: return
        scope.launch {
            val r = withContext(Dispatchers.IO) { api.rsvp(base, inv.id, partstat) }
            if (r is ApiResult.Ok) {
                update(m.email.id) { it.copy(body = it.body?.copy(invite = inv.copy(myPartstat = partstat))) }
                mail.snacks.tryEmit(Snack(when (partstat) { "ACCEPTED" -> "Accepted"; "DECLINED" -> "Declined"; else -> "Replied maybe" }))
            } else mail.snacks.tryEmit(Snack((r as? ApiResult.Failed)?.message ?: (r as? ApiResult.Network)?.message ?: "Couldn't send your answer."))
        }
    }

    fun fix(m: ConvMessage, labelId: Int?, remember: Boolean) {
        scope.launch {
            val r = withContext(Dispatchers.IO) { api.correct(base, m.email.id, labelId, remember) }
            if (r is ApiResult.Ok) {
                val cid = r.value
                mail.snacks.tryEmit(Snack(if (remember) "Fixed — the AI will remember this" else "Fixed", "Undo") {
                    scope.launch { withContext(Dispatchers.IO) { api.undoCorrection(base, cid) }; loadBody(m.email.id); mail.refresh() }
                })
                update(m.email.id) { it.copy(why = null) }
                loadBody(m.email.id)
                mail.refresh()
            } else mail.snacks.tryEmit(Snack((r as? ApiResult.Failed)?.message ?: (r as? ApiResult.Network)?.message ?: "Couldn't save that."))
        }
    }

    fun retry() = start()
}

enum class ConvSheet { Label, Snooze, Move }
