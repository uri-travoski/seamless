package au.sam.seamless

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.TextFieldValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import java.io.InputStream

/** Reads phone files chosen with the system picker (kept out of the model so it needs no Android classes). */
interface FileAccess {
    fun describe(uri: String): Triple<String, Long, String>?   // name, size, mime
    fun open(uri: String): InputStream?
}

enum class UploadState { Uploading, Done, Failed }

class Attachment(val key: Int, val name: String, val size: Long, val uri: String) {
    var state by mutableStateOf(UploadState.Uploading)
    var uploadId by mutableStateOf("")
    var error by mutableStateOf("")
}

/** One open compose screen: the fields, the reply prefill, attachments, send / schedule / draft. */
class ComposeViewModel(
    private val api: Api,
    private val session: Session,
    private val scope: CoroutineScope,
    val request: ComposeRequest,
    private val viewedAccountId: Int?,
    val viewingMode: Boolean,
    private val files: FileAccess,
    /** Called once the server took the message: (result, payload, subject). */
    private val onSent: (SendResult, JsonObject, String) -> Unit,
    private val onScheduled: (Long) -> Unit,
    private val onClose: () -> Unit,
    private val onSignedOut: () -> Unit = {},
) {
    private val base get() = session.serverUrl

    var identities by mutableStateOf<List<ApiIdentity>>(emptyList()); private set
    var identity by mutableStateOf<ApiIdentity?>(null); private set
    var to by mutableStateOf<List<ApiAddress>>(emptyList()); private set
    var cc by mutableStateOf<List<ApiAddress>>(emptyList()); private set
    var bcc by mutableStateOf<List<ApiAddress>>(emptyList()); private set
    var toInput by mutableStateOf(""); var ccInput by mutableStateOf(""); var bccInput by mutableStateOf("")
    var showCcBcc by mutableStateOf(false)
    var subject by mutableStateOf("")
    var text by mutableStateOf(TextFieldValue(""))
    var signatureHtml by mutableStateOf(""); private set
    var quotedHtml by mutableStateOf(""); private set
    var quoteVisible by mutableStateOf(false)
    var attachments by mutableStateOf<List<Attachment>>(emptyList()); private set
    var scheduleAt by mutableStateOf<Long?>(null)
    var loading by mutableStateOf(true); private set
    var sending by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var focusField by mutableStateOf("to")
    var suggestions by mutableStateOf<List<ApiAddress>>(emptyList()); private set
    var suggestFor by mutableStateOf("to"); private set
    var confirmNoSubject by mutableStateOf(false)
    var confirmDiscard by mutableStateOf(false)
    var draftSaved by mutableStateOf(false); private set

    private var inReplyTo: String? = null
    private var replyToEmailId: String? = null
    var draftId: String? = null; private set
    private var restoredAttachments: List<JsonObject> = emptyList()
    private var accountIdOverride: Int? = null
    private var baseline = ""        // the content as last saved/loaded: "dirty" means different from this
    private var nextKey = 1
    private var saving = false
    private var suggestJob: Job? = null
    private var autosaveJob: Job? = null
    private var closed = false

    val canSend: Boolean get() = !viewingMode && !sending && !loading

    // ------------------------------------------------------------------ start

    fun start() {
        scope.launch {
            val ids = withContext(Dispatchers.IO) { api.identities(base) }
            when (ids) {
                is ApiResult.Ok -> identities = ids.value.filter { it.email.isNotBlank() }
                is ApiResult.Unauthorized -> { onSignedOut(); return@launch }
                is ApiResult.Network -> error = ids.message
                is ApiResult.Failed -> error = ids.message
            }
            when (val r = request) {
                is ComposeRequest.New -> startNew(r)
                is ComposeRequest.Reply -> startReply(r)
                is ComposeRequest.Draft -> startDraft(r)
                is ComposeRequest.Restore -> startRestore(r)
            }
            loading = false
            baseline = if (request is ComposeRequest.Restore) "" else snapshot() // an undone send is unsaved work
            if (request is ComposeRequest.New && request.to.isEmpty()) focusField = "to" else if (to.isNotEmpty() && subject.isNotEmpty()) focusField = "body"
            scheduleAutosave()
        }
    }

    private suspend fun loadSignature(i: ApiIdentity?): String {
        val id = i?.id ?: return ""
        return (withContext(Dispatchers.IO) { api.signature(base, id) } as? ApiResult.Ok)?.value.orEmpty()
    }

    private suspend fun startNew(r: ComposeRequest.New) {
        identity = ComposeLogic.pickIdentity(identities, session.defaultFrom, viewedAccountId)
        signatureHtml = loadSignature(identity)
        to = r.to; cc = r.cc; subject = r.subject
        if (r.cc.isNotEmpty()) showCcBcc = true
        text = TextFieldValue(r.text)
        r.attachmentUris.forEach { addAttachment(it) }
    }

    private suspend fun startReply(r: ComposeRequest.Reply) {
        val e = r.email
        // from: the address the mail was sent to (server rule), else the mailbox it lives in
        val match = (withContext(Dispatchers.IO) { api.matchIdentity(base, e.id) } as? ApiResult.Ok)?.value
        val mEmail = match?.get("email")?.jsonPrimitive?.contentOrNull
        val mAcc = match?.get("accountId")?.jsonPrimitive?.intOrNull
        identity = identities.firstOrNull { it.email.equals(mEmail, true) && it.accountId == (mAcc ?: it.accountId) }
            ?: ComposeLogic.pickIdentity(identities, "", e.accountId)
        val own = identities.map { it.email.lowercase() }.toSet() + session.email.lowercase()
        val (t, c) = ComposeLogic.replyRecipients(r.kind, e, own)
        to = t; cc = c; if (c.isNotEmpty()) showCcBcc = true
        subject = ComposeLogic.prefixed(e.subject, if (r.kind == "forward") "Fwd" else "Re")
        if (r.kind != "forward") { inReplyTo = e.messageId; replyToEmailId = e.id }
        if (r.kind == "forward") focusField = "to"
        signatureHtml = loadSignature(identity)
        val body = (withContext(Dispatchers.IO) { api.body(base, e.id, false) } as? ApiResult.Ok)?.value
        if (body == null) notice = "Couldn't load the original message to quote. You can still write your reply."
        else quotedHtml = ComposeLogic.quotedHtml(r.kind, e, body.html, body.text)
        quoteVisible = false
    }

    private suspend fun startDraft(r: ComposeRequest.Draft) {
        val e = r.email
        draftId = e.id
        identity = identities.firstOrNull { it.email.equals(e.from.firstOrNull()?.email, true) && it.accountId == e.accountId }
            ?: identities.firstOrNull { it.email.equals(e.from.firstOrNull()?.email, true) }
            ?: ComposeLogic.pickIdentity(identities, "", e.accountId)
        to = e.to; cc = e.cc; if (e.cc.isNotEmpty()) showCcBcc = true
        subject = e.subject
        val body = (withContext(Dispatchers.IO) { api.body(base, e.id, false) } as? ApiResult.Ok)?.value
        val html = body?.html ?: body?.text?.let { "<p>" + ComposeLogic.escape(it).replace("\n", "<br>") + "</p>" }.orEmpty()
        val (head, tail) = ComposeLogic.splitDraft(html)
        val (sig, quote) = ComposeLogic.splitTail(tail)
        text = TextFieldValue(ComposeLogic.htmlToText(head))
        signatureHtml = sig; quotedHtml = quote
        replyToEmailId = null
        if (body == null) notice = "Couldn't load the draft's text."
    }

    private suspend fun startRestore(r: ComposeRequest.Restore) {
        val p = r.payload
        fun addrs(k: String) = p[k]?.jsonArray?.map { ApiAddress(name = it.jsonObject["name"]?.jsonPrimitive?.contentOrNull.orEmpty(), email = it.jsonObject["email"]?.jsonPrimitive?.content.orEmpty()) }.orEmpty()
        to = addrs("to"); cc = addrs("cc"); bcc = addrs("bcc")
        showCcBcc = cc.isNotEmpty() || bcc.isNotEmpty()
        subject = p["subject"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val from = p["fromEmail"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val acc = p["accountId"]?.jsonPrimitive?.intOrNull
        identity = identities.firstOrNull { it.email.equals(from, true) && it.accountId == acc } ?: identities.firstOrNull { it.email.equals(from, true) }
            ?: ComposeLogic.pickIdentity(identities, "", acc)
        val html = p["html"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val (head, tail) = ComposeLogic.splitDraft(html)
        val (sig, quote) = ComposeLogic.splitTail(tail)
        text = TextFieldValue(ComposeLogic.htmlToText(head)); signatureHtml = sig; quotedHtml = quote
        inReplyTo = p["inReplyTo"]?.jsonPrimitive?.contentOrNull
        replyToEmailId = p["replyToEmailId"]?.jsonPrimitive?.contentOrNull
        draftId = p["draftId"]?.jsonPrimitive?.contentOrNull
        // The uploads are still on the server (undo hands them back), so the chips can be rebuilt.
        val ids = p["attachmentIds"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
        val meta = p["attachments"]?.jsonArray?.map { it.jsonObject }.orEmpty()
        attachments = ids.mapIndexed { i, id ->
            val m = meta.firstOrNull { it.get("id")?.jsonPrimitive?.contentOrNull == id }
            Attachment(nextKey++, m?.get("filename")?.jsonPrimitive?.contentOrNull ?: "attachment ${i + 1}", m?.get("size")?.jsonPrimitive?.longOrNull ?: 0, "")
                .also { it.state = UploadState.Done; it.uploadId = id }
        }
        restoredAttachments = meta
    }

    // ------------------------------------------------------------------ fields

    fun pickIdentity(i: ApiIdentity) {
        if (i == identity) return
        identity = i
        accountIdOverride = null
        scope.launch { signatureHtml = loadSignature(i) }
    }

    fun inputOf(field: String) = when (field) { "to" -> toInput; "cc" -> ccInput; else -> bccInput }
    fun setInput(field: String, v: String) {
        when (field) { "to" -> toInput = v; "cc" -> ccInput = v; else -> bccInput = v }
        suggestFor = field
        // a separator typed or pasted commits what came before it
        if (v.any { it == ',' || it == ';' || it == '\n' } || (v.endsWith(" ") && ComposeLogic.parseAddress(v.trim()) != null)) { commit(field); return }
        suggestJob?.cancel()
        val term = v.trim()
        if (term.length < 2) { suggestions = emptyList(); return }
        suggestJob = scope.launch {
            delay(180)
            val r = withContext(Dispatchers.IO) { api.suggestContacts(base, term) }
            if (r is ApiResult.Ok && inputOf(field).trim() == term) suggestions = r.value.map { ApiAddress(name = it.name, email = it.email) }.filter { ComposeLogic.isEmail(it.email) }.take(6)
            else if (r !is ApiResult.Ok) suggestions = emptyList()
        }
    }

    private fun listFor(field: String) = when (field) { "to" -> to; "cc" -> cc; else -> bcc }
    private fun setList(field: String, v: List<ApiAddress>) { when (field) { "to" -> to = v; "cc" -> cc = v; else -> bcc = v } }

    fun addAddress(field: String, a: ApiAddress) {
        setList(field, ComposeLogic.dedupe(listFor(field) + a))
        when (field) { "to" -> toInput = ""; "cc" -> ccInput = ""; else -> bccInput = "" }
        suggestions = emptyList()
    }

    fun removeAddress(field: String, a: ApiAddress) { setList(field, listFor(field).filter { it !== a && it.email != a.email }) }

    /** Turns the typed text into chips. Returns the words that are not addresses (they stay in the box). */
    fun commit(field: String): List<String> {
        val raw = inputOf(field)
        if (raw.isBlank()) return emptyList()
        val (good, bad) = ComposeLogic.parseAddressList(raw)
        setList(field, ComposeLogic.dedupe(listFor(field) + good))
        val rest = bad.joinToString(", ")
        when (field) { "to" -> toInput = rest; "cc" -> ccInput = rest; else -> bccInput = rest }
        suggestions = emptyList()
        return bad
    }

    // ------------------------------------------------------------------ attachments

    fun addAttachment(uri: String) {
        val info = files.describe(uri)
        if (info == null) { error = "Couldn't read that file."; return }
        val (name, size, mime) = info
        val total = attachments.sumOf { it.size }
        ComposeLogic.attachProblem(size, total)?.let { error = it; return }
        val a = Attachment(nextKey++, name, size, uri)
        attachments = attachments + a
        upload(a, mime)
    }

    private fun upload(a: Attachment, mime: String) {
        a.state = UploadState.Uploading; a.error = ""
        scope.launch {
            val r = withContext(Dispatchers.IO) { api.upload(base, a.name, mime, a.size) { files.open(a.uri) } }
            when (r) {
                is ApiResult.Ok -> { a.uploadId = r.value.id; a.state = UploadState.Done }
                is ApiResult.Unauthorized -> onSignedOut()
                is ApiResult.Network -> { a.state = UploadState.Failed; a.error = r.message }
                is ApiResult.Failed -> { a.state = UploadState.Failed; a.error = r.message }
            }
        }
    }

    fun retryAttachment(a: Attachment) { files.describe(a.uri)?.let { upload(a, it.third) } }
    fun removeAttachment(a: Attachment) { attachments = attachments.filter { it !== a } }

    // ------------------------------------------------------------------ payload

    private fun html() = ComposeLogic.assembleHtml(text.text, signatureHtml, quotedHtml)

    /** Everything that makes two states of the screen "the same message". */
    fun snapshot(): String = listOf(identity?.email, to.joinToString { it.email }, cc.joinToString { it.email }, bcc.joinToString { it.email },
        subject, text.text, toInput, ccInput, bccInput, attachments.joinToString { it.uploadId.ifEmpty { it.name } }).joinToString("\u0001")

    val dirty: Boolean get() = !loading && snapshot() != baseline
    /** Worth saving as a draft: something was written, chosen or attached. */
    val hasContent: Boolean get() = to.isNotEmpty() || cc.isNotEmpty() || bcc.isNotEmpty() || subject.isNotBlank() || text.text.isNotBlank() || attachments.isNotEmpty() ||
        toInput.isNotBlank()

    fun payload(): JsonObject? {
        val i = identity ?: return null
        val done = attachments.filter { it.state == UploadState.Done }
        return buildJsonObject {
            put("accountId", i.accountId); put("fromEmail", i.email)
            i.id?.let { put("identityId", it) }
            put("to", JsonArray(to.map(ComposeLogic::addressJson))); put("cc", JsonArray(cc.map(ComposeLogic::addressJson))); put("bcc", JsonArray(bcc.map(ComposeLogic::addressJson)))
            put("subject", subject.trim()); put("html", html())
            inReplyTo?.let { put("inReplyTo", it) }
            replyToEmailId?.let { put("replyToEmailId", it) }
            put("attachmentIds", JsonArray(done.map { JsonPrimitive(it.uploadId) }))
            put("attachments", JsonArray(done.map { a -> buildJsonObject { put("id", a.uploadId); put("filename", a.name); put("size", a.size) } }))
            put("track", false)
            draftId?.let { put("draftId", it) }
        }
    }

    // ------------------------------------------------------------------ send / schedule

    /** `null` = fine to go ahead, else the sentence to show. */
    fun problemBeforeSending(): String? {
        if (viewingMode) return "Viewing mode: this server is not sending mail."
        commit("to"); commit("cc"); commit("bcc")
        if (toInput.isNotBlank() || ccInput.isNotBlank() || bccInput.isNotBlank()) return "\"${(toInput + ccInput + bccInput).trim()}\" isn't an email address."
        if (to.isEmpty() && cc.isEmpty() && bcc.isEmpty()) return "Add at least one recipient."
        if (identity == null) return "Choose which address to send from."
        if (attachments.any { it.state == UploadState.Uploading }) return "Wait for the attachments to finish uploading."
        if (attachments.any { it.state == UploadState.Failed }) return "An attachment didn't upload. Retry it or remove it."
        return null
    }

    fun send(confirmedNoSubject: Boolean = false) {
        error = null
        problemBeforeSending()?.let { error = it; return }
        if (subject.isBlank() && !confirmedNoSubject) { confirmNoSubject = true; return }
        val p = payload() ?: return
        val at = scheduleAt
        sending = true
        scope.launch {
            if (at != null) {
                val r = withContext(Dispatchers.IO) { api.schedule(base, p, at) }
                sending = false
                when (r) {
                    is ApiResult.Ok -> { finish(); onScheduled(at) }
                    else -> fail(r)
                }
            } else {
                val r = withContext(Dispatchers.IO) { api.send(base, p) }
                sending = false
                when (r) {
                    is ApiResult.Ok -> { finish(); onSent(r.value, p, subject.trim()) }
                    else -> fail(r)
                }
            }
        }
    }

    private fun fail(r: ApiResult<*>) {
        error = when (r) {
            is ApiResult.Network -> "No connection. Your message is still here, so try again when you're back online."
            is ApiResult.Failed -> r.message
            ApiResult.Unauthorized -> { onSignedOut(); null }
            is ApiResult.Ok -> null
        }
    }

    // ------------------------------------------------------------------ drafts

    private fun scheduleAutosave() {
        autosaveJob?.cancel()
        autosaveJob = scope.launch {
            var last = baseline
            while (!closed) {
                delay(45_000)
                val now = snapshot()
                if (now != last && now != baseline && hasContent && !sending) { saveDraft(silent = true); last = snapshot() }
            }
        }
    }

    /** Saves the draft on the server. `done(true)` when saved (or nothing to save). */
    fun saveDraft(silent: Boolean = false, done: (Boolean) -> Unit = {}) {
        if (viewingMode || saving || identity == null || !hasContent) { done(!hasContent); return }
        if (!dirty && draftSaved) { done(true); return }
        commit("to"); commit("cc"); commit("bcc")
        val p = payload() ?: run { done(false); return }
        val snap = snapshot()
        saving = true
        scope.launch {
            val r = withContext(Dispatchers.IO) { api.saveDraft(base, p) }
            saving = false
            when (r) {
                is ApiResult.Ok -> {
                    baseline = snap; draftSaved = true
                    if (!silent) notice = "Draft saved."
                    adoptDraftId(p)
                    done(true)
                }
                is ApiResult.Unauthorized -> onSignedOut()
                else -> { if (!silent) error = if (r is ApiResult.Network) "No connection. The draft is kept here until you're online." else (r as? ApiResult.Failed)?.message; done(false) }
            }
        }
    }

    /** The server creates the new draft in the background; find it so the next save replaces it instead of adding another. */
    private fun adoptDraftId(p: JsonObject) {
        val acct = p["accountId"]?.jsonPrimitive?.intOrNull ?: return
        val subj = p["subject"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val old = draftId
        scope.launch {
            repeat(5) {
                delay(1500)
                val page = (withContext(Dispatchers.IO) { api.draftsOf(base, acct) } as? ApiResult.Ok)?.value ?: return@repeat
                val hit = page.emails.firstOrNull { it.subject.trim() == subj && it.id != old }
                if (hit != null) { draftId = hit.id; return@launch }
            }
        }
    }

    // ------------------------------------------------------------------ leaving

    /** Back / close button. Nothing written → close; else ask. */
    fun requestClose() {
        if (closed) return
        if (sending) return
        if (!hasContent || !dirty) { finish(); return }
        confirmDiscard = true
    }

    fun saveAndClose() {
        confirmDiscard = false
        if (viewingMode) { finish(); return }
        saveDraft { ok -> if (ok) finish() else confirmDiscard = false }
    }

    /** Throws the writing away. A draft that was already saved on the server goes to Trash. */
    fun discard() {
        confirmDiscard = false
        val d = draftId
        if (d != null && (draftSaved || request is ComposeRequest.Draft)) scope.launch { withContext(Dispatchers.IO) { api.bulk(base, listOf(d), "delete") } }
        finish()
    }

    /** Leaving the app with writing in progress keeps it as a draft. */
    fun onStop() { if (!closed && dirty && hasContent && !sending) saveDraft(silent = true) }

    private fun finish() { closed = true; autosaveJob?.cancel(); onClose() }
}
