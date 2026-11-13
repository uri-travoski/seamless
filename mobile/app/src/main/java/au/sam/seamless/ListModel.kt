package au.sam.seamless

/** Loading state of one list; every failure is a sentence with a Retry on screen. */
sealed interface ListStatus {
    data object Idle : ListStatus
    data object Loading : ListStatus
    data class Error(val message: String) : ListStatus
}

/**
 * A paged list of emails (the inbox, or search results). Pure Kotlin so the paging rules are unit tested:
 * pages of 50, the next page is asked for only once, a reload throws away answers that arrive late.
 */
class ListModel(private val loader: suspend (position: Int) -> ApiResult<EmailPage>) {
    var items: List<ApiEmail> = emptyList(); private set
    var total: Int = 0; private set
    var status: ListStatus = ListStatus.Idle; private set
    var loaded = false; private set
    var onChange: () -> Unit = {}
    private var generation = 0
    var signedOut = false; private set

    val endReached: Boolean get() = loaded && items.size >= total

    /** Throw the rows away and start again (new scope/filter, pull to refresh). `keep` leaves the old rows on screen while loading. */
    suspend fun reload(keep: Boolean = true) {
        val gen = ++generation
        if (!keep) { items = emptyList(); total = 0; loaded = false }
        set(ListStatus.Loading)
        val r = loader(0)
        if (gen != generation) return
        apply(r) { page -> items = page.emails; total = page.total; loaded = true }
    }

    suspend fun loadMore() {
        if (status == ListStatus.Loading || !loaded || endReached) return
        val gen = generation
        set(ListStatus.Loading)
        val r = loader(items.size)
        if (gen != generation) return
        apply(r) { page ->
            val seen = items.mapTo(HashSet()) { it.id }
            items = items + page.emails.filter { it.id !in seen }
            total = page.total
            if (page.emails.isEmpty()) total = items.size // the server ran out early: stop paging
        }
    }

    private inline fun apply(r: ApiResult<EmailPage>, ok: (EmailPage) -> Unit) {
        when (r) {
            is ApiResult.Ok -> { ok(r.value); status = ListStatus.Idle }
            is ApiResult.Failed -> status = ListStatus.Error(r.message)
            is ApiResult.Network -> status = ListStatus.Error(r.message)
            ApiResult.Unauthorized -> { signedOut = true; status = ListStatus.Idle }
        }
        onChange()
    }

    private fun set(s: ListStatus) { status = s; onChange() }

    /** Optimistic local edits for swipe / bulk actions. */
    fun remove(ids: Set<String>) {
        val before = items.size
        items = items.filter { it.id !in ids }
        total = (total - (before - items.size)).coerceAtLeast(items.size)
        onChange()
    }

    fun patch(ids: Set<String>, f: (ApiEmail) -> ApiEmail) { items = items.map { if (it.id in ids) f(it) else it }; onChange() }

    fun restore(removed: List<ApiEmail>) {
        val ids = items.mapTo(HashSet()) { it.id }
        items = (items + removed.filter { it.id !in ids }).sortedByDescending { it.receivedAt }
        total += removed.size
        onChange()
    }
}
