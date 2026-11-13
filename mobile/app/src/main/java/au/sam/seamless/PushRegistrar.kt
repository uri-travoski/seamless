package au.sam.seamless

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Tells the server about this phone's FCM token. Without a google-services.json the Firebase app does not exist:
 * everything here then does nothing and the WorkManager sync takes over.
 */
object PushRegistrar {
    fun configured(ctx: Context): Boolean = try { FirebaseApp.getApps(ctx).isNotEmpty() } catch (_: Throwable) { false }

    /** Fetch the token (if Firebase is built in) and register it. Safe to call often. */
    fun register(ctx: Context) {
        val app = ctx.applicationContext as? SeamlessApp ?: return
        if (!app.session.hasSession) return
        if (!configured(ctx)) { app.session.pushActive = false; return }
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
                val token = t.result
                if (t.isSuccessful && !token.isNullOrEmpty()) send(app, token) else app.session.pushActive = false
            }
        } catch (_: Throwable) { app.session.pushActive = false }
    }

    fun onNewToken(ctx: Context, token: String) {
        val app = ctx.applicationContext as? SeamlessApp ?: return
        app.session.fcmToken = token
        if (app.session.hasSession) send(app, token)
    }

    private fun send(app: SeamlessApp, token: String) {
        val s = app.session
        Thread {
            val r = app.api.registerDevice(s.serverUrl, token, s.notifyMail, s.notifyAlerts, s.hideContent)
            if (r is ApiResult.Ok) { s.fcmToken = token; s.pushActive = r.value }   // false = the admin has not added the Firebase key yet
            else if (r !is ApiResult.Unauthorized) s.pushActive = false
        }.start()
    }

    /** Logout: drop the registration on the server and the token on the phone. Call before the cookie is cleared. */
    fun unregister(app: SeamlessApp, url: String) {
        val token = app.session.fcmToken
        app.api.unregisterDevice(url, token)
        app.session.fcmToken = ""; app.session.pushActive = false
        if (configured(app)) try { FirebaseMessaging.getInstance().deleteToken() } catch (_: Throwable) {}
    }
}
