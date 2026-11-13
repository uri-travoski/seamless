package au.sam.seamless

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** What one fallback check found. */
data class SyncOutcome(val newMail: Int, val newAlerts: Int, val error: String? = null, val signedOut: Boolean = false, val skipped: Boolean = false)

/** The fallback check: no foreground service, no wake locks; WorkManager runs it every 15 minutes on any network. */
object SyncRunner {
    /** [force] = the "Check now" button: run even when push is working. */
    fun run(api: Api, session: Session, post: (PushPayload) -> Unit, force: Boolean = false): SyncOutcome {
        if (!session.hasSession) return SyncOutcome(0, 0, skipped = true)
        if (session.pushActive && !force) return SyncOutcome(0, 0, skipped = true)
        val base = session.serverUrl
        var error: String? = null
        var mail = 0; var alerts = 0

        fun <T> fail(r: ApiResult<T>): Boolean = when (r) {
            is ApiResult.Ok -> false
            is ApiResult.Network -> { error = r.message; true }
            is ApiResult.Failed -> { error = r.message; true }
            ApiResult.Unauthorized -> true
        }

        if (session.notifyMail) {
            val muted = (api.notificationPrefs(base) as? ApiResult.Ok)?.value?.mutedAccountIds?.toSet().orEmpty()
            val page = api.emailPage(base, MailQuery.filter(MailQuery.UNIFIED, "u:inbox", Quick.Unread), 0, 30)
            if (page is ApiResult.Unauthorized) return SyncOutcome(0, 0, signedOut = true)
            if (!fail(page)) {
                val r = SyncPlan.newMail((page as ApiResult.Ok).value.emails, session.syncSeen, muted)
                session.syncSeen = r.seen
                r.fresh.forEach { post(SyncPlan.payload(it)) }
                mail = r.fresh.size
            }
        }
        if (session.notifyAlerts) {
            val al = api.alerts(base)
            if (al is ApiResult.Unauthorized) return SyncOutcome(mail, 0, signedOut = true)
            if (!fail(al)) {
                val open = (al as ApiResult.Ok).value.items
                val fresh = SyncPlan.newAlerts(open, session.syncAlerts)
                fresh.forEach { post(SyncPlan.payload(it)) }
                session.syncAlerts = open.filter { it.state == "open" }.map { it.id }.toSet()   // a fixed problem that comes back is announced again
                alerts = fresh.size
            }
        }
        if (error == null) session.lastSyncAt = System.currentTimeMillis()
        return SyncOutcome(mail, alerts, error)
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as? SeamlessApp ?: return Result.success()
        withContext(Dispatchers.IO) {
            SyncRunner.run(app.api, app.session, { Notifier.handle(applicationContext, it) })
        }
        return Result.success()   // a failed check is just tried again at the next period
    }
}

object SyncScheduler {
    private const val NAME = "seamless-sync"

    fun schedule(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun cancel(ctx: Context) { WorkManager.getInstance(ctx).cancelUniqueWork(NAME) }
}
