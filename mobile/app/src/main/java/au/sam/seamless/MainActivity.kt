package au.sam.seamless

import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider

class MainActivity : FragmentActivity() {
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
            val density = androidx.compose.ui.platform.LocalDensity.current
            val scaled = androidx.compose.ui.unit.Density(density.density, density.fontScale * (TEXT_BASE_PX + vm.textDelta) / TEXT_BASE_PX)
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides scaled) {
                SeamlessTheme(dark) { AppRoot(vm, onBiometric = ::askFingerprint) }
            }
        }
    }

    override fun onStop() { super.onStop(); vm.onBackgrounded() }
    override fun onStart() { super.onStart(); vm.onForegrounded() }

    /** Fingerprint / face prompt that opens the lock screen. The PIN always stays available as the fallback. */
    private fun askFingerprint() {
        if (!vm.session.lock.biometric || !Biometrics.available(this)) return
        val prompt = androidx.biometric.BiometricPrompt(this, androidx.core.content.ContextCompat.getMainExecutor(this),
            object : androidx.biometric.BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: androidx.biometric.BiometricPrompt.AuthenticationResult) { vm.session.lock.biometricOk(); vm.unlock() }
            })
        prompt.authenticate(androidx.biometric.BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Seamless").setNegativeButtonText("Use PIN")
            .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG).build())
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
