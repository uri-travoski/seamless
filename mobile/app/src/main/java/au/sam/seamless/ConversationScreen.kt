package au.sam.seamless

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Label
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.ReplyAll
import androidx.compose.material.icons.automirrored.filled.Forward
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(mail: MailViewModel, conv: ConversationViewModel, api: Api, session: Session) {
    BackHandler { conv.leave() }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(mail) {
        mail.snacks.collect { s ->
            val r = snackbar.showSnackbar(s.message, actionLabel = s.undoLabel, duration = SnackbarDuration.Long)
            if (r == SnackbarResult.ActionPerformed) s.onUndo?.invoke()
        }
    }
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar, Modifier.navigationBarsPadding()) },
        contentWindowInsets = WindowInsets(0),
        topBar = { ConvTopBar(conv) },
        bottomBar = { ReplyBar(mail, conv) },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when {
                conv.loading && conv.messages.size <= 1 && conv.newest.body == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
                conv.error != null -> ErrorBlockSimple(conv.error!!) { conv.retry() }
                else -> ThreadList(mail, conv, api, session)
            }
        }
    }
    ConvSheets(mail, conv)
    conv.confirmLink?.let { url -> LinkConfirm(url) { conv.confirmLink = null } }
    conv.blockedLink?.let { why ->
        AlertDialog(onDismissRequest = { conv.blockedLink = null }, confirmButton = { TextButton({ conv.blockedLink = null }) { Text("OK") } },
            title = { Text("Link blocked") }, text = { Text(why) })
    }
    conv.fixFor?.let { FixSheet(mail, conv, it) }
}

@Composable
private fun ErrorBlockSimple(message: String, retry: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(message, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(12.dp))
        OutlinedButton(retry) { Text("Retry") }
    }
}

@Composable
private fun ConvTopBar(conv: ConversationViewModel) {
    Surface(color = MaterialTheme.colorScheme.background) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton({ conv.leave() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Spacer(Modifier.weight(1f))
            IconButton(conv::archive) { Icon(Icons.Default.Archive, "Archive") }
            IconButton(conv::delete) { Icon(Icons.Default.Delete, "Delete") }
            IconButton(conv::markUnread) { Icon(Icons.Default.MarkEmailUnread, "Mark as unread") }
            IconButton({ conv.sheet = ConvSheet.Label }) { Icon(Icons.AutoMirrored.Filled.Label, "Labels") }
            IconButton({ conv.sheet = ConvSheet.Snooze }) { Icon(Icons.Default.Snooze, "Snooze") }
            Box {
                IconButton({ conv.moreOpen = true }) { Icon(Icons.Default.MoreVert, "More") }
                DropdownMenu(conv.moreOpen, { conv.moreOpen = false }) {
                    DropdownMenuItem({ Text("Move to…") }, { conv.moreOpen = false; conv.sheet = ConvSheet.Move })
                    DropdownMenuItem({ Text("Report spam") }, { conv.moreOpen = false; conv.spam() })
                }
            }
        }
    }
}

@Composable
private fun ThreadList(mail: MailViewModel, conv: ConversationViewModel, api: Api, session: Session) {
    val byId = remember(mail.labels) { mail.labels.associateBy { it.id } }
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Text(conv.subject, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            val chips = conv.labelIds.mapNotNull { byId[it] }
            if (chips.isNotEmpty()) Row(Modifier.padding(horizontal = 16.dp).padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                chips.take(4).forEach { l ->
                    val c = parseColor(l.color, MaterialTheme.colorScheme.primary)
                    Text(l.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, color = Color.White,
                        modifier = Modifier.widthIn(max = 140.dp).clip(RoundedCornerShape(6.dp)).background(c).clickable { conv.leave(); mail.chooseLabel(l) }.padding(horizontal = 8.dp, vertical = 3.dp)
                            .semantics { contentDescription = "Label ${l.name}. Show this label." })
                }
            }
            HorizontalDivider()
        }
        items(conv.messages, key = { it.email.id }) { m ->
            val open = m.email.id in conv.expanded
            if (open) ExpandedMessage(mail, conv, m, api, session) else CollapsedMessage(conv, m)
            HorizontalDivider()
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

@Composable
private fun SenderAvatar(e: ApiEmail) {
    val c = parseColor(e.accountColor, MaterialTheme.colorScheme.primary)
    Box(Modifier.size(40.dp).clip(CircleShape).background(c), contentAlignment = Alignment.Center) {
        Text(ConvFormat.initial(e), color = Color.White, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun CollapsedMessage(conv: ConversationViewModel, m: ConvMessage) {
    val e = m.email
    Row(Modifier.fillMaxWidth().clickable { conv.toggleExpanded(e.id) }.padding(horizontal = 16.dp, vertical = 10.dp)
        .semantics { contentDescription = "${e.sender}, ${ConvFormat.short(e.receivedAt)}. Tap to expand." }, verticalAlignment = Alignment.CenterVertically) {
        SenderAvatar(e)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(e.sender, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (e.unread) FontWeight.Bold else FontWeight.Normal)
            Text(e.preview, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(ConvFormat.short(e.receivedAt), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ExpandedMessage(mail: MailViewModel, conv: ConversationViewModel, m: ConvMessage, api: Api, session: Session) {
    val e = m.email
    val showDetails = e.id in conv.details
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.clickable { conv.toggleExpanded(e.id) }) { SenderAvatar(e) }
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(e.sender, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(Modifier.clickable { conv.toggleDetails(e.id) }.heightIn(min = 32.dp).semantics { contentDescription = if (showDetails) "Hide details" else "Show details" }, verticalAlignment = Alignment.CenterVertically) {
                    Text(ConvFormat.toLine(e.to, conv.me), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
                    Icon(if (showDetails) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(ConvFormat.short(e.receivedAt), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton({ conv.toggleStar(e.id) }) {
                if (e.starred) Icon(Icons.Default.Star, "Starred. Tap to remove the star.", tint = Color(0xFFF4B400)) else Icon(Icons.Outlined.StarBorder, "Not starred. Tap to star.")
            }
        }
        if (showDetails) Column(Modifier.padding(start = 68.dp, end = 16.dp, bottom = 6.dp)) {
            DetailLine("From", e.from.joinToString { it.name.ifBlank { it.email } + " <" + it.email + ">" })
            DetailLine("To", e.to.joinToString { it.email })
            DetailLine("Date", ConvFormat.full(e.receivedAt))
        }
        e.risk?.let { r -> RiskBanner(r) }
        val body = m.body
        if (body != null) {
            listOfNotNull(body.pgp?.badge("OpenPGP"), body.smime?.badge("S/MIME")).forEach { CryptoBadge(it) }
            if (body.hasBlockedRemote && !m.imagesShown) ImagesBanner(
                onShow = { conv.showImages(e.id, always = false) },
                onAlways = { conv.showImages(e.id, always = true) },
                sender = e.from.firstOrNull()?.email.orEmpty())
            MessageWebView(api, session, body, m.imagesShown, conv::linkTapped)
            body.invite?.let { InviteCard(it, onRsvp = { p -> conv.rsvp(m, p) }) }
            val listed = body.attachments.filter { it.listed }
            if (listed.isNotEmpty()) AttachmentStrip(api, session, e.id, listed)
        } else if (m.bodyError != null) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(m.bodyError, Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                TextButton({ conv.loadBody(e.id) }) { Text("Retry") }
            }
        } else LinearProgressIndicator(Modifier.fillMaxWidth().padding(16.dp))
        m.why?.let { w ->
            Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("${w.line()} · why?", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (w.reason != null) Text(" ${w.reason}", Modifier.weight(1f, false), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton({ conv.fixFor = m }) { Text("Wrong? Fix it") }
            }
        }
    }
}

@Composable
private fun DetailLine(k: String, v: String) =
    Text("$k: $v", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun RiskBanner(r: ApiRisk) {
    val high = r.level == "high"
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).clip(RoundedCornerShape(8.dp))
        .background(if (high) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.tertiaryContainer).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Warning, null, Modifier.size(18.dp))
            Text(if (high) "  This message looks dangerous" else "  Be careful with this message", fontWeight = FontWeight.Bold)
        }
        r.reasons.take(4).forEach { Text("• " + it.text, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun CryptoBadge(text: String) {
    val bad = text.contains("BAD")
    Text(text, Modifier.padding(horizontal = 16.dp, vertical = 2.dp).clip(RoundedCornerShape(6.dp))
        .background(if (bad) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer).padding(horizontal = 8.dp, vertical = 3.dp),
        style = MaterialTheme.typography.labelMedium)
}

@Composable
private fun ImagesBanner(onShow: () -> Unit, onAlways: () -> Unit, sender: String) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp)) {
        Text("Pictures are hidden to protect your privacy.", style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onShow) { Text("Show images") }
            if (sender.isNotBlank()) TextButton(onAlways) { Text("Always from this sender") }
        }
    }
}

@Composable
private fun InviteCard(inv: ApiInvite, onRsvp: (String) -> Unit) {
    val zone = java.time.ZoneId.systemDefault()
    val fmt = java.time.format.DateTimeFormatter.ofPattern("EEE d MMM, h:mm a")
    val whenText = inv.startsAt?.let { java.time.Instant.ofEpochMilli(it).atZone(zone).format(if (inv.allDay) java.time.format.DateTimeFormatter.ofPattern("EEE d MMM") else fmt) }.orEmpty()
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Default.Event, null); Text("  Invitation", style = MaterialTheme.typography.labelLarge) }
        Text(inv.summary.ifBlank { "(no title)" }, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 4.dp))
        if (whenText.isNotBlank()) Text(whenText, style = MaterialTheme.typography.bodyMedium)
        if (inv.location.isNotBlank()) Text(inv.location, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        inv.organizer?.let { Text("From " + it.name.ifBlank { it.email }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (inv.status == "cancelled") Text("This event was cancelled.", color = MaterialTheme.colorScheme.error)
        else if (inv.canRsvp) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                for ((label, p) in listOf("Accept" to "ACCEPTED", "Maybe" to "TENTATIVE", "Decline" to "DECLINED")) {
                    if (inv.myPartstat == p) Button({ onRsvp(p) }) { Text(label) } else OutlinedButton({ onRsvp(p) }) { Text(label) }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AttachmentStrip(api: Api, session: Session, emailId: String, list: List<ApiAttachment>) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<ApiAttachment?>(null) }
    var chosen by remember { mutableStateOf<ApiAttachment?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri: Uri? ->
        val att = pending; pending = null
        if (uri == null || att == null) return@rememberLauncherForActivityResult
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                ctx.contentResolver.openOutputStream(uri)?.use { api.downloadAttachment(session.serverUrl, emailId, att.partId, it) }
            }
            note = if (r is ApiResult.Ok) "Saved ${att.filename}" else "Couldn't save ${att.filename}."
        }
    }
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("${list.size} attachment${if (list.size == 1) "" else "s"}", style = MaterialTheme.typography.labelLarge)
        list.forEach { a ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant).clickable { chosen = a }.heightIn(min = 48.dp).padding(horizontal = 12.dp)
                .semantics { contentDescription = "Attachment ${a.filename}, ${ConvFormat.size(a.size)}. Tap for options." }, verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.AttachFile, null)
                Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                    Text(a.filename.ifBlank { "attachment" }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(ConvFormat.size(a.size), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
    chosen?.let { a ->
        ModalBottomSheet(onDismissRequest = { chosen = null }) {
            Column(Modifier.padding(bottom = 24.dp).navigationBarsPadding()) {
                Text(a.filename, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                ConvRow("Save to…") { chosen = null; pending = a; save.launch(a.filename.ifBlank { "attachment" }) }
                ConvRow("Open with…") {
                    chosen = null
                    scope.launch {
                        val f = withContext(Dispatchers.IO) {
                            val dir = File(ctx.cacheDir, "attachments").apply { mkdirs() }
                            val out = File(dir, a.filename.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "attachment" })
                            val r = out.outputStream().use { api.downloadAttachment(session.serverUrl, emailId, a.partId, it) }
                            if (r is ApiResult.Ok) out else null
                        }
                        if (f == null) { note = "Couldn't open ${a.filename}."; return@launch }
                        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
                        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, a.contentType.ifBlank { "*/*" }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        try { ctx.startActivity(Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        catch (_: Exception) { note = "No app on this phone can open that kind of file." }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConvRow(text: String, onClick: () -> Unit) =
    Text(text, Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 48.dp).padding(horizontal = 24.dp, vertical = 12.dp), style = MaterialTheme.typography.bodyLarge)

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MessageWebView(api: Api, session: Session, body: ApiBody, showImages: Boolean, onLink: (String) -> Unit) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val origin = session.serverUrl
    val html = remember(body, dark, showImages) { BodyHtml.page(body.html, body.text, dark, showImages, origin) }
    AndroidView(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                @Suppress("DEPRECATION") run {
                    settings.allowFileAccessFromFileURLs = false
                    settings.allowUniversalAccessFromFileURLs = false
                }
                settings.domStorageEnabled = false
                settings.databaseEnabled = false
                settings.setGeolocationEnabled(false)
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.setSupportZoom(true)
                settings.builtInZoomControls = true
                settings.displayZoomControls = false
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                settings.layoutAlgorithm = WebSettings.LayoutAlgorithm.TEXT_AUTOSIZING
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                isVerticalScrollBarEnabled = false
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        onLink(request.url.toString()) // JavaScript is off, so this is always a tapped link
                        return true
                    }
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val u = request.url.toString()
                        // Inline pictures of this message come from the Seamless server and need the app's own cookies.
                        if (u.startsWith("$origin/api/blob/")) {
                            val res = api.fetchForWebView(u)
                            if (res != null && res.isSuccessful) {
                                val type = res.header("Content-Type")?.substringBefore(';') ?: "application/octet-stream"
                                return WebResourceResponse(type, null, res.body!!.byteStream())
                            }
                            return blocked()
                        }
                        // Everything else the page asks for is decided by its Content-Security-Policy (no remote pictures until allowed).
                        return if (request.isForMainFrame || request.url.scheme == "data" || request.url.scheme == "http" || request.url.scheme == "https") null else blocked()
                    }
                }
            }
        },
        update = { wv ->
            if (wv.tag != html) {
                wv.tag = html
                wv.loadDataWithBaseURL(origin, html, "text/html", "utf-8", null)
            }
        },
        onRelease = { it.destroy() },
    )
}

private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

@Composable
private fun LinkConfirm(url: String, close: () -> Unit) {
    val ctx = LocalContext.current
    val v = LinkGuard.check(url) as? LinkVerdict.Allowed
    AlertDialog(
        onDismissRequest = close,
        title = { Text("Open this link?") },
        text = {
            Column {
                Text("This link goes to:")
                Text(url, Modifier.padding(top = 6.dp), fontWeight = FontWeight.Bold)
                if (v?.scheme == "http") Text("This address is not encrypted (http).", Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton({
                close()
                try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
            }) { Text("Open") }
        },
        dismissButton = { TextButton(close) { Text("Cancel") } },
    )
}

@Composable
private fun ReplyBar(mail: MailViewModel, conv: ConversationViewModel) {
    Surface(color = MaterialTheme.colorScheme.background, tonalElevation = 2.dp) {
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val e = conv.newest.email
            val on = !mail.viewingMode
            OutlinedButton({ mail.compose("reply", e) }, Modifier.weight(1f).heightIn(min = 48.dp), enabled = on, contentPadding = PaddingValues(horizontal = 8.dp)) { Icon(Icons.AutoMirrored.Filled.Reply, null, Modifier.size(18.dp)); Text(" Reply", maxLines = 1) }
            OutlinedButton({ mail.compose("replyAll", e) }, Modifier.weight(1f).heightIn(min = 48.dp), enabled = on, contentPadding = PaddingValues(horizontal = 8.dp)) { Icon(Icons.AutoMirrored.Filled.ReplyAll, null, Modifier.size(18.dp)); Text(" Reply all", maxLines = 1) }
            OutlinedButton({ mail.compose("forward", e) }, Modifier.weight(1f).heightIn(min = 48.dp), enabled = on, contentPadding = PaddingValues(horizontal = 8.dp)) { Icon(Icons.AutoMirrored.Filled.Forward, null, Modifier.size(18.dp)); Text(" Forward", maxLines = 1) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConvSheets(mail: MailViewModel, conv: ConversationViewModel) {
    val sheet = conv.sheet ?: return
    ModalBottomSheet(onDismissRequest = { conv.sheet = null }) {
        Column(Modifier.padding(bottom = 24.dp).navigationBarsPadding().verticalScroll(rememberScrollState())) {
            when (sheet) {
                ConvSheet.Label -> LabelPicker(mail, conv)
                ConvSheet.Snooze -> {
                    Title("Snooze until")
                    SnoozePreset.entries.forEach { p -> ConvRow(p.title) { conv.sheet = null; conv.snooze(p) } }
                }
                ConvSheet.Move -> {
                    Title("Move to")
                    mail.folders.filter { it.role in setOf("inbox", "archive", "junk", "trash") && it.id != mail.folder }.forEach { f -> ConvRow(f.name) { conv.sheet = null; conv.move(f.id) } }
                }
            }
        }
    }
}

@Composable private fun Title(t: String) = Text(t, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp))

@Composable
private fun LabelPicker(mail: MailViewModel, conv: ConversationViewModel) {
    var name by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    Title("Label as")
    mail.labels.filter { !it.shared }.forEach { l ->
        val on = l.id in conv.labelIds
        Row(Modifier.fillMaxWidth().clickable { conv.setLabel(l.id, !on) }.heightIn(min = 48.dp).padding(horizontal = 16.dp)
            .semantics { contentDescription = "${l.name}, ${if (on) "applied" else "not applied"}" }, verticalAlignment = Alignment.CenterVertically) {
            Checkbox(on, { conv.setLabel(l.id, it) })
            Box(Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(parseColor(l.color, MaterialTheme.colorScheme.primary)))
            Text("  " + l.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    Row(Modifier.padding(horizontal = 24.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(name, { name = it; err = null }, Modifier.weight(1f), label = { Text("New label") }, singleLine = true, isError = err != null, supportingText = err?.let { { Text(it) } })
        TextButton({ conv.createLabel(name) { e -> if (e == null) name = "" else err = e } }, enabled = name.isNotBlank()) { Text("Create") }
    }
    TextButton({ conv.sheet = null }, Modifier.padding(horizontal = 16.dp)) { Text("Done") }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FixSheet(mail: MailViewModel, conv: ConversationViewModel, m: ConvMessage) {
    var labelId by remember { mutableStateOf(m.why?.labels?.firstOrNull()?.id) }
    var remember_ by remember { mutableStateOf(true) }
    ModalBottomSheet(onDismissRequest = { conv.fixFor = null }) {
        Column(Modifier.padding(bottom = 24.dp).navigationBarsPadding().verticalScroll(rememberScrollState())) {
            Title("Wrong? Pick the right label")
            Row(Modifier.fillMaxWidth().clickable { labelId = null }.heightIn(min = 48.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(labelId == null, { labelId = null }); Text("No label")
            }
            mail.labels.filter { !it.shared }.forEach { l ->
                Row(Modifier.fillMaxWidth().clickable { labelId = l.id }.heightIn(min = 48.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(labelId == l.id, { labelId = l.id }); Text(l.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Row(Modifier.fillMaxWidth().clickable { remember_ = !remember_ }.heightIn(min = 48.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(remember_, { remember_ = it }); Text("Remember this for similar mail")
            }
            Button({ conv.fixFor = null; conv.fix(m, labelId, remember_) }, Modifier.padding(horizontal = 24.dp).fillMaxWidth().heightIn(min = 48.dp)) { Text("Save correction") }
        }
    }
}
