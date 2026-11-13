package au.sam.seamless

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = AppViewModel(application as SeamlessApp) as T
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) handle(intent)
        setContent {
            val dark = when (vm.theme) { "dark" -> true; "light" -> false; else -> androidx.compose.foundation.isSystemInDarkTheme() }
            SeamlessTheme(dark) { AppRoot(vm) }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    /** mailto: links and "Share → Seamless" open the compose screen. */
    private fun handle(intent: android.content.Intent?) {
        val target = OpenTarget.fromExtras(
            intent?.getLongExtra(Push.EXTRA_OPEN_MESSAGE, 0L), intent?.getLongExtra(Push.EXTRA_REPLY_MESSAGE, 0L), intent?.getIntExtra(Push.EXTRA_OPEN_ALERT, 0))
        if (target != null) {
            intent?.removeExtra(Push.EXTRA_OPEN_MESSAGE); intent?.removeExtra(Push.EXTRA_REPLY_MESSAGE); intent?.removeExtra(Push.EXTRA_OPEN_ALERT)
            vm.openTarget(target)
            return
        }
        val req = IntentCompose.parse(intent) ?: return
        vm.openCompose(req)
        intent?.action = null // handled: don't reopen after rotation
    }
}
