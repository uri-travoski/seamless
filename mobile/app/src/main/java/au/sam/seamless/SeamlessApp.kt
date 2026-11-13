package au.sam.seamless

import android.app.Application
import android.os.Build

class SeamlessApp : Application() {
    lateinit var session: Session
    lateinit var api: Api

    override fun onCreate() {
        super.onCreate()
        session = Session.create(this)
        val device = listOf(Build.MANUFACTURER, Build.MODEL).filter { !it.isNullOrBlank() }.joinToString(" ").take(60)
        api = Api(session.jar, BuildConfig.VERSION_NAME, device.ifBlank { "Android" }, allowEmulatorHost = BuildConfig.DEBUG)
    }
}
