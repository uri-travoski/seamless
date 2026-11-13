package au.sam.seamless

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Screen { Splash, Login, Home }
enum class LoginStep { Address, Password, Code }

class AppViewModel(private val app: SeamlessApp) : ViewModel() {
    private val api get() = app.api
    private val session get() = app.session

    var screen by mutableStateOf(if (session.hasSession) Screen.Splash else Screen.Login); private set
    var step by mutableStateOf(LoginStep.Address); private set

    var address by mutableStateOf(session.serverUrl)
    var email by mutableStateOf(session.email)
    var password by mutableStateOf("")
    var code by mutableStateOf("")
    var useRecovery by mutableStateOf(false); private set

    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var serverLine by mutableStateOf<String?>(null); private set
    var userEmail by mutableStateOf(session.email); private set
    var splashError by mutableStateOf<String?>(null); private set
    var notice by mutableStateOf<String?>(null)
    var mail by mutableStateOf<MailViewModel?>(null); private set

    private var mfaToken = ""
    private var checkedUrl = ""

    init {
        api.onUnauthorized = { viewModelScope.launch { signedOut("You were signed out. Sign in again to continue.") } }
        if (screen == Screen.Splash) resume()
        else if (address.isNotEmpty()) step = LoginStep.Password
    }

    private fun <T> io(block: () -> T, then: (T) -> Unit) {
        busy = true
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) { block() }
            busy = false
            then(r)
        }
    }

    fun resume() {
        splashError = null; screen = Screen.Splash
        io({ api.me(session.serverUrl) }) { r ->
            when (r) {
                is ApiResult.Ok -> if (r.value.loggedIn) { userEmail = r.value.user?.email ?: session.email; enterHome() }
                                   else signedOut(null)
                is ApiResult.Unauthorized -> {} // onUnauthorized already moved us to Login
                is ApiResult.Network -> splashError = r.message
                is ApiResult.Failed -> splashError = r.message
            }
        }
    }

    fun check() {
        error = null
        when (val p = ServerUrl.parse(address, BuildConfig.DEBUG)) {
            is ServerUrl.Result.Bad -> error = p.message
            is ServerUrl.Result.Ok -> io({ api.serverInfo(p.url) }) { r ->
                when (r) {
                    is ApiResult.Ok -> {
                        checkedUrl = p.url; address = p.url
                        serverLine = "${r.value.server?.name ?: "Seamless"} ${r.value.server?.version.orEmpty()}".trim()
                        if (r.value.needsSetup) error = "This server hasn't been set up yet. Open it in a browser first."
                        else step = LoginStep.Password
                    }
                    is ApiResult.Network -> error = r.message
                    is ApiResult.Failed -> error = r.message
                    ApiResult.Unauthorized -> error = "The server refused the request."
                }
            }
        }
    }

    fun changeServer() { step = LoginStep.Address; error = null; serverLine = null; password = ""; code = "" }

    fun signIn() {
        error = null
        if (email.isBlank() || password.isEmpty()) { error = "Enter your email and password."; return }
        val url = checkedUrl.ifEmpty { (ServerUrl.parse(address, BuildConfig.DEBUG) as? ServerUrl.Result.Ok)?.url ?: run { error = "Check the server address first."; return } }
        io({ api.login(url, email, password) }) { r ->
            when (r) {
                is ApiResult.Ok -> if (r.value.mfaRequired) { mfaToken = r.value.mfaToken; code = ""; step = LoginStep.Code }
                                   else finishLogin(url)
                is ApiResult.Failed -> error = if (r.status == 401) "Wrong email or password." else r.message
                is ApiResult.Network -> error = r.message
                ApiResult.Unauthorized -> error = "Wrong email or password."
            }
        }
    }

    fun submitCode() {
        error = null
        if (code.isBlank()) { error = if (useRecovery) "Enter a recovery code." else "Enter the 6-digit code."; return }
        io({ api.loginMfa(checkedUrl, mfaToken, code) }) { r ->
            when (r) {
                is ApiResult.Ok -> finishLogin(checkedUrl)
                is ApiResult.Failed -> {
                    if (r.status == 401 && r.message.contains("expired", true)) { step = LoginStep.Password; password = "" }
                    error = if (r.status == 401 && !r.message.contains("expired", true)) (if (useRecovery) "That recovery code didn't work." else "That code didn't work. Check the code and try again.") else r.message
                }
                is ApiResult.Network -> error = r.message
                ApiResult.Unauthorized -> error = "That code didn't work."
            }
        }
    }

    fun toggleRecovery() { useRecovery = !useRecovery; code = ""; error = null }

    private fun finishLogin(url: String) {
        session.serverUrl = url; session.email = email.trim()
        if (!email.trim().equals(session.lastUser, true)) session.scope = MailQuery.UNIFIED
        session.lastUser = email.trim()
        userEmail = email.trim(); password = ""; code = ""; useRecovery = false
        enterHome()
    }

    private fun enterHome() {
        mail = MailViewModel(api, session, viewModelScope).also { it.start() }
        screen = Screen.Home
    }

    fun logout() {
        val url = session.serverUrl
        viewModelScope.launch {
            withContext(Dispatchers.IO) { api.logout(url) } // best effort: also drops the cookie locally below
            signedOut(null)
        }
    }

    private fun signedOut(message: String?) {
        session.clear(); mail = null
        password = ""; code = ""; mfaToken = ""
        checkedUrl = session.serverUrl; address = session.serverUrl
        step = if (address.isNotEmpty()) LoginStep.Password else LoginStep.Address
        error = message
        screen = Screen.Login
    }
}
