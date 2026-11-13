package au.sam.seamless

import java.net.URI

/**
 * The one address the user types. Rules (plan T9):
 *  - https is accepted for any host;
 *  - plain http only for private addresses: 10/8, 172.16/12, 192.168/16, 127/8, localhost, *.local
 *    (plus 10.0.2.2, the emulator's alias for the host machine, in debug builds).
 */
object ServerUrl {
    sealed interface Result {
        data class Ok(val url: String) : Result
        data class Bad(val message: String) : Result
    }

    fun parse(input: String, allowEmulatorHost: Boolean = false): Result {
        var s = input.trim()
        if (s.isEmpty()) return Result.Bad("Type the address of your Seamless server.")
        if (!s.contains("://")) {
            val host = hostOf("http://$s")
            s = (if (host != null && isPrivateHost(host, allowEmulatorHost)) "http://" else "https://") + s
        }
        val uri = try { URI(s) } catch (_: Exception) { return Result.Bad("That doesn't look like a web address.") }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()
        if (host.isNullOrEmpty() || (scheme != "http" && scheme != "https")) return Result.Bad("That doesn't look like a web address.")
        if (scheme == "http" && !isPrivateHost(host, allowEmulatorHost)) {
            return Result.Bad("Plain http is only allowed on your home network. Use an https:// address for a server on the internet.")
        }
        if (uri.userInfo != null) return Result.Bad("Leave the username and password out of the address.")
        val port = if (uri.port > 0) ":${uri.port}" else ""
        val path = (uri.rawPath ?: "").trimEnd('/')
        val shownHost = if (host.contains(':')) "[$host]" else host
        return Result.Ok("$scheme://$shownHost$port$path")
    }

    private fun hostOf(s: String): String? = try { URI(s).host?.lowercase() } catch (_: Exception) { null }

    fun isPrivateHost(host: String, allowEmulatorHost: Boolean = false): Boolean {
        val h = host.lowercase().removePrefix("[").removeSuffix("]")
        if (h == "localhost" || h.endsWith(".local") || h.endsWith(".localhost")) return true
        if (h == "::1") return true
        if (allowEmulatorHost && h == "10.0.2.2") return true
        val m = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""").matchEntire(h) ?: return false
        val p = m.groupValues.drop(1).map { it.toInt() }
        if (p.any { it > 255 }) return false
        return p[0] == 10 || p[0] == 127 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168)
    }
}
