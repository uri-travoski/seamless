package au.sam.seamless

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

object Biometrics {
    fun available(ctx: Context) =
        BiometricManager.from(ctx).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
}

/** Six dots and a number pad. Used to unlock the app and (with [onDone]) to enter a new PIN in Settings. */
@Composable
fun PinPad(title: String, message: String?, pin: String, onChange: (String) -> Unit, onComplete: (String) -> Unit, extra: @Composable () -> Unit = {}) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.semantics { contentDescription = "${pin.length} of 6 digits entered" }) {
            repeat(6) { i ->
                Box(Modifier.size(16.dp).clip(CircleShape)
                    .background(if (i < pin.length) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant))
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(message ?: " ", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, modifier = Modifier.heightIn(min = 40.dp))
        val press = { d: Char ->
            if (pin.length < 6) { val n = pin + d; onChange(n); if (n.length == 6) onComplete(n) }
        }
        listOf("123", "456", "789").forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) { row.forEach { Key(it.toString()) { press(it) } } ; }
            Spacer(Modifier.height(12.dp))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(72.dp), contentAlignment = Alignment.Center) { extra() }
            Key("0") { press('0') }
            Box(Modifier.size(72.dp).clip(CircleShape).clickable(enabled = pin.isNotEmpty()) { onChange(pin.dropLast(1)) }
                .semantics { contentDescription = "Delete" }, contentAlignment = Alignment.Center) {
                if (pin.isNotEmpty()) Icon(Icons.AutoMirrored.Filled.Backspace, null)
            }
        }
    }
}

@Composable
private fun Key(label: String, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = CircleShape, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.size(72.dp)) {
        Box(contentAlignment = Alignment.Center) { Text(label, style = MaterialTheme.typography.headlineSmall) }
    }
}

@Composable
fun LockScreen(vm: AppViewModel, onBiometric: () -> Unit) {
    val ctx = LocalContext.current
    val lock = vm.session.lock
    var pin by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var wait by remember { mutableIntStateOf(lock.secondsLeft()) }
    var forgot by remember { mutableStateOf(false) }
    val bio = lock.biometric && Biometrics.available(ctx)

    LaunchedEffect(Unit) { if (bio && wait == 0) onBiometric() }
    LaunchedEffect(wait) {
        if (wait > 0) { delay(1000); wait = lock.secondsLeft(); if (wait == 0) message = null }
    }

    Column(Modifier.fillMaxSize().systemBarsPadding().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        PinPad(
            title = "Enter your PIN",
            message = if (wait > 0) "Too many wrong tries. Wait $wait s." else message,
            pin = pin, onChange = { if (wait == 0) pin = it },
            onComplete = { p ->
                when (val r = lock.verify(p)) {
                    PinResult.Ok -> vm.unlock()
                    is PinResult.Wrong -> { message = "Wrong PIN. ${r.triesBeforeDelay} ${if (r.triesBeforeDelay == 1) "try" else "tries"} left before a wait."; pin = "" }
                    is PinResult.Locked -> { wait = r.seconds; pin = "" }
                }
            },
            extra = {
                if (bio) IconButton(onClick = onBiometric, Modifier.size(72.dp)) { Icon(Icons.Filled.Fingerprint, "Use fingerprint", Modifier.size(36.dp)) }
            },
        )
        Spacer(Modifier.height(24.dp))
        TextButton(onClick = { forgot = true }) { Text("Forgot PIN?") }
    }
    if (forgot) AlertDialog(
        onDismissRequest = { forgot = false },
        title = { Text("Forgot your PIN?") },
        text = { Text("Sign out and sign in again with your Seamless password. The PIN lock is turned off; you can set a new one in Settings.") },
        confirmButton = { TextButton(onClick = { forgot = false; vm.logout() }) { Text("Sign out") } },
        dismissButton = { TextButton(onClick = { forgot = false }) { Text("Cancel") } },
    )
}
