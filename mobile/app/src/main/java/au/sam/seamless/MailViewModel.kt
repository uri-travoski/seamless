package au.sam.seamless

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import java.time.DayOfWeek
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.TemporalAdjusters

data class Snack(val message: String, val undoLabel: String? = null, val onUndo: (() -> Unit)? = null)

/** Everything the mailbox screen shows: the list, the scope/filter chips, search, selection and actions. */
class MailViewModel(
    private val api: Api,
    private val session: Session,
    private val scope: CoroutineScope,
    private val onSignedOut: () -> Unit = {},
) {
    private val base get() = session.serverUrl
    private var rev by mutableIntStateOf(0)
    private fun touch() { rev++ }

    var scopeId by mutableStateOf(session.scope); private set
    var folder by mutableStateOf("u:inbox"); private set
    var quick by mutableStateOf<Quick>(Quick.All); private set
    var overview by mutableStateOf<ApiCategoryOverview?>(null); private set
    var problemAccounts by mutableStateOf<Set<Int>>(emptySet()); private set
    var views by mutableStateOf<List<ApiSavedView>>(emptyList()); private set
    var labels by mutableStateOf<List<ApiLabel>>(emptyList()); private set
    var folders by mutableStateOf<List<ApiMailbox>>(emptyList()); private set
    var alert by mutableStateOf<ApiAlert?>(null); private set
    var viewingMode by mutableStateOf(false); private set
    var selection by mutableStateOf<Set<String>>(emptySet()); private set
    var pickerOpen by mutableStateOf(false)

    val snacks = MutableSharedFlow<Snack>(extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    val main = ListModel { pos -> withContext(Dispatchers.IO) { api.emailPage(base, MailQuery.filter(scopeId, folder, quick), pos) } }
        .also { it.onChange = ::touch }

    // ---- search ----
    var searchOpen by mutableStateOf(false); private set
    var searchText by mutableStateOf("")
    var searchOptionsOpen by mutableStateOf(false)
    var recent by mutableStateOf(session.recentSearches); private set
    private var submitted = ""
    val results = ListModel { pos -> withContext(Dispatchers.IO) { api.emailPage(base, MailQuery.filter(scopeId, folder, Quick.All, submitted), pos) } }
        .also { it.onChange = ::touch }
    var searched by mutableStateOf(false); private set

    // reading these re-reads whenever a list changed
    val mainItems: List<ApiEmail> get() { rev; return main.items }
    val resultItems: List<ApiEmail> get() { rev; return results.items }
    val mainStatus: ListStatus get() { rev; return main.status }
    val resultStatus: ListStatus get() { rev; return results.status }
    val refreshing: Boolean get() = mainStatus == ListStatus.Loading && main.loaded

    val scopeTitle: String get() = MailQuery.scopeTitle(scopeId, overview)
    val showMailboxDot: Boolean get() = MailQuery.showsMailboxDot(scopeId, overview)
    val folderTitle: String get() = folders.firstOrNull { it.id == folder }?.name ?: "Inbox"

    fun start() {
        scope.launch { main.reload(keep = false); checkSignedOut(main) }
        loadSide()
    }

    /** Overview, banners and the label/view lists – small calls, failures are quietly ignored (the list shows its own error). */
    fun loadSide() {
        scope.launch {
            val (ov, acc, al, mode, lab, vw, mb) = withContext(Dispatchers.IO) {
                Side(api.categories(base), api.accounts(base), api.alerts(base), api.mode(base), api.labels(base), api.views(base), api.mailboxes(base, MailQuery.UNIFIED))
            }
            (ov as? ApiResult.Ok)?.let { overview = it.value; if (!scopeStillExists()) chooseScope(MailQuery.UNIFIED) }
            (acc as? ApiResult.Ok)?.let { a -> problemAccounts = a.value.filter { it.hasProblem }.map { it.id }.toSet() }
            (al as? ApiResult.Ok)?.let { a -> alert = a.value.items.firstOrNull { it.state == "open" } }
            (mode as? ApiResult.Ok)?.let { viewingMode = it.value.mode == "viewing" }
            (lab as? ApiResult.Ok)?.let { labels = it.value }
            (vw as? ApiResult.Ok)?.let { views = it.value.filter { v -> v.pinned } }
            (mb as? ApiResult.Ok)?.let { f -> folders = f.value.filter { it.id.startsWith("u:") } }
        }
    }

    private data class Side(
        val ov: ApiResult<ApiCategoryOverview>, val acc: ApiResult<List<ApiAccountStatus>>, val al: ApiResult<AlertSummary>,
        val mode: ApiResult<ModeResponse>, val lab: ApiResult<List<ApiLabel>>, val vw: ApiResult<List<ApiSavedView>>, val mb: ApiResult<List<ApiMailbox>>,
    )

    /** A remembered scope can vanish (mailbox deleted on the server): fall back to All mailboxes. */
    private fun scopeStillExists(): Boolean {
        val ov = overview ?: return true
        MailQuery.accountOf(scopeId)?.let { id -> return ov.mailboxes.any { it.id == id } }
        MailQuery.categoryOf(scopeId)?.let { id -> return ov.categories.any { it.id == id } }
        return true
    }

    private fun checkSignedOut(l: ListModel) { if (l.signedOut) onSignedOut() }

    fun refresh() { scope.launch { main.reload(); checkSignedOut(main) }; loadSide() }
    fun retry() = refresh()
    fun loadMore() { scope.launch { main.loadMore() } }

    fun chooseScope(s: String) {
        scopeId = s; session.scope = s; clearSelection()
        scope.launch { main.reload(keep = false) }
        loadSide()
    }

    fun chooseFolder(id: String) {
        folder = id; quick = Quick.All; clearSelection()
        scope.launch { main.reload(keep = false) }
    }

    fun chooseQuick(q: Quick) {
        quick = if (quick == q && q != Quick.All) Quick.All else q
        clearSelection()
        scope.launch { main.reload(keep = false) }
    }

    // ---- search flow ----
    fun openSearch() { searchOpen = true; searchText = ""; searched = false; recent = session.recentSearches }
    fun closeSearch() { searchOpen = false; searched = false }
    fun runSearch(q: String = searchText) {
        val t = q.trim()
        if (t.isEmpty()) return
        searchText = t; submitted = t; searched = true
        session.addRecentSearch(t); recent = session.recentSearches
        scope.launch { results.reload(keep = false); checkSignedOut(results) }
    }
    fun markEditing() { searched = false }
    fun loadMoreResults() { scope.launch { results.loadMore() } }
    fun clearRecent() { session.recentSearches = emptyList(); recent = emptyList() }
    fun applyOptions(o: SearchOptions) { val q = o.toQuery(); if (q.isNotEmpty()) runSearch(q) }

    /** Reading a conversation arrives with T9.5; until then a tap says so. */
    fun open(@Suppress("UNUSED_PARAMETER") e: ApiEmail) { snacks.tryEmit(Snack("Reading mail arrives in the next update.")) }

    // ---- selection ----
    fun toggle(id: String) { selection = if (id in selection) selection - id else selection + id }
    fun startSelect(id: String) { selection = selection + id }
    fun clearSelection() { selection = emptySet() }
    fun selectAll(l: ListModel = if (searchOpen) results else main) { selection = l.items.map { it.id }.toSet() }

    // ---- actions ----
    private fun current() = if (searchOpen && searched) results else main

    fun act(action: String, ids: Set<String>, value: Long? = null, target: String? = null) {
        if (ids.isEmpty()) return
        val list = current()
        val removed = list.items.filter { it.id in ids }
        val removes = action in REMOVING && !(action == "archive" && folder == "u:archive")
        val inListHidden = removes
        if (inListHidden) list.remove(ids)
        else when (action) {
            "read" -> list.patch(ids) { it.copy(keywords = it.keywords + ("\$seen" to true)) }
            "unread" -> list.patch(ids) { it.copy(keywords = it.keywords - "\$seen") }
            "star" -> list.patch(ids) { it.copy(keywords = it.keywords + ("\$flagged" to true)) }
            "unstar" -> list.patch(ids) { it.copy(keywords = it.keywords - "\$flagged") }
        }
        clearSelection()
        scope.launch {
            val r = withContext(Dispatchers.IO) { api.bulk(base, ids.toList(), action, value?.let { JsonPrimitive(it) } ?: target?.let { JsonPrimitive(it) }) }
            when (r) {
                is ApiResult.Ok -> {
                    val token = r.value.undoToken?.takeIf { r.value.undoable }
                    val msg = confirmation(action, ids.size)
                    if (msg != null) snacks.tryEmit(Snack(msg, if (token != null) "Undo" else null) { undo(token!!) })
                    if (action in setOf("label", "unlabel", "move")) refresh()
                }
                is ApiResult.Failed -> { rollback(list, removed, inListHidden); snacks.tryEmit(Snack(r.message)) }
                is ApiResult.Network -> { rollback(list, removed, inListHidden); snacks.tryEmit(Snack(r.message)) }
                ApiResult.Unauthorized -> onSignedOut()
            }
        }
    }

    private fun rollback(list: ListModel, removed: List<ApiEmail>, wasRemoved: Boolean) {
        if (wasRemoved) list.restore(removed) else refresh()
    }

    private fun undo(token: String) {
        scope.launch {
            val r = withContext(Dispatchers.IO) { api.undo(base, token) }
            if (r is ApiResult.Ok) { refresh(); if (searched) results.reload() } else snacks.tryEmit(Snack("Couldn't undo that."))
        }
    }

    fun snoozeUntil(preset: SnoozePreset, now: ZonedDateTime = ZonedDateTime.now()): Long = preset.at(now).toInstant().toEpochMilli()

    companion object {
        val REMOVING = setOf("archive", "delete", "spam", "move", "snooze")
        fun confirmation(action: String, n: Int): String? {
            val things = if (n == 1) "Conversation" else "$n conversations"
            return when (action) {
                "archive" -> "$things archived"
                "delete" -> "$things moved to Trash"
                "spam" -> "$things reported as spam"
                "snooze" -> "$things snoozed"
                "move" -> "$things moved"
                "label" -> "Label applied"
                "unlabel" -> "Label removed"
                "read" -> "Marked as read"
                "unread" -> "Marked as unread"
                else -> null
            }
        }
    }
}

enum class SnoozePreset(val title: String) {
    LaterToday("Later today") { override fun at(n: ZonedDateTime) = n.plusHours(3).withMinute(0).withSecond(0).withNano(0) },
    Tomorrow("Tomorrow morning") { override fun at(n: ZonedDateTime) = n.plusDays(1).withHour(8).withMinute(0).withSecond(0).withNano(0) },
    NextWeek("Next Monday") { override fun at(n: ZonedDateTime) = n.with(TemporalAdjusters.next(DayOfWeek.MONDAY)).withHour(8).withMinute(0).withSecond(0).withNano(0) };
    abstract fun at(n: ZonedDateTime): ZonedDateTime
}
