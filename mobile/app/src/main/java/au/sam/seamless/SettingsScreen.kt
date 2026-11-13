package au.sam.seamless

import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: AppViewModel, mail: MailViewModel, onBack: () -> Unit) {
    val st = vm.settings ?: return
    BackHandler(onBack = onBack)
    LaunchedEffect(st) { st.load() }
    val ctx = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }
    var dialog by remember { mutableStateOf<String?>(null) }
    var confirmSignOut by remember { mutableStateOf(false) }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Settings") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }) },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState())) {
            st.loadError?.let {
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = st::load) { Text("Retry") }
                }
            }

            Header("Notifications")
            SwitchRow("New mail", "Notify me about new messages", st.notifyMail, st::updateNotifyMail)
            SwitchRow("Critical alerts", "Tell me when a mailbox stops working", st.notifyAlerts, st::updateNotifyAlerts)
            SwitchRow("Hide message content", "Show only \"New mail\" – no sender or subject", st.hideContent, st::updateHideContent)
            val accounts = mail.overview?.mailboxes.orEmpty()
            if (accounts.isNotEmpty()) {
                Text("Mute a mailbox", Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                accounts.forEach { a ->
                    SwitchRow(a.name.ifBlank { a.email }, if (a.id in st.muted) "Muted – no new-mail notifications" else "Notifications on", a.id !in st.muted) { on -> st.setMuted(a.id, !on) }
                }
            }
            ClickRow("Notification channels", "Sound, vibration and lock-screen options in Android settings") {
                ctx.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }

            Header("Mail")
            ClickRow("Swipe right", st.swipeRight.title) { dialog = "swipeRight" }
            ClickRow("Swipe left", st.swipeLeft.title) { dialog = "swipeLeft" }
            SwitchRow("Conversation view", "Group messages of one conversation together", st.conversationView, st::updateConversationView)
            ClickRow("Default \"From\"", st.defaultFrom.ifBlank { "The mailbox I am looking at" }) { dialog = "from" }
            ClickRow("Undo send delay", st.undoSeconds?.let { undoLabel(it) } ?: "Loading…") { if (st.undoSeconds != null) dialog = "undo" }
            ClickRow("Signature", "Edited in the web app (Settings → Mailboxes). Added to new messages automatically.", enabled = false) {}

            Header("Appearance")
            ClickRow("Theme", ThemeChoice.of(st.theme).title) { dialog = "theme" }

            Header("About")
            InfoRow("App version", BuildConfig.VERSION_NAME)
            InfoRow("Server", vm.session.serverUrl)
            if (st.serverVersion.isNotEmpty()) InfoRow("Server version", st.serverVersion)
            ClickRow("Open-source licences", null) { dialog = "licences" }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { confirmSignOut = true }, Modifier.padding(horizontal = 16.dp).fillMaxWidth()) { Text("Sign out") }
            Spacer(Modifier.height(32.dp).navigationBarsPadding())
        }
    }

    when (dialog) {
        "swipeRight" -> ChoiceDialog("Swipe right", SwipeAction.entries, st.swipeRight, { it.title }, { st.chooseSwipeRight(it) }) { dialog = null }
        "swipeLeft" -> ChoiceDialog("Swipe left", SwipeAction.entries, st.swipeLeft, { it.title }, { st.chooseSwipeLeft(it) }) { dialog = null }
        "theme" -> ChoiceDialog("Theme", ThemeChoice.entries, ThemeChoice.of(st.theme), { it.title }, { st.chooseTheme(it) }) { dialog = null }
        "undo" -> ChoiceDialog("Undo send delay", UNDO_CHOICES, st.undoSeconds ?: 10, { undoLabel(it) }, { st.chooseUndo(it) }) { dialog = null }
        "from" -> {
            val opts = listOf("") + st.identities.map { it.email }.distinct()
            ChoiceDialog("Default \"From\"", opts, st.defaultFrom, { it.ifBlank { "The mailbox I am looking at" } }, { st.chooseDefaultFrom(it) }) { dialog = null }
        }
        "licences" -> AlertDialog(
            onDismissRequest = { dialog = null }, confirmButton = { TextButton(onClick = { dialog = null }) { Text("Close") } },
            title = { Text("Open-source licences") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) { Text(LICENCES_TEXT) } },
        )
    }
    if (confirmSignOut) AlertDialog(
        onDismissRequest = { confirmSignOut = false },
        title = { Text("Sign out?") }, text = { Text("This phone will be signed out of ${vm.session.serverUrl}.") },
        confirmButton = { TextButton(onClick = { confirmSignOut = false; vm.logout() }) { Text("Sign out") } },
        dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
    )
}

@Composable
private fun Header(title: String) {
    Text(title, Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun SwitchRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(checked, role = Role.Switch, onValueChange = onChange).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked, null)
    }
}

@Composable
private fun ClickRow(title: String, subtitle: String?, enabled: Boolean = true, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(title, color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun InfoRow(title: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value)
    }
}

@Composable
private fun <T> ChoiceDialog(title: String, options: List<T>, current: T, label: (T) -> String, onPick: (T) -> Unit, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                options.forEach { o ->
                    Row(
                        Modifier.fillMaxWidth().selectable(o == current, role = Role.RadioButton) { onPick(o); onClose() }.padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(o == current, null)
                        Spacer(Modifier.width(12.dp))
                        Text(label(o))
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } },
    )
}
