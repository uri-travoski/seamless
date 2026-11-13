package au.sam.seamless

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Builds and posts the phone's notifications: channels, per-mailbox groups, actions and deep links. */
object Notifier {
    /** Red accent for critical alerts. */
    const val ALERT_COLOR = 0xFFD93025.toInt()

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(Push.CH_MAIL, ctx.getString(R.string.channel_mail), NotificationManager.IMPORTANCE_DEFAULT)
            .apply { description = ctx.getString(R.string.channel_mail_desc) })
        nm.createNotificationChannel(NotificationChannel(Push.CH_ALERTS, ctx.getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH).apply {
            description = ctx.getString(R.string.channel_alerts_desc)
            enableVibration(true); vibrationPattern = longArrayOf(0, 300, 200, 300)
            enableLights(true); lightColor = ALERT_COLOR
            setBypassDnd(false)
        })
        nm.createNotificationChannel(NotificationChannel(Push.CH_SYNC, ctx.getString(R.string.channel_sync), NotificationManager.IMPORTANCE_MIN)
            .apply { description = ctx.getString(R.string.channel_sync_desc) })
    }

    fun allowed(ctx: Context): Boolean =
        NotificationManagerCompat.from(ctx).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    /** Entry point for a pushed data message (also used by the fallback sync and the debug "Simulate push"). */
    fun handle(ctx: Context, p: PushPayload) {
        val app = ctx.applicationContext as? SeamlessApp ?: return
        val session = app.session
        if (!session.hasSession) return                         // signed out: show nothing
        when (p.type) {
            "read" -> p.messageId?.let { cancelMail(ctx, it) }
            "mail" -> if (session.notifyMail) show(ctx, p, session)
            "alert" -> if (session.notifyAlerts) show(ctx, p, session)
            "test" -> show(ctx, p, session)
        }
    }

    fun handle(ctx: Context, data: Map<String, String>) { Push.parse(data)?.let { handle(ctx, it) } }

    private fun show(ctx: Context, p: PushPayload, session: Session) {
        if (!allowed(ctx)) return
        ensureChannels(ctx)
        val spec = Push.spec(p, session.hideContent, p.accountId?.let { session.accountNames[it] }) ?: return
        val n = build(ctx, spec)
        val nm = NotificationManagerCompat.from(ctx)
        @Suppress("MissingPermission") nm.notify(spec.tag, spec.id, n)
        if (spec.group != null && p.accountId != null) postSummary(ctx, p.accountId, spec.group, spec.subText)
    }

    fun build(ctx: Context, s: Push.Spec): Notification {
        val alert = s.channel == Push.CH_ALERTS
        val b = NotificationCompat.Builder(ctx, s.channel)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setContentTitle(s.title).setContentText(s.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(s.bigText))
            .setAutoCancel(true)                                // dismissing marks nothing: it only hides the notification
            .setOnlyAlertOnce(true)
            .setContentIntent(open(ctx, s))
        s.subText?.let { b.setSubText(it) }
        s.group?.let { b.setGroup(it) }
        if (alert) {
            b.setCategory(NotificationCompat.CATEGORY_ERROR).setColor(ALERT_COLOR).setColorized(false)
                .setPriority(NotificationCompat.PRIORITY_HIGH).setVibrate(longArrayOf(0, 300, 200, 300)).setLights(ALERT_COLOR, 600, 600)
        } else {
            b.setCategory(NotificationCompat.CATEGORY_EMAIL)
        }
        val mid = s.openMessageId
        if (s.canAct && mid != null) {
            b.addAction(0, "Mark as read", action(ctx, NotificationActionReceiver.READ, mid))
            b.addAction(0, "Archive", action(ctx, NotificationActionReceiver.ARCHIVE, mid))
            b.addAction(0, "Delete", action(ctx, NotificationActionReceiver.DELETE, mid))
            b.addAction(0, "Reply", openIntent(ctx, mid.toInt() xor 0x5000000, Intent(ctx, MainActivity::class.java).putExtra(Push.EXTRA_REPLY_MESSAGE, mid)))
        }
        return b.build()
    }

    private fun open(ctx: Context, s: Push.Spec): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java)
        s.openMessageId?.let { i.putExtra(Push.EXTRA_OPEN_MESSAGE, it) }
        s.openAlertId?.let { i.putExtra(Push.EXTRA_OPEN_ALERT, it) }
        return openIntent(ctx, s.id, i)
    }

    private fun openIntent(ctx: Context, code: Int, i: Intent): PendingIntent {
        i.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun action(ctx: Context, what: String, messageId: Long): PendingIntent {
        val i = Intent(ctx, NotificationActionReceiver::class.java).setAction(what).putExtra(NotificationActionReceiver.EXTRA_ID, messageId)
        return PendingIntent.getBroadcast(ctx, (messageId.toInt() * 4) + what.hashCode().and(3), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** One collapsed summary per mailbox, showing how many are waiting. */
    private fun postSummary(ctx: Context, accountId: Int, group: String, name: String?) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val n = nm.activeNotifications.count { it.notification.group == group && it.id != Push.summaryId(accountId) }
        if (n == 0) { NotificationManagerCompat.from(ctx).cancel(Push.TAG_GROUP, Push.summaryId(accountId)); return }
        val summary = NotificationCompat.Builder(ctx, Push.CH_MAIL)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setContentTitle(name ?: "Seamless").setContentText(Push.summaryText(n))
            .setStyle(NotificationCompat.InboxStyle().setSummaryText(Push.summaryText(n)))
            .setGroup(group).setGroupSummary(true).setAutoCancel(true).setOnlyAlertOnce(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setContentIntent(openIntent(ctx, Push.summaryId(accountId), Intent(ctx, MainActivity::class.java)))
            .build()
        @Suppress("MissingPermission") NotificationManagerCompat.from(ctx).notify(Push.TAG_GROUP, Push.summaryId(accountId), summary)
    }

    /** Remove one message's notification (read, archived or deleted here or on another device) and fix its group summary. */
    fun cancelMail(ctx: Context, messageId: Long) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val group = nm.activeNotifications.firstOrNull { it.tag == Push.TAG_MAIL && it.id == Push.noteId(messageId) }?.notification?.group
        NotificationManagerCompat.from(ctx).cancel(Push.TAG_MAIL, Push.noteId(messageId))
        if (group != null) {
            val acct = group.removePrefix("mailbox-").toIntOrNull() ?: return
            postSummary(ctx, acct, group, (ctx.applicationContext as? SeamlessApp)?.session?.accountNames?.get(acct))
        }
    }

    fun cancelAll(ctx: Context) { NotificationManagerCompat.from(ctx).cancelAll() }
}
