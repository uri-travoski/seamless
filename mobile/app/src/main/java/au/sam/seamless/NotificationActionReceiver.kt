package au.sam.seamless

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast

/** Mark as read / Archive / Delete from a notification, without opening the app. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getLongExtra(EXTRA_ID, 0L)
        val action = when (intent.action) { READ -> "read"; ARCHIVE -> "archive"; DELETE -> "delete"; else -> null }
        val app = ctx.applicationContext as? SeamlessApp
        if (id <= 0 || action == null || app == null || !app.session.hasSession) return
        val pending = goAsync()
        Thread {
            try {
                when (val r = app.api.bulk(app.session.serverUrl, listOf(Push.emailId(id)), action)) {
                    is ApiResult.Ok -> Notifier.cancelMail(ctx, id)
                    is ApiResult.Failed -> toast(ctx, "Couldn't do that: ${r.message}")
                    is ApiResult.Network -> toast(ctx, r.message)
                    ApiResult.Unauthorized -> toast(ctx, "You were signed out. Open Seamless to sign in again.")
                }
            } finally { pending.finish() }
        }.start()
    }

    private fun toast(ctx: Context, text: String) {
        android.os.Handler(android.os.Looper.getMainLooper()).post { Toast.makeText(ctx, text, Toast.LENGTH_LONG).show() }
    }

    companion object {
        const val READ = "au.sam.seamless.action.READ"
        const val ARCHIVE = "au.sam.seamless.action.ARCHIVE"
        const val DELETE = "au.sam.seamless.action.DELETE"
        const val EXTRA_ID = "id"
    }
}
