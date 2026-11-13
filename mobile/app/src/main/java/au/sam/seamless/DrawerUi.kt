package au.sam.seamless

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** The navigation drawer: folders in the web app's order, labels, smart views, then Settings / Help / Log out. */
@Composable
fun DrawerContent(
    vm: AppViewModel, mail: MailViewModel, close: () -> Unit,
    onSettings: () -> Unit, onLabels: () -> Unit, onHelp: () -> Unit,
) {
    ModalDrawerSheet {
        Column(Modifier.padding(horizontal = 28.dp, vertical = 20.dp).statusBarsPadding()) {
            Text("Seamless", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(4.dp))
            Text(vm.userEmail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        HorizontalDivider()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            val (main, more) = Sidebar.folders(mail.sidebar)
            val viewActive = mail.quick is Quick.View
            main.forEach { f -> FolderItem(f, mail, !viewActive && f.id == mail.folder, close) }
            var moreOpen by remember { mutableStateOf(false) }
            if (more.isNotEmpty()) {
                DrawerItem(if (moreOpen) "Less" else "More", if (moreOpen) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, false) { moreOpen = !moreOpen }
                if (moreOpen) more.forEach { f -> FolderItem(f, mail, !viewActive && f.id == mail.folder, close) }
            }

            SectionHeader("Labels")
            val rows = LabelTree.flatten(mail.labels)
            rows.forEach { r ->
                val l = r.label
                val selected = !viewActive && mail.folder == "q:" + LabelTree.query(l)
                NavigationDrawerItem(
                    label = { Text(l.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    icon = { Box(Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).background(parseColor(l.color, MaterialTheme.colorScheme.primary))) },
                    badge = { if (l.unread > 0) Text(Format.count(l.unread)) },
                    selected = selected,
                    onClick = { close(); mail.chooseLabel(l) },
                    modifier = Modifier.padding(start = (12 + r.depth * 16).dp, end = 12.dp)
                        .semantics { contentDescription = "Label ${l.name}" + if (l.unread > 0) ", ${l.unread} unread" else "" },
                )
            }
            if (rows.isEmpty()) Text("No labels yet", Modifier.padding(horizontal = 28.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            DrawerItem("Manage labels", Icons.Filled.Settings, false) { close(); onLabels() }

            if (mail.allViews.isNotEmpty()) {
                SectionHeader("Smart views")
                mail.allViews.forEach { v ->
                    val q = mail.quick
                    DrawerItem(v.name, Icons.Filled.AutoAwesome, q is Quick.View && q.id == v.id) { close(); mail.chooseView(v) }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            DrawerItem("Settings", Icons.Filled.Settings, false) { close(); onSettings() }
            DrawerItem("Help", Icons.Filled.HelpOutline, false) { close(); onHelp() }
        }
        NavigationDrawerItem(
            label = { Text("Log out") }, icon = { Icon(Icons.Filled.Logout, null) }, selected = false,
            onClick = { close(); vm.logout() },
            modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding).navigationBarsPadding(),
        )
    }
}

@Composable
private fun FolderItem(f: DrawerFolder, mail: MailViewModel, selected: Boolean, close: () -> Unit) {
    val n = Sidebar.badge(f, mail.folders)
    val icon = when (f.key) {
        "inbox" -> Icons.Filled.Inbox
        "starred" -> Icons.Filled.Star
        "drafts" -> Icons.Filled.Drafts
        "scheduled" -> Icons.Filled.Schedule
        "snoozed" -> Icons.Filled.Snooze
        "sent" -> Icons.Filled.Send
        "spam" -> Icons.Filled.Report
        "archive" -> Icons.Filled.Archive
        else -> Icons.Filled.Delete
    }
    NavigationDrawerItem(
        label = { Text(f.title) }, icon = { Icon(icon, null) }, selected = selected,
        badge = { if (n > 0) Text(Format.count(n), fontWeight = if (f.key == "inbox") FontWeight.Bold else FontWeight.Normal) },
        onClick = { close(); mail.chooseFolder(f.id, if (f.id.startsWith("q:")) f.title else null) },
        modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding)
            .semantics { contentDescription = f.title + if (n > 0) ", $n" + (if (f.key == "inbox" || f.key == "spam") " unread" else "") else "" },
    )
}

@Composable
private fun DrawerItem(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector, selected: Boolean, onClick: () -> Unit) {
    NavigationDrawerItem(
        label = { Text(title) }, icon = { Icon(icon, null) }, selected = selected, onClick = onClick,
        modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
    )
}

@Composable
private fun SectionHeader(title: String) {
    HorizontalDivider(Modifier.padding(top = 8.dp))
    Text(title, Modifier.padding(start = 28.dp, top = 12.dp, bottom = 4.dp), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** The "someone shared labels with you" banner (T8.2): accept, reject, or decide later. */
@Composable
fun OfferBanner(o: ApiLabelOffer, onAnswer: (String) -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer).padding(horizontal = 16.dp, vertical = 10.dp)
            .semantics { contentDescription = "${o.ownerName} shared ${o.count} labels with you" },
    ) {
        Text("${o.ownerName} shared ${o.count} label${if (o.count == 1) "" else "s"} from ${o.mailbox}", color = MaterialTheme.colorScheme.onPrimaryContainer, fontWeight = FontWeight.Medium)
        val names = o.labels.take(4).joinToString(", ") { it.name } + if (o.labels.size > 4) "…" else ""
        if (names.isNotEmpty()) Text(names, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onPrimaryContainer)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { onAnswer("accept") }) { Text("Accept") }
            TextButton(onClick = { onAnswer("reject") }) { Text("Reject") }
            TextButton(onClick = { onAnswer("later") }) { Text("Decide later") }
        }
    }
}

@Composable
fun HelpDialog(serverUrl: String, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        confirmButton = { TextButton(onClick = onClose) { Text("Close") } },
        title = { Text("Help") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("• Swipe a message right or left for quick actions (change them in Settings → Swipe actions).")
                Text("• Long-press a message to select several, then archive, delete, label or snooze them.")
                Text("• The round button at the top right picks which mailbox you are looking at.")
                Text("• Labels and smart views are in the menu; use Manage labels to add or change labels.")
                Text("• The full manual is in the web app, under the Help page of $serverUrl.")
            }
        },
    )
}
