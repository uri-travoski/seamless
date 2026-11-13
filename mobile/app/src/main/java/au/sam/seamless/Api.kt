package au.sam.seamless

import kotlinx.serialization.json.*
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

const val PAGE_SIZE = 50

fun <T, R> ApiResult<T>.map(f: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Ok -> ApiResult.Ok(f(value))
    is ApiResult.Failed -> this
    is ApiResult.Network -> this
    ApiResult.Unauthorized -> ApiResult.Unauthorized
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

    // ---- mailbox (T9.3) ----

    private fun <T> getJson(baseUrl: String, path: String, parse: (String) -> T) = call(baseUrl, path, null, parse = parse)

    private fun jmapRaw(baseUrl: String, name: String, args: JsonObject): ApiResult<JsonObject> {
        val body = buildJsonObject {
            put("using", JsonArray(listOf(JsonPrimitive("urn:ietf:params:jmap:core"), JsonPrimitive("urn:ietf:params:jmap:mail"))))
            put("methodCalls", JsonArray(listOf(JsonArray(listOf(JsonPrimitive(name), args, JsonPrimitive("a"))))))
        }.toString()
        return call(baseUrl, "/jmap/api", body) { text ->
            val first = json.parseToJsonElement(text).jsonObject["methodResponses"]!!.jsonArray[0].jsonArray
            if (first[0].jsonPrimitive.content == "error") throw IOException("jmap error")
            first[1].jsonObject
        }
    }

    /** One page of mail for `filter` (the same filter object the web app sends), rows in the server's order. */
    fun emailPage(baseUrl: String, filter: JsonObject, position: Int, limit: Int = PAGE_SIZE): ApiResult<EmailPage> {
        val q = jmapRaw(baseUrl, "Email/query", buildJsonObject { put("filter", filter); put("position", position); put("limit", limit) })
        if (q !is ApiResult.Ok) return q.map { EmailPage(0, emptyList()) }
        val ids = q.value["ids"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
        val total = q.value["total"]?.jsonPrimitive?.intOrNull ?: ids.size
        if (ids.isEmpty()) return ApiResult.Ok(EmailPage(total, emptyList()))
        val g = jmapRaw(baseUrl, "Email/get", buildJsonObject { put("ids", JsonArray(ids.map { JsonPrimitive(it) })) })
        if (g !is ApiResult.Ok) return g.map { EmailPage(0, emptyList()) }
        val byId = g.value["list"]?.jsonArray?.map { json.decodeFromJsonElement<ApiEmail>(it) }.orEmpty().associateBy { it.id }
        return ApiResult.Ok(EmailPage(total, ids.mapNotNull { byId[it] }))
    }

    fun mailboxes(baseUrl: String, scope: String): ApiResult<List<ApiMailbox>> {
        val args = buildJsonObject { if (scope != "unified") put("scope", scope) }
        return jmapRaw(baseUrl, "Mailbox/get", args).map { v -> v["list"]?.jsonArray?.map { json.decodeFromJsonElement<ApiMailbox>(it) }.orEmpty() }
    }

    fun categories(baseUrl: String) = getJson(baseUrl, "/api/categories") { json.decodeFromString<ApiCategoryOverview>(it) }
    fun accounts(baseUrl: String) = getJson(baseUrl, "/api/accounts") { json.decodeFromString<List<ApiAccountStatus>>(it) }
    fun labels(baseUrl: String, scope: String = "unified") =
        getJson(baseUrl, "/api/labels" + if (scope != "unified") "?scope=$scope" else "") { json.decodeFromString<List<ApiLabel>>(it) }
    fun views(baseUrl: String) = getJson(baseUrl, "/api/views") { json.decodeFromString<List<ApiSavedView>>(it) }
    fun alerts(baseUrl: String) = getJson(baseUrl, "/api/alerts/summary") { json.decodeFromString<AlertSummary>(it) }
    fun suggestContacts(baseUrl: String, q: String) =
        getJson(baseUrl, "/api/contacts/suggest?q=" + java.net.URLEncoder.encode(q, "UTF-8")) { json.decodeFromString<List<ApiContactSuggestion>>(it) }
    fun mode(baseUrl: String) = getJson(baseUrl, "/api/mode") { json.decodeFromString<ModeResponse>(it) }

    fun bulk(baseUrl: String, ids: List<String>, action: String, value: kotlinx.serialization.json.JsonElement? = null): ApiResult<BulkResult> =
        call(baseUrl, "/api/bulk", json.encodeToString(BulkRequest(ids, action, value))) { json.decodeFromString<BulkResult>(it) }

    fun undo(baseUrl: String, token: String): ApiResult<Unit> =
        call(baseUrl, "/api/bulk/undo", json.encodeToString(UndoRequest(token))) { }

    // ---- drawer, labels, settings (T9.4) ----

    /** The signed-in user's synced settings (the web app's `settings_json`, which holds the sidebar layout). */
    fun userSettings(baseUrl: String) = getJson(baseUrl, "/api/me") {
        json.parseToJsonElement(it).jsonObject["settings"] as? JsonObject ?: JsonObject(emptyMap())
    }

    /** `PUT /api/settings` replaces the whole object, so callers send the merged object they just read. */
    fun saveUserSettings(baseUrl: String, settings: JsonObject): ApiResult<Unit> =
        call(baseUrl, "/api/settings", settings.toString(), method = "PUT") { }

    fun createLabel(baseUrl: String, name: String, color: String, parentId: Int?): ApiResult<Int> =
        call(baseUrl, "/api/labels", labelBody(name, color, parentId, true).toString()) { json.parseToJsonElement(it).jsonObject["id"]!!.jsonPrimitive.int }

    fun updateLabel(baseUrl: String, id: Int, name: String, color: String, parentId: Int?): ApiResult<Unit> =
        call(baseUrl, "/api/labels/$id", labelBody(name, color, parentId, true).toString(), method = "PUT") { }

    fun deleteLabel(baseUrl: String, id: Int): ApiResult<Unit> = call(baseUrl, "/api/labels/$id", null, method = "DELETE") { }

    private fun labelBody(name: String, color: String, parentId: Int?, withParent: Boolean) = buildJsonObject {
        put("name", name.trim()); put("color", color)
        if (withParent) put("parentId", parentId?.let { JsonPrimitive(it) } ?: JsonNull)
    }

    fun sharedLabelOffers(baseUrl: String) = getJson(baseUrl, "/api/labels/shared") { json.decodeFromString<List<ApiLabelOffer>>(it) }

    /** action = accept | reject | later */
    fun respondSharedLabels(baseUrl: String, accountId: Int, action: String): ApiResult<Unit> =
        call(baseUrl, "/api/labels/shared/$accountId/respond", buildJsonObject { put("action", action) }.toString()) { }

    fun serverSettings(baseUrl: String) = getJson(baseUrl, "/api/settings/server") { json.decodeFromString<ApiServerSettings>(it) }
    fun saveUndoSeconds(baseUrl: String, seconds: Int): ApiResult<Unit> =
        call(baseUrl, "/api/settings/server", buildJsonObject { put("undoSendSeconds", seconds) }.toString(), method = "PUT") { }

    fun notificationPrefs(baseUrl: String) = getJson(baseUrl, "/api/notification-prefs") { json.decodeFromString<ApiNotificationPrefs>(it) }
    /** Sends only the mute list; the server leaves the other notification settings alone. */
    fun saveMutedAccounts(baseUrl: String, ids: List<Int>): ApiResult<Unit> =
        call(baseUrl, "/api/notification-prefs", buildJsonObject { put("mutedAccountIds", JsonArray(ids.map { JsonPrimitive(it) })) }.toString(), method = "PUT") { }

    fun identities(baseUrl: String) = getJson(baseUrl, "/api/identities") { json.decodeFromString<List<ApiIdentity>>(it) }

    private fun <T> call(baseUrl: String, path: String, body: String?, isLogin: Boolean = false, method: String? = null, parse: (String) -> T): ApiResult<T> {
        val req = Request.Builder().url(baseUrl + path)
            .header("X-Seamless-Client", "android/$appVersion")
            .header("X-Seamless-Device", deviceName)
            .header("Accept", "application/json")
            .apply {
                when {
                    method == "DELETE" -> delete()
                    method != null -> method(method, (body ?: "{}").toRequestBody(jsonType))
                    body != null -> post(body.toRequestBody(jsonType))
                }
            }
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
