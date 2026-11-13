package au.sam.seamless

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Receives the server's data-only messages (only ever started when a google-services.json was built in). */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        Notifier.handle(applicationContext, message.data)
    }

    override fun onNewToken(token: String) {
        PushRegistrar.onNewToken(applicationContext, token)
    }
}
