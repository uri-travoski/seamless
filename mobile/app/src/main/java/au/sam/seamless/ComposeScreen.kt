package au.sam.seamless

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.LifecycleEventObserver
import java.io.InputStream
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Phone files behind `content://` uris from the system picker or a Share (no storage permission involved). */
class ContentFiles(private val ctx: Context) : FileAccess {
    override fun describe(uri: String): Triple<String, Long, String>? = try {
        val u = Uri.parse(uri)
        var name = u.lastPathSegment?.substringAfterLast('/') ?: "attachment"
        var size = -1L
        ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { c.getString(it)?.let { n -> name = n } }
                c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
            }
        }
        if (size < 0) size = ctx.contentResolver.openAssetFileDescriptor(u, "r")?.use { it.length } ?: 0
        Triple(name, size.coerceAtLeast(0), ctx.contentResolver.getType(u) ?: "application/octet-stream")
    } catch (_: Exception) { null }

    override fun open(uri: String): InputStream? = try { ctx.contentResolver.openInputStream(Uri.parse(uri)) } catch (_: Exception) { null }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ComposeScreen(c: ComposeViewModel) {
    BackHandler { c.requestClose() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, c) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_STOP) c.onStop() }
        lifecycle.addObserver(obs); onDispose { lifecycle.removeObserver(obs) }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> uris.forEach { c.addAttachment(it.toString()) } }
    var schedule by remember { mutableStateOf(false) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().statusBarsPadding().imePadding().navigationBarsPadding()) {
            ComposeTopBar(c, onAttach = { pick.launch(arrayOf("*/*")) }, onSchedule = { schedule = true })
            if (c.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (c.viewingMode) NoticeBanner("Viewing mode: this server is not sending mail, so Send is off.")
            c.error?.let { Text(it, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(12.dp).semantics { contentDescription = "Error: $it" },
                color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyMedium) }
            c.notice?.let { Text(it, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.secondaryContainer).padding(12.dp).clickable { c.notice = null },
                color = MaterialTheme.colorScheme.onSecondaryContainer, style = MaterialTheme.typography.bodyMedium) }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                FromRow(c)
                HorizontalDivider()
                AddressRow("To", "to", c, trailing = {
                    IconButton({ c.showCcBcc = !c.showCcBcc }, Modifier.size(48.dp)) {
                        Icon(if (c.showCcBcc) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (c.showCcBcc) "Hide Cc and Bcc" else "Show Cc and Bcc")
                    }
                })
                if (c.showCcBcc) { AddressRow("Cc", "cc", c); AddressRow("Bcc", "bcc", c) }
                HorizontalDivider()
                BasicTextField(
                    value = c.subject, onValueChange = { c.subject = it.replace('\n', ' ') },
                    singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                    decorationBox = { inner ->
                        Box(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp), contentAlignment = Alignment.CenterStart) {
                            if (c.subject.isEmpty()) Text("Subject", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
                            inner()
                        }
                    },
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Subject" },
                )
                HorizontalDivider()
                FormatBar(c)
                Body(c)
                if (c.signatureHtml.isNotEmpty()) SignatureNote(c)
                if (c.quotedHtml.isNotEmpty()) QuotedNote(c)
                if (c.attachments.isNotEmpty()) Attachments(c)
                Spacer(Modifier.height(24.dp))
            }
            c.scheduleAt?.let { at ->
                Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Schedule, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp))
                    Text("Will be sent ${scheduleText(at)}", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton({ c.scheduleAt = null }) { Text("Send now instead") }
                }
            }
        }
    }

    if (schedule) SchedulePicker(initial = c.scheduleAt, onDismiss = { schedule = false }, onPick = { c.scheduleAt = it; schedule = false })
    if (c.confirmDiscard) AlertDialog(
        onDismissRequest = { c.confirmDiscard = false },
        title = { Text("Keep this message?") },
        text = { Text("Save it as a draft to finish later, or throw it away.") },
        confirmButton = { TextButton(c::saveAndClose) { Text("Save draft") } },
        dismissButton = {
            Row {
                TextButton({ c.confirmDiscard = false }) { Text("Keep editing") }
                TextButton(c::discard) { Text("Discard", color = MaterialTheme.colorScheme.error) }
            }
        },
    )
    if (c.confirmNoSubject) AlertDialog(
        onDismissRequest = { c.confirmNoSubject = false },
        title = { Text("Send without a subject?") },
        text = { Text("This message has no subject.") },
        confirmButton = { TextButton({ c.confirmNoSubject = false; c.send(confirmedNoSubject = true) }) { Text("Send anyway") } },
        dismissButton = { TextButton({ c.confirmNoSubject = false }) { Text("Cancel") } },
    )
}

@Composable
private fun ComposeTopBar(c: ComposeViewModel, onAttach: () -> Unit, onSchedule: () -> Unit) {
    val title = when (val r = c.request) {
        is ComposeRequest.Reply -> when (r.kind) { "forward" -> "Forward"; "replyAll" -> "Reply all"; else -> "Reply" }
        is ComposeRequest.Draft -> "Draft"
        else -> "New message"
    }
    Row(Modifier.fillMaxWidth().height(60.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(c::requestClose, Modifier.size(48.dp)) { Icon(Icons.Filled.Close, "Close and keep or discard") }
        Text(title, Modifier.weight(1f).padding(start = 4.dp), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        IconButton(onAttach, Modifier.size(48.dp), enabled = !c.viewingMode) { Icon(Icons.Filled.AttachFile, "Attach a file") }
        IconButton(onSchedule, Modifier.size(48.dp), enabled = !c.viewingMode) { Icon(Icons.Filled.Schedule, "Schedule send") }
        IconButton({ c.send() }, Modifier.size(48.dp), enabled = c.canSend) {
            if (c.sending) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            else Icon(Icons.AutoMirrored.Filled.Send, if (c.scheduleAt != null) "Schedule" else "Send", tint = if (c.canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun FromRow(c: ComposeViewModel) {
    var open by remember { mutableStateOf(false) }
    val i = c.identity
    Box {
        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(enabled = c.identities.size > 1, onClickLabel = "Choose the address to send from") { open = true }.padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("From", Modifier.width(52.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(if (i == null) "…" else if (i.name.isNotBlank()) "${i.name} <${i.email}>" else i.email, Modifier.weight(1f).semantics { contentDescription = "From ${i?.email.orEmpty()}" },
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (c.identities.size > 1) Icon(Icons.Filled.ArrowDropDown, null)
        }
        DropdownMenu(open, { open = false }) {
            c.identities.forEach { id ->
                DropdownMenuItem(
                    text = { Column { Text(id.name.ifBlank { id.email }, maxLines = 1, overflow = TextOverflow.Ellipsis); if (id.name.isNotBlank()) Text(id.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                    onClick = { c.pickIdentity(id); open = false },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AddressRow(label: String, field: String, c: ComposeViewModel, trailing: @Composable () -> Unit = {}) {
    val list = when (field) { "to" -> c.to; "cc" -> c.cc; else -> c.bcc }
    val focus = remember { FocusRequester() }
    LaunchedEffect(c.loading) { if (!c.loading && field == "to" && c.focusField == "to" && c.to.isEmpty()) runCatching { focus.requestFocus() } }
    Column {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.Top) {
            Text(label, Modifier.width(52.dp).padding(top = 14.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(Modifier.weight(1f).padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                list.forEach { a -> AddressChip(a) { c.removeAddress(field, a) } }
                BasicTextField(
                    value = c.inputOf(field), onValueChange = { c.setInput(field, it) },
                    singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { c.commit(field) }),
                    modifier = Modifier.widthIn(min = 120.dp).heightIn(min = 40.dp).focusRequester(focus)
                        .onFocusChanged { if (!it.isFocused) c.commit(field) }
                        .semantics { contentDescription = "$label recipients" },
                    decorationBox = { inner -> Box(Modifier.heightIn(min = 40.dp), contentAlignment = Alignment.CenterStart) { inner() } },
                )
            }
            trailing()
        }
        if (c.suggestFor == field && c.suggestions.isNotEmpty() && c.inputOf(field).isNotBlank()) {
            Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
                c.suggestions.forEach { s ->
                    Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { c.addAddress(field, s) }.padding(horizontal = 16.dp, vertical = 6.dp), verticalArrangement = Arrangement.Center) {
                        if (s.name.isNotBlank()) { Text(s.name, maxLines = 1, overflow = TextOverflow.Ellipsis); Text(s.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        else Text(s.email, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}


@Composable
private fun AddressChip(a: ApiAddress, onRemove: () -> Unit) {
    val shown = a.name.ifBlank { a.email }
    Row(Modifier.clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.secondaryContainer).heightIn(min = 32.dp).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(shown, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp), color = MaterialTheme.colorScheme.onSecondaryContainer, style = MaterialTheme.typography.bodyMedium)
        IconButton(onRemove, Modifier.size(32.dp)) { Icon(Icons.Filled.Close, "Remove ${a.email}", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer) }
    }
}

@Composable
private fun FormatBar(c: ComposeViewModel) {
    fun apply(e: Editing.Edit) { c.text = TextFieldValue(e.text, TextRange(e.start, e.end)) }
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton({ apply(Editing.wrap(c.text.text, c.text.selection.min, c.text.selection.max, "**")) }, Modifier.size(48.dp)) { Icon(Icons.Filled.FormatBold, "Bold") }
        IconButton({ apply(Editing.wrap(c.text.text, c.text.selection.min, c.text.selection.max, "_")) }, Modifier.size(48.dp)) { Icon(Icons.Filled.FormatItalic, "Italic") }
        IconButton({ apply(Editing.toggleList(c.text.text, c.text.selection.min, c.text.selection.max)) }, Modifier.size(48.dp)) { Icon(Icons.Filled.FormatListBulleted, "Bulleted list") }
    }
}

@Composable
private fun Body(c: ComposeViewModel) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(c.loading) { if (!c.loading && c.focusField == "body") runCatching { focus.requestFocus() } }
    BasicTextField(
        value = c.text, onValueChange = { c.text = it },
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences),
        modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp).focusRequester(focus).semantics { contentDescription = "Message body" },
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                if (c.text.text.isEmpty()) Text("Write your message", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
                inner()
            }
        },
    )
}

/** The signature is added by the server's identity setting; shown as plain text here so you know it will be sent. */
@Composable
private fun SignatureNote(c: ComposeViewModel) {
    val plain = remember(c.signatureHtml) { ComposeLogic.htmlToText(c.signatureHtml).lines().take(4).joinToString("\n") }
    if (plain.isBlank()) return
    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        Text("Signature (added when you send)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(plain, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 4, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun QuotedNote(c: ComposeViewModel) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        TextButton({ c.quoteVisible = !c.quoteVisible }, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Icon(Icons.Filled.MoreHoriz, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(if (c.quoteVisible) "Hide quoted text" else "Show quoted text (it is sent with your message)")
        }
        if (c.quoteVisible) {
            val plain = remember(c.quotedHtml) { ComposeLogic.htmlToText(c.quotedHtml).lines().take(40).joinToString("\n") { "> $it" } }
            Text(plain, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Attachments(c: ComposeViewModel) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        c.attachments.forEach { a ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).heightIn(min = 48.dp).padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.AttachFile, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(a.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(when (a.state) { UploadState.Uploading -> "Uploading…"; UploadState.Failed -> a.error.ifBlank { "Upload failed" }; UploadState.Done -> ConvFormat.size(a.size) },
                        style = MaterialTheme.typography.bodySmall, color = if (a.state == UploadState.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (a.state == UploadState.Failed && a.uri.isNotEmpty()) TextButton({ c.retryAttachment(a) }) { Text("Retry") }
                IconButton({ c.removeAttachment(a) }, Modifier.size(48.dp)) { Icon(Icons.Filled.Close, "Remove ${a.name}") }
            }
        }
    }
}

fun scheduleText(at: Long): String =
    Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("EEE d MMM, h:mm a", Locale.getDefault()))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SchedulePicker(initial: Long?, onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val zone = ZoneId.systemDefault()
    val start = initial?.let { Instant.ofEpochMilli(it).atZone(zone) } ?: java.time.ZonedDateTime.now(zone).plusHours(1).withMinute(0)
    var step by remember { mutableStateOf(0) }
    var date by remember { mutableStateOf(start.toLocalDate()) }
    val dateState = rememberDatePickerState(initialSelectedDateMillis = start.toLocalDate().atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli(),
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long) = !Instant.ofEpochMilli(utcTimeMillis).atZone(java.time.ZoneOffset.UTC).toLocalDate().isBefore(LocalDate.now(zone))
        })
    val timeState = rememberTimePickerState(initialHour = start.hour, initialMinute = start.minute, is24Hour = android.text.format.DateFormat.is24HourFormat(LocalContext.current))
    var problem by remember { mutableStateOf<String?>(null) }
    if (step == 0) {
        DatePickerDialog(onDismissRequest = onDismiss,
            confirmButton = { TextButton({ dateState.selectedDateMillis?.let { date = Instant.ofEpochMilli(it).atZone(java.time.ZoneOffset.UTC).toLocalDate(); step = 1 } }) { Text("Next") } },
            dismissButton = { TextButton(onDismiss) { Text("Cancel") } }) { DatePicker(dateState) }
    } else {
        AlertDialog(onDismissRequest = onDismiss, title = { Text("Send at") },
            text = { Column(horizontalAlignment = Alignment.CenterHorizontally) {
                TimePicker(timeState)
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            } },
            confirmButton = { TextButton({
                val at = date.atTime(LocalTime.of(timeState.hour, timeState.minute)).atZone(zone).toInstant().toEpochMilli()
                if (at <= System.currentTimeMillis() + 60_000) problem = "Pick a time in the future." else onPick(at)
            }) { Text("Schedule") } },
            dismissButton = { TextButton({ step = 0 }) { Text("Back") } })
    }
}

/** The bar shown while the server holds a message for the undo-send countdown. */
@Composable
fun PendingSendBar(mail: MailViewModel, modifier: Modifier = Modifier) {
    val p = mail.pendingSend ?: return
    var now by remember(p.jobId) { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(p.jobId) { while (true) { kotlinx.coroutines.delay(250); now = System.currentTimeMillis() } }
    val left = ((p.releaseAtLocal - now + 999) / 1000).coerceAtLeast(0)
    Surface(modifier.padding(12.dp).navigationBarsPadding(), shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.inverseSurface, tonalElevation = 6.dp) {
        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Sending… ${left}s", Modifier.weight(1f).semantics { contentDescription = "Sending in $left seconds" }, color = MaterialTheme.colorScheme.inverseOnSurface)
            TextButton(mail::undoPendingSend) { Text("Undo", color = MaterialTheme.colorScheme.inversePrimary, fontWeight = FontWeight.Bold) }
        }
    }
}
