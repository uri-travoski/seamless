package au.sam.seamless

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Manage labels: create, rename, recolour, nest and delete. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LabelsScreen(mail: MailViewModel, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    var editing by remember { mutableStateOf<ApiLabel?>(null) }
    var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<ApiLabel?>(null) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(mail) { mail.snacks.collect { snackbar.showSnackbar(it.message) } }
    val rows = LabelTree.flatten(mail.labels, honourVisibility = false)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Labels") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
        floatingActionButton = { ExtendedFloatingActionButton(onClick = { creating = true }, icon = { Icon(Icons.Filled.Add, null) }, text = { Text("New label") }) },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        if (rows.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(pad).padding(32.dp), contentAlignment = Alignment.Center) {
                Text("You have no labels yet. Press New label to make one.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(bottom = 96.dp)) {
            items(rows, key = { it.label.id }) { r ->
                val l = r.label
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = !l.shared) { editing = l }.padding(start = (16 + r.depth * 20).dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
                        .semantics { contentDescription = "Label ${l.name}" + if (l.shared) ", shared by ${l.sharedBy}" else ". Tap to edit." },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(16.dp).clip(RoundedCornerShape(4.dp)).background(parseColor(l.color, MaterialTheme.colorScheme.primary)))
                    Spacer(Modifier.width(16.dp))
                    Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
                        Text(l.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (l.shared) Text("Shared by ${l.sharedBy}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (l.unread > 0) Text(Format.count(l.unread), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!l.shared) IconButton(onClick = { deleting = l }) { Icon(Icons.Filled.Delete, "Delete label ${l.name}") }
                }
            }
        }
    }

    if (creating) LabelEditor(mail, null, onClose = { creating = false })
    editing?.let { LabelEditor(mail, it, onClose = { editing = null }) }
    deleting?.let { l ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete \"${l.name}\"?") },
            text = { Text("The label is taken off every message. The messages themselves are not deleted.") },
            confirmButton = { TextButton(onClick = { mail.removeLabel(l); deleting = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LabelEditor(mail: MailViewModel, label: ApiLabel?, onClose: () -> Unit) {
    var name by remember { mutableStateOf(label?.name.orEmpty()) }
    var color by remember { mutableStateOf(label?.color?.takeIf { it.isNotBlank() } ?: LABEL_COLORS[5]) }
    var parent by remember { mutableStateOf(label?.parentId) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var parentMenu by remember { mutableStateOf(false) }
    val choices = remember(mail.labels, label) { LabelTree.parentChoices(mail.labels, label?.id) }

    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text(if (label == null) "New label" else "Edit label") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(name, { name = it; error = null }, label = { Text("Name") }, singleLine = true, isError = error != null,
                    supportingText = error?.let { { Text(it) } }, modifier = Modifier.fillMaxWidth())
                Text("Colour", style = MaterialTheme.typography.labelLarge)
                // two rows of six swatches
                LABEL_COLORS.chunked(6).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { c ->
                            Box(
                                Modifier.size(36.dp).clip(CircleShape).background(parseColor(c, Color.Gray)).clickable { color = c }
                                    .semantics { contentDescription = "Colour $c" + if (c == color) ", selected" else "" },
                                contentAlignment = Alignment.Center,
                            ) { if (c == color) Icon(Icons.Filled.Check, null, tint = Color.White) }
                        }
                    }
                }
                Text("Inside", style = MaterialTheme.typography.labelLarge)
                Box {
                    OutlinedButton(onClick = { parentMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(choices.firstOrNull { it.label.id == parent }?.label?.name ?: "Nothing (top level)", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    DropdownMenu(parentMenu, { parentMenu = false }) {
                        DropdownMenuItem(text = { Text("Nothing (top level)") }, onClick = { parent = null; parentMenu = false })
                        choices.forEach { r ->
                            DropdownMenuItem(text = { Text("  ".repeat(r.depth) + r.label.name) }, onClick = { parent = r.label.id; parentMenu = false })
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                busy = true
                mail.saveLabel(label?.id, name, color, parent) { err -> busy = false; if (err == null) onClose() else error = err }
            }) { Text("Save") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onClose) { Text("Cancel") } },
    )
}
