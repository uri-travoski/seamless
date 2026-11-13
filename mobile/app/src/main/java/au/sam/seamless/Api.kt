package au.sam.seamless

import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Outcome of a call, with every failure already turned into words for the screen. */
sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>
    /** The server answered with an error (`message` is the server's own sentence when it sent one). */
    data class Failed(val status: Int, val message: String) : ApiResult<Nothing>
    /** Not signed in (any call except the login calls) – the app must go back to the login screen. */
    data object Unauthorized : ApiResult<Nothing>
    /** No connection, timeout, TLS problem, or an answer that isn't Seamless. */
    data class Network(val message: String) : ApiResult<Nothing>
}

/** Refuses plain http to anything but a private address, even if a redirect tries to send us there. */
class PrivateHttpInterceptor(private val allowEmulatorHost: Boolean) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val u = chain.request().url
        if (u.scheme == "http" && !ServerUrl.isPrivateHost(u.host, allowEmulatorHost)) {
            throw IOException("Plain http is only allowed on your home network.")
        }
        return chain.proceed(chain.request())
    }
}

class Api(
    val jar: PersistentCookieJar,
    private val appVersion: String,
    private val deviceName: String,
    allowEmulatorHost: Boolean = false,
    /** Called once when a signed-in session is refused (revoked / expired). */
    var onUnauthorized: () -> Unit = {},
    base: OkHttpClient = OkHttpClient(),
) {
    val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val jsonType = "application/json".toMediaType()

    val client: OkHttpClient = base.newBuilder()
        .cookieJar(jar)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .addInterceptor(PrivateHttpInterceptor(allowEmulatorHost))
        .build()

    /** Plain GET /api/me on an address the user has not signed in to yet: shows the server name and version. */
    fun serverInfo(baseUrl: String): ApiResult<MeResponse> = call(baseUrl, "/api/me", null, isLogin = true) { json.decodeFromString<MeResponse>(it) }
        .let { r ->
            if (r is ApiResult.Ok && r.value.server == null) ApiResult.Failed(0, "That address answered, but it doesn't look like a Seamless server.") else r
        }

    fun me(baseUrl: String): ApiResult<MeResponse> = call(baseUrl, "/api/me", null) { json.decodeFromString<MeResponse>(it) }

    fun login(baseUrl: String, email: String, password: String): ApiResult<LoginResponse> =
        call(baseUrl, "/api/login", json.encodeToString(LoginRequest(email.trim(), password)), isLogin = true) { json.decodeFromString<LoginResponse>(it) }

    fun loginMfa(baseUrl: String, token: String, code: String): ApiResult<LoginResponse> =
        call(baseUrl, "/api/login/mfa", json.encodeToString(MfaRequest(token, code.trim())), isLogin = true) { json.decodeFromString<LoginResponse>(it) }

    fun logout(baseUrl: String): ApiResult<Unit> = call(baseUrl, "/api/logout", "{}", isLogin = true) { }

    fun mobileConfig(baseUrl: String): ApiResult<MobileConfig> = call(baseUrl, "/api/mobile/config", null) { json.decodeFromString<MobileConfig>(it) }

    private fun <T> call(baseUrl: String, path: String, body: String?, isLogin: Boolean = false, parse: (String) -> T): ApiResult<T> {
        val req = Request.Builder().url(baseUrl + path)
            .header("X-Seamless-Client", "android/$appVersion")
            .header("X-Seamless-Device", deviceName)
            .header("Accept", "application/json")
            .apply { if (body != null) post(body.toRequestBody(jsonType)) }
            .build()
        return try {
            client.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                when {
                    res.isSuccessful -> try { ApiResult.Ok(parse(text)) }
                        catch (_: Exception) { ApiResult.Network("That address answered, but it doesn't look like a Seamless server.") }
                    res.code == 401 && !isLogin -> { jar.clear(); onUnauthorized(); ApiResult.Unauthorized }
                    else -> ApiResult.Failed(res.code, errorMessage(res.code, text))
                }
            }
        } catch (e: IOException) {
            ApiResult.Network(describe(e))
        } catch (e: IllegalArgumentException) {
            ApiResult.Network("That doesn't look like a web address.")
        }
    }

    private fun errorMessage(code: Int, text: String): String {
        val fromServer = try { json.decodeFromString<ErrorBody>(text).error } catch (_: Exception) { "" }
        if (fromServer.isNotBlank()) return fromServer.replaceFirstChar { it.uppercase() }.let { if (it.endsWith(".")) it else "$it." }
        return when (code) {
            429 -> "Too many attempts. Wait a few minutes and try again."
            in 500..599 -> "The server had a problem. Try again in a moment."
            404 -> "That address answered, but it doesn't look like a Seamless server."
            else -> "Something went wrong (error $code)."
        }
    }

    private fun describe(e: IOException): String = when (e) {
        is java.net.UnknownHostException -> "Can't find that server. Check the address and your connection."
        is java.net.SocketTimeoutException -> "The server took too long to answer."
        is java.net.ConnectException -> "Can't reach the server. Is it running, and are you online?"
        is javax.net.ssl.SSLException -> "The server's security certificate isn't trusted."
        else -> e.message?.takeIf { it.startsWith("Plain http") } ?: "Can't reach the server. Check your connection."
    }
}
