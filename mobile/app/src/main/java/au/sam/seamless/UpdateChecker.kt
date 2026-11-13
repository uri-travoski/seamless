package au.sam.seamless

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.util.concurrent.TimeUnit

sealed interface UpdateResult {
    data class UpToDate(val current: String) : UpdateResult
    data class Available(val version: String, val url: String) : UpdateResult
    data class Failed(val message: String) : UpdateResult
}

/**
 * "Check for updates" for sideloaded builds: looks at the public GitHub releases of the project and finds the newest
 * release tagged `android-vX.Y.Z` that carries an .apk. It only reports and links the download — nothing is installed
 * by the app itself. Play Store builds are built with `-PplayStore` and don't show this (Play updates them).
 */
object UpdateChecker {
    const val RELEASES_URL = "https://api.github.com/repos/uri-travoski/seamless/releases?per_page=30"
    private val client = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()

    fun check(current: String, fetch: () -> String = ::download): UpdateResult = try {
        pick(fetch(), current)
    } catch (e: Exception) {
        UpdateResult.Failed("Could not reach GitHub: ${e.message ?: "no connection"}")
    }

    private fun download(): String {
        val req = Request.Builder().url(RELEASES_URL).header("Accept", "application/vnd.github+json").header("User-Agent", "Seamless-Android").build()
        client.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IllegalStateException("GitHub answered ${r.code}")
            return r.body?.string().orEmpty()
        }
    }

    /** Newest android-v* release with an .apk, compared with [current]. Pure, so it is unit-tested. */
    fun pick(json: String, current: String): UpdateResult {
        val arr = JSONArray(json)
        var bestV: String? = null
        var bestUrl: String? = null
        for (i in 0 until arr.length()) {
            val rel = arr.getJSONObject(i)
            if (rel.optBoolean("draft") || rel.optBoolean("prerelease")) continue
            val tag = rel.optString("tag_name")
            if (!tag.startsWith("android-v")) continue
            val v = tag.removePrefix("android-v")
            val assets = rel.optJSONArray("assets") ?: continue
            var apk: String? = null
            for (j in 0 until assets.length()) {
                val a = assets.getJSONObject(j)
                if (a.optString("name").endsWith(".apk")) { apk = a.optString("browser_download_url"); break }
            }
            if (apk == null) continue
            if (bestV == null || compare(v, bestV) > 0) { bestV = v; bestUrl = apk }
        }
        if (bestV == null || bestUrl == null) return UpdateResult.UpToDate(current)
        return if (compare(bestV, current) > 0) UpdateResult.Available(bestV, bestUrl) else UpdateResult.UpToDate(current)
    }

    /** Numeric dotted-version comparison: 1.10.0 > 1.9.2. */
    fun compare(a: String, b: String): Int {
        val x = a.split('.').map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (d != 0) return d
        }
        return 0
    }
}
