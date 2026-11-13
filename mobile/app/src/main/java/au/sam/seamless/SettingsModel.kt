package au.sam.seamless

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

val UNDO_CHOICES = listOf(0, 5, 10, 20, 30, 45, 60)

fun undoLabel(s: Int) = if (s == 0) "Off (send at once)" else "$s seconds"

/** State behind Settings: choices kept on this phone (via [Session]) and the few that live on the server. */
class SettingsModel(
    private val api: Api,
    private val session: Session,
    private val scope: CoroutineScope,
    private val onSignedOut: () -> Unit,
    private val onMessage: (String) -> Unit,
    private val onTheme: (String) -> Unit,
) {
    private val base get() = session.serverUrl

    var theme by mutableStateOf(session.theme); private set
    var swipeRight by mutableStateOf(SwipeAction.of(session.swipeRight, SwipeAction.Archive)); private set
    var swipeLeft by mutableStateOf(SwipeAction.of(session.swipeLeft, SwipeAction.Delete)); private set
    var conversationView by mutableStateOf(session.conversationView); private set
    var notifyMail by mutableStateOf(session.notifyMail); private set
    var notifyAlerts by mutableStateOf(session.notifyAlerts); private set
    var hideContent by mutableStateOf(session.hideContent); private set
    var defaultFrom by mutableStateOf(session.defaultFrom); private set

    var undoSeconds by mutableStateOf<Int?>(null); private set
    var muted by mutableStateOf<Set<Int>>(emptySet()); private set
    var identities by mutableStateOf<List<ApiIdentity>>(emptyList()); private set
    var serverVersion by mutableStateOf(""); private set
    var loadError by mutableStateOf<String?>(null); private set
    var loading by mutableStateOf(false); private set

    fun load() {
        loading = true; loadError = null
        scope.launch {
            val (s, n, i) = withContext(Dispatchers.IO) { Triple(api.serverSettings(base), api.notificationPrefs(base), api.identities(base)) }
            loading = false
            (withContext(Dispatchers.IO) { api.mobileConfig(base) } as? ApiResult.Ok)?.let { serverVersion = it.value.serverVersion }
            (s as? ApiResult.Ok)?.let { undoSeconds = it.value.undoSendSeconds }
            (n as? ApiResult.Ok)?.let { muted = it.value.mutedAccountIds.toSet() }
            (i as? ApiResult.Ok)?.let { identities = it.value.filter { id -> id.email.isNotBlank() } }
            if (s is ApiResult.Unauthorized || n is ApiResult.Unauthorized) { onSignedOut(); return@launch }
            loadError = listOf(s, n).firstNotNullOfOrNull { r ->
                when (r) { is ApiResult.Network -> r.message; is ApiResult.Failed -> r.message; else -> null }
            }
        }
    }

    fun chooseTheme(t: ThemeChoice) { theme = t.key; session.theme = t.key; onTheme(t.key) }
    fun chooseSwipeRight(a: SwipeAction) { swipeRight = a; session.swipeRight = a.key }
    fun chooseSwipeLeft(a: SwipeAction) { swipeLeft = a; session.swipeLeft = a.key }
    fun updateConversationView(v: Boolean) { conversationView = v; session.conversationView = v }
    fun updateNotifyMail(v: Boolean) { notifyMail = v; session.notifyMail = v }
    fun updateNotifyAlerts(v: Boolean) { notifyAlerts = v; session.notifyAlerts = v }
    fun updateHideContent(v: Boolean) { hideContent = v; session.hideContent = v }
    fun chooseDefaultFrom(email: String) { defaultFrom = email; session.defaultFrom = email }

    fun chooseUndo(seconds: Int) {
        val before = undoSeconds
        undoSeconds = seconds
        scope.launch {
            when (val r = withContext(Dispatchers.IO) { api.saveUndoSeconds(base, seconds) }) {
                is ApiResult.Ok -> {}
                is ApiResult.Failed -> { undoSeconds = before; onMessage(r.message) }
                is ApiResult.Network -> { undoSeconds = before; onMessage(r.message) }
                ApiResult.Unauthorized -> onSignedOut()
            }
        }
    }

    /** Mute or unmute new-mail notifications for one mailbox (kept on the server, so the web app agrees). */
    fun setMuted(accountId: Int, mute: Boolean) {
        val before = muted
        muted = if (mute) muted + accountId else muted - accountId
        scope.launch {
            when (val r = withContext(Dispatchers.IO) { api.saveMutedAccounts(base, muted.toList().sorted()) }) {
                is ApiResult.Ok -> {}
                is ApiResult.Failed -> { muted = before; onMessage(r.message) }
                is ApiResult.Network -> { muted = before; onMessage(r.message) }
                ApiResult.Unauthorized -> onSignedOut()
            }
        }
    }
}

/** Text of the "Open-source licences" dialog in About. */
const val LICENCES_TEXT = """This app is built from open-source software, used under their licences:

• Kotlin, kotlinx.coroutines, kotlinx.serialization — Apache License 2.0 (JetBrains)
• AndroidX, Jetpack Compose, Material 3, Security Crypto — Apache License 2.0 (Google)
• OkHttp — Apache License 2.0 (Square)
• Material icons — Apache License 2.0 (Google)

Seamless itself is licensed by its author; ask your administrator for the licence text of your server."""
