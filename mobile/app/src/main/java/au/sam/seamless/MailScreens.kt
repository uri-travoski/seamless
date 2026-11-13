package au.sam.seamless

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

fun parseColor(hex: String, fallback: Color): Color =
    runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(fallback)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(vm: AppViewModel) {
    val mail = vm.mail ?: return
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var help by remember { mutableStateOf(false) }
    when (vm.overlay) {
        Overlay.Settings -> { SettingsScreen(vm, mail) { vm.overlay = Overlay.None }; return }
        Overlay.Labels -> { LabelsScreen(mail) { vm.overlay = Overlay.None }; return }
        Overlay.None -> {}
    }
    Box(Modifier.fillMaxSize()) {
    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = !mail.searchOpen,
        drawerContent = {
            DrawerContent(vm, mail, close = { scope.launch { drawer.close() } },
                onSettings = { vm.overlay = Overlay.Settings }, onLabels = { vm.overlay = Overlay.Labels }, onHelp = { help = true })
        },
    ) {
        MailHome(mail, onMenu = { scope.launch { drawer.open() } })
    }
    mail.conversation?.let { conv -> ConversationScreen(mail, conv, vm.apiClient, vm.session) }
    mail.composer?.let { ComposeScreen(it) }
    PendingSendBar(mail, Modifier.align(Alignment.BottomCenter))
    }
    if (help) HelpDialog(vm.session.serverUrl) { help = false }
    if (vm.askNotifications) NotificationAsk(vm)
}

/** Explains why Seamless wants to notify, then asks Android. Shown once after the first sign-in (Android 13+). */
@Composable
private fun NotificationAsk(vm: AppViewModel) {
    val launcher = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { vm.notificationsAsked() }
    AlertDialog(
        onDismissRequest = vm::notificationsAsked,
        title = { Text("Get notified about new mail?") },
        text = { Text("Seamless can tell you when mail arrives and when one of your mailboxes stops working. You can pick which mailboxes, hide the message text, or turn it off any time in Settings.") },
        confirmButton = {
            TextButton(onClick = {
                if (android.os.Build.VERSION.SDK_INT >= 33) launcher.launch(android.Manifest.permission.POST_NOTIFICATIONS) else vm.notificationsAsked()
            }) { Text("Continue") }
        },
        dismissButton = { TextButton(onClick = vm::notificationsAsked) { Text("Not now") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MailHome(mail: MailViewModel, onMenu: () -> Unit) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(mail) {
        mail.snacks.collectLatest { s ->
            val r = snackbar.showSnackbar(s.message, actionLabel = s.undoLabel, duration = SnackbarDuration.Long, withDismissAction = s.undoLabel == null)
            if (r == SnackbarResult.ActionPerformed) s.onUndo?.invoke()
        }
    }
    var sheet by remember { mutableStateOf<Sheet?>(null) }
    var alertOpen by remember { mutableStateOf(false) }
    LaunchedEffect(mail.alertRequest, mail.alert) { if (mail.alertRequest && mail.alert != null) { alertOpen = true; mail.alertRequest = false } }
    val selecting = mail.selection.isNotEmpty()
    BackHandler(enabled = selecting && !mail.searchOpen) { mail.clearSelection() }

    Box(Modifier.fillMaxSize()) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar, Modifier.navigationBarsPadding()) },
            containerColor = MaterialTheme.colorScheme.background,
            contentWindowInsets = WindowInsets(0),
            floatingActionButton = {
                if (!selecting && !mail.searchOpen) {
                    val off = mail.viewingMode
                    ExtendedFloatingActionButton(
                        onClick = mail::composeNew,
                        icon = { Icon(Icons.Filled.Edit, null) },
                        text = { Text("Compose") },
                        containerColor = if (off) MaterialTheme.colorScheme.surfaceContainerHighest else MaterialTheme.colorScheme.primaryContainer,
                        contentColor = if (off) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.navigationBarsPadding().semantics { contentDescription = if (off) "Compose (off in viewing mode)" else "Compose a new message" },
                    )
                }
            },
        ) { pad ->
            Column(Modifier.fillMaxSize().padding(pad)) {
                if (selecting) SelectionBar(mail, onSheet = { sheet = it })
                else TopBar(mail, onMenu, onSearch = mail::openSearch, onScope = { mail.pickerOpen = true })
                if (!selecting) QuickChips(mail)
                mail.alert?.let { AlertBanner(it) { alertOpen = true } }
                mail.bannerOffer?.let { o -> OfferBanner(o) { action -> mail.answerOffer(o, action) } }
                if (mail.viewingMode) NoticeBanner("Viewing mode: this server is not sending mail, so Compose and Send are off.")
                EmailList(mail, mail.main, mail.mainItems, mail.mainStatus, mail::refresh, mail::loadMore, summary = null, empty = "Nothing here")
            }
        }
        if (mail.searchOpen) SearchScreen(mail, onSheet = { sheet = it })
    }

    if (mail.pickerOpen) ScopeSheet(mail)
    sheet?.let { SelectionSheets(mail, it) { sheet = null } }
    if (alertOpen) mail.alert?.let { AlertDialogView(it) { alertOpen = false } }
}

enum class Sheet { Label, Snooze, Move }

// ---------------------------------------------------------------- top bar

@Composable
private fun TopBar(mail: MailViewModel, onMenu: () -> Unit, onSearch: () -> Unit, onScope: () -> Unit) {
    Row(Modifier.fillMaxWidth().statusBarsPadding().height(60.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onMenu, modifier = Modifier.size(48.dp)) { Icon(Icons.Filled.Menu, contentDescription = "Open menu") }
        Box(
            Modifier.weight(1f).height(46.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .clickable(onClickLabel = "Search mail", onClick = onSearch).padding(horizontal = 16.dp)
                .semantics { contentDescription = "Search mail" },
            contentAlignment = Alignment.CenterStart,
        ) { Text(if (mail.folder == "u:inbox") "Search mail" else "Search in ${mail.folderTitle}", color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
        Spacer(Modifier.width(8.dp))
        ScopeButton(mail, onScope)
        Spacer(Modifier.width(8.dp))
    }
}

@Composable
private fun ScopeButton(mail: MailViewModel, onClick: () -> Unit) {
    val color = scopeColor(mail.scopeId, mail.overview)
    val title = mail.scopeTitle
    Box(contentAlignment = Alignment.TopEnd) {
        Box(
            Modifier.size(44.dp).clip(CircleShape).background(color).clickable(onClick = onClick)
                .semantics { contentDescription = "Mailbox: $title. Change mailbox" },
            contentAlignment = Alignment.Center,
        ) {
            if (mail.scopeId == MailQuery.UNIFIED) Icon(Icons.Filled.AllInbox, null, tint = Color.White)
            else Text(Format.initial(title), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }
        if (mail.problemAccounts.isNotEmpty()) Box(Modifier.size(12.dp).clip(CircleShape).background(ProblemRed))
    }
}

val ProblemRed = Color(0xFFD93025)

@Composable
private fun scopeColor(scope: String, ov: ApiCategoryOverview?): Color {
    val primary = MaterialTheme.colorScheme.primary
    MailQuery.categoryOf(scope)?.let { id -> return parseColor(ov?.categories?.firstOrNull { it.id == id }?.color.orEmpty(), primary) }
    MailQuery.accountOf(scope)?.let { id -> return parseColor(ov?.mailboxes?.firstOrNull { it.id == id }?.color.orEmpty(), primary) }
    return primary
}

@Composable
private fun QuickChips(mail: MailViewModel) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        QChip("All", mail.quick == Quick.All) { mail.chooseQuick(Quick.All) }
        QChip("Unread", mail.quick == Quick.Unread) { mail.chooseQuick(Quick.Unread) }
        QChip("Attachments", mail.quick == Quick.Attachments) { mail.chooseQuick(Quick.Attachments) }
        mail.views.forEach { v ->
            val q = Quick.View(v.id, v.name, v.query)
            QChip(v.name, mail.quick == q) { mail.chooseQuick(q) }
        }
    }
}

@Composable
private fun QChip(label: String, selected: Boolean, onClick: () -> Unit) {
    FilterChip(selected = selected, onClick = onClick, label = { Text(label, maxLines = 1) })
}

// ---------------------------------------------------------------- banners

@Composable
private fun AlertBanner(a: ApiAlert, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(ProblemRed).clickable(onClickLabel = "Show details", onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp)
            .semantics { contentDescription = "Critical alert: ${a.title}. Tap for details." },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Warning, null, tint = Color.White)
        Spacer(Modifier.width(12.dp))
        Text(a.title, color = Color.White, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text("Details", color = Color.White, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun NoticeBanner(text: String) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.secondaryContainer).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Info, null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
        Spacer(Modifier.width(12.dp))
        Text(text, color = MaterialTheme.colorScheme.onSecondaryContainer, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun AlertDialogView(a: ApiAlert, onDismiss: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val uri = LocalUriHandler.current
    val server = (ctx.applicationContext as SeamlessApp).session.serverUrl
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Filled.Warning, null, tint = ProblemRed) },
        title = { Text(a.title) },
        text = { Text(a.body.ifBlank { "Seamless needs your attention." }) },
        confirmButton = {
            if (a.link != null) TextButton(onClick = { uri.openUri(server + a.link); onDismiss() }) { Text("Fix it") }
            else TextButton(onClick = onDismiss) { Text("OK") }
        },
        dismissButton = { if (a.link != null) TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

// ---------------------------------------------------------------- selection bar and sheets

@Composable
private fun SelectionBar(mail: MailViewModel, onSheet: (Sheet) -> Unit) {
    val items = mail.mainItems.filter { it.id in mail.selection }
    val anyUnread = items.any { it.unread }
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().statusBarsPadding().height(60.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = mail::clearSelection) { Icon(Icons.Filled.Close, "Cancel selection") }
        Text("${mail.selection.size}", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        IconButton(onClick = { mail.act("archive", mail.selection) }) { Icon(Icons.Filled.Archive, "Archive") }
        IconButton(onClick = { mail.act("delete", mail.selection) }) { Icon(Icons.Filled.Delete, "Delete") }
        IconButton(onClick = { mail.act(if (anyUnread) "read" else "unread", mail.selection) }) {
            Icon(if (anyUnread) Icons.Filled.MarkEmailRead else Icons.Filled.MarkEmailUnread, if (anyUnread) "Mark as read" else "Mark as unread")
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More actions") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Label as…") }, onClick = { menu = false; onSheet(Sheet.Label) })
                DropdownMenuItem(text = { Text("Snooze…") }, onClick = { menu = false; onSheet(Sheet.Snooze) })
                DropdownMenuItem(text = { Text("Move to…") }, onClick = { menu = false; onSheet(Sheet.Move) })
                DropdownMenuItem(text = { Text("Select all") }, onClick = { menu = false; mail.selectAll(mail.main) })
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SelectionSheets(mail: MailViewModel, sheet: Sheet, close: () -> Unit) {
    ModalBottomSheet(onDismissRequest = close) {
        Column(Modifier.padding(bottom = 24.dp).navigationBarsPadding()) {
            when (sheet) {
                Sheet.Label -> {
                    SheetTitle("Label as")
                    if (mail.labels.isEmpty()) Text("You have no labels yet. Create them in the web app.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    mail.labels.forEach { l ->
                        SheetRow(l.name, dotColor = parseColor(l.color, MaterialTheme.colorScheme.primary)) {
                            mail.act("label", mail.selection, value = l.id.toLong()); close()
                        }
                    }
                }
                Sheet.Snooze -> {
                    SheetTitle("Snooze until")
                    SnoozePreset.entries.forEach { p ->
                        SheetRow(p.title) { mail.act("snooze", mail.selection, value = mail.snoozeUntil(p)); close() }
                    }
                }
                Sheet.Move -> {
                    SheetTitle("Move to")
                    mail.folders.filter { it.id != mail.folder && it.role in MOVE_ROLES }.forEach { f ->
                        SheetRow(f.name) { mail.act("move", mail.selection, target = f.id); close() }
                    }
                }
            }
        }
    }
}

private val MOVE_ROLES = setOf("inbox", "archive", "junk", "trash")

@Composable private fun SheetTitle(t: String) = Text(t, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp))

@Composable
private fun SheetRow(text: String, dotColor: Color? = null, trailing: String? = null, problem: Boolean = false, selected: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dotColor != null) { Box(Modifier.size(14.dp).clip(CircleShape).background(dotColor)); Spacer(Modifier.width(16.dp)) }
        Column(Modifier.weight(1f)) {
            val parts = text.split("\n", limit = 2)
            Text(parts[0], maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (parts.size > 1) Text(parts[1], style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (problem) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(ProblemRed).semantics { contentDescription = "Sync problem" })
            Spacer(Modifier.width(10.dp))
        }
        if (trailing != null) Text(trailing, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScopeSheet(mail: MailViewModel) {
    val ov = mail.overview
    ModalBottomSheet(onDismissRequest = { mail.pickerOpen = false }) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 24.dp).navigationBarsPadding()) {
            fun pick(s: String) { mail.pickerOpen = false; if (s != mail.scopeId) mail.chooseScope(s) }
            SheetRow("All mailboxes", MaterialTheme.colorScheme.primary, ov?.unifiedUnread?.takeIf { it > 0 }?.let { Format.count(it) }, selected = mail.scopeId == MailQuery.UNIFIED) { pick(MailQuery.UNIFIED) }
            if (!ov?.categories.isNullOrEmpty()) {
                SheetHeader("Categories")
                ov!!.categories.forEach { c ->
                    SheetRow(c.name, parseColor(c.color, MaterialTheme.colorScheme.primary), c.unread.takeIf { it > 0 }?.let { Format.count(it) }, selected = mail.scopeId == "category:${c.id}") { pick("category:${c.id}") }
                }
            }
            if (!ov?.mailboxes.isNullOrEmpty()) {
                SheetHeader("Mailboxes")
                ov!!.mailboxes.filter { it.enabled }.forEach { m ->
                    SheetRow("${m.name}\n${m.email}", parseColor(m.color, MaterialTheme.colorScheme.primary), m.unread.takeIf { it > 0 }?.let { Format.count(it) },
                        problem = m.id in mail.problemAccounts, selected = mail.scopeId == "account:${m.id}") { pick("account:${m.id}") }
                }
            }
            if (ov == null) Text("Couldn't load your mailboxes.", Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable private fun SheetHeader(t: String) = Text(t, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 24.dp, top = 16.dp, bottom = 4.dp))

// ---------------------------------------------------------------- the list

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun EmailList(
    mail: MailViewModel, model: ListModel, items: List<ApiEmail>, status: ListStatus,
    onRefresh: () -> Unit, onMore: () -> Unit, summary: String?, empty: String,
) {
    val state = rememberLazyListState()
    val showDot = mail.showMailboxDot
    val labelById = remember(mail.labels) { mail.labels.associateBy { it.id } }
    val loading = status == ListStatus.Loading
    LaunchedEffect(state, model) {
        snapshotFlow { (state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) to state.layoutInfo.totalItemsCount }.collectLatest { (last, count) ->
            if (count > 0 && last >= count - 8) onMore()
        }
    }
    PullToRefreshBox(isRefreshing = loading && model.loaded && items.isNotEmpty(), onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(state = state, modifier = Modifier.fillMaxSize()) {
            // a stable first item: rows inserted below it must not scroll a list that sits at the top
            item(key = "top") { Spacer(Modifier.height(1.dp)) }
            if (summary != null) item(key = "summary") {
                Text(summary, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(items, key = { it.id }) { e ->
                EmailRow(e, mail, showDot, labelById)
            }
            item(key = "footer") {
                when {
                    status is ListStatus.Error -> ErrorBlock(status.message, onRefresh)
                    loading && items.isEmpty() -> Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading" }) }
                    loading -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
                    model.loaded && items.isEmpty() -> Text(empty, Modifier.fillMaxWidth().padding(48.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    model.loaded && !model.endReached -> Text("Showing ${Format.count(items.size)} of ${Format.count(model.total)}", Modifier.fillMaxWidth().padding(16.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    else -> Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

@Composable
private fun ErrorBlock(message: String, retry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, color = MaterialTheme.colorScheme.error, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.semantics { contentDescription = "Error: $message" })
        Spacer(Modifier.height(12.dp))
        Button(onClick = retry) { Text("Retry") }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun EmailRow(e: ApiEmail, mail: MailViewModel, showDot: Boolean, labelById: Map<Int, ApiLabel>) {
    val selecting = mail.selection.isNotEmpty()
    val selected = e.id in mail.selection
    val right = mail.swipeRight
    val left = mail.swipeLeft
    // the state remembers its first lambda, so read the current row and settings through these
    val rowNow by rememberUpdatedState(e)
    val rightNow by rememberUpdatedState(right)
    val leftNow by rememberUpdatedState(left)
    val dismiss = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
        val a = when (v) { SwipeToDismissBoxValue.StartToEnd -> rightNow; SwipeToDismissBoxValue.EndToStart -> leftNow; else -> SwipeAction.None }
        val bulk = a.bulkFor(rowNow)
        if (bulk != null) mail.act(bulk, setOf(rowNow.id))
        bulk != null && a.removesRow // read/star keep the row, so it springs back
    })
    SwipeToDismissBox(
        state = dismiss,
        enableDismissFromStartToEnd = !selecting && right != SwipeAction.None,
        enableDismissFromEndToStart = !selecting && left != SwipeAction.None,
        backgroundContent = {
            val toRight = dismiss.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            val a = if (toRight) right else left
            Box(
                Modifier.fillMaxSize().background(if (a == SwipeAction.Delete) ProblemRed else MaterialTheme.colorScheme.primary).padding(horizontal = 24.dp),
                contentAlignment = if (toRight) Alignment.CenterStart else Alignment.CenterEnd,
            ) {
                val icon = when (a) {
                    SwipeAction.Archive -> Icons.Filled.Archive
                    SwipeAction.Delete -> Icons.Filled.Delete
                    SwipeAction.ToggleRead -> if (e.unread) Icons.Filled.MarkEmailRead else Icons.Filled.MarkEmailUnread
                    SwipeAction.Star -> Icons.Filled.Star
                    SwipeAction.None -> Icons.Filled.Archive
                }
                Icon(icon, a.title, tint = Color.White)
            }
        },
    ) {
        val bold = if (e.unread) FontWeight.Bold else FontWeight.Normal
        val bg = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background
        Row(
            Modifier.fillMaxWidth().background(bg)
                .combinedClickable(onClick = { if (selecting) mail.toggle(e.id) else mail.open(e) }, onLongClick = { mail.startSelect(e.id) })
                .padding(horizontal = 16.dp, vertical = 10.dp)
                .semantics { contentDescription = rowDescription(e) },
            verticalAlignment = Alignment.Top,
        ) {
            Avatar(e, selected)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (showDot && e.accountColor.isNotEmpty()) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(parseColor(e.accountColor, MaterialTheme.colorScheme.primary)))
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(e.sender, fontWeight = bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(8.dp))
                    Text(Format.time(e.receivedAt), style = MaterialTheme.typography.labelMedium, fontWeight = bold,
                        color = if (e.unread) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(e.subject.ifBlank { "(no subject)" }, fontWeight = bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    if (e.hasAttachment) Icon(Icons.Filled.AttachFile, "Has an attachment", Modifier.size(16.dp).padding(start = 2.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(e.preview, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    IconButton(onClick = { mail.act(if (e.starred) "unstar" else "star", setOf(e.id)) }, modifier = Modifier.size(32.dp)) {
                        Icon(if (e.starred) Icons.Filled.Star else Icons.Filled.StarBorder, if (e.starred) "Starred. Tap to unstar" else "Not starred. Tap to star",
                            tint = if (e.starred) Color(0xFFF4B400) else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                val chips = e.labelIds.mapNotNull { labelById[it] }
                if (chips.isNotEmpty()) Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    chips.take(3).forEach { l ->
                        val c = parseColor(l.color, MaterialTheme.colorScheme.primary)
                        Text(l.name, color = c, style = MaterialTheme.typography.labelSmall, maxLines = 1,
                            modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(c.copy(alpha = 0.14f)).padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                }
            }
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
}

private fun rowDescription(e: ApiEmail) =
    "${if (e.unread) "Unread. " else ""}From ${e.sender}. ${e.subject.ifBlank { "No subject" }}. ${Format.time(e.receivedAt)}.${if (e.hasAttachment) " Has an attachment." else ""}${if (e.starred) " Starred." else ""}"

@Composable
private fun Avatar(e: ApiEmail, selected: Boolean) {
    val palette = listOf(0xFF1E88E5, 0xFF8E24AA, 0xFF00897B, 0xFFF4511E, 0xFF6D4C41, 0xFF3949AB, 0xFF7CB342, 0xFFD81B60)
    val c = Color(palette[(e.from.firstOrNull()?.email.orEmpty().hashCode().and(0x7fffffff)) % palette.size])
    Box(Modifier.size(40.dp).clip(CircleShape).background(if (selected) MaterialTheme.colorScheme.primary else c), contentAlignment = Alignment.Center) {
        if (selected) Icon(Icons.Filled.Check, "Selected", tint = Color.White)
        else Text(Format.initial(e.sender), color = Color.White, fontWeight = FontWeight.Bold)
    }
}

// ---------------------------------------------------------------- search

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(mail: MailViewModel, onSheet: (Sheet) -> Unit) {
    BackHandler { if (mail.selection.isNotEmpty()) mail.clearSelection() else mail.closeSearch() }
    val focus = remember { FocusRequester() }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var contacts by remember { mutableStateOf<List<ApiContactSuggestion>>(emptyList()) }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(mail.searchText) {
        val last = mail.searchText.trim().substringAfterLast(' ')
        if (mail.searched || last.length < 2 || last.contains(':')) { contacts = emptyList(); return@LaunchedEffect }
        delay(250)
        val app = ctx.applicationContext as SeamlessApp
        val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { app.api.suggestContacts(app.session.serverUrl, last) }
        contacts = (r as? ApiResult.Ok)?.value.orEmpty().take(5)
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize()) {
            if (mail.selection.isNotEmpty()) {
                SelectionBar(mail, onSheet)
            } else Row(Modifier.fillMaxWidth().statusBarsPadding().height(60.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = mail::closeSearch) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                androidx.compose.foundation.text.BasicTextField(
                    value = mail.searchText, onValueChange = { mail.searchText = it; if (mail.searched) mail.markEditing() },
                    singleLine = true, modifier = Modifier.weight(1f).focusRequester(focus).semantics { contentDescription = "Search mail" },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onBackground),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { mail.runSearch() }),
                    decorationBox = { inner -> Box { if (mail.searchText.isEmpty()) Text("Search mail", color = MaterialTheme.colorScheme.onSurfaceVariant); inner() } },
                )
                if (mail.searchText.isNotEmpty()) IconButton(onClick = { mail.searchText = ""; mail.markEditing() }) { Icon(Icons.Filled.Clear, "Clear search") }
                IconButton(onClick = { mail.searchOptionsOpen = true }) { Icon(Icons.Filled.Tune, "Search options") }
            }
            HorizontalDivider()
            if (mail.searched) {
                val total = mail.results.total
                EmailList(
                    mail, mail.results, mail.resultItems, mail.resultStatus,
                    onRefresh = { mail.runSearch(mail.searchText) }, onMore = mail::loadMoreResults,
                    summary = if (mail.results.loaded) Format.results(total) else null, empty = "No mail matches that search",
                )
            } else SearchSuggestions(mail, contacts)
        }
    }
    if (mail.searchOptionsOpen) SearchOptionsSheet(mail)
}

@Composable
private fun SearchSuggestions(mail: MailViewModel, contacts: List<ApiContactSuggestion>) {
    val typed = mail.searchText.trim()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        if (typed.isNotEmpty()) SheetRow("Search for “$typed”") { mail.runSearch() }
        contacts.forEach { c ->
            SheetRow("${c.name.ifBlank { c.email }}\n${c.email}") { mail.runSearch("from:${c.email}") }
        }
        if (typed.isEmpty() && mail.recent.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Recent searches", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                TextButton(onClick = mail::clearRecent) { Text("Clear") }
            }
            mail.recent.forEach { r -> SheetRow(r) { mail.runSearch(r) } }
        }
        SheetHeader("Try")
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("is:unread", "has:attachment", "is:starred", "newer_than:7d", "from:", "subject:").forEach { op ->
                AssistChip(onClick = { if (op.endsWith(":")) mail.searchText = (typed + " " + op).trim() else mail.runSearch((typed + " " + op).trim()) }, label = { Text(op) })
            }
        }
        if (mail.labels.isNotEmpty()) {
            SheetHeader("Labels")
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                mail.labels.take(20).forEach { l ->
                    AssistChip(onClick = { mail.runSearch("label:" + if (l.name.contains(' ')) "\"${l.name}\"" else l.name) }, label = { Text(l.name) })
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchOptionsSheet(mail: MailViewModel) {
    var o by remember { mutableStateOf(SearchOptions()) }
    ModalBottomSheet(onDismissRequest = { mail.searchOptionsOpen = false }) {
        Column(Modifier.verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 24.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Search options", style = MaterialTheme.typography.titleMedium)
            OptField("From", o.from) { o = o.copy(from = it) }
            OptField("To", o.to) { o = o.copy(to = it) }
            OptField("Subject", o.subject) { o = o.copy(subject = it) }
            OptField("Has the words", o.words) { o = o.copy(words = it) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Has attachment", Modifier.weight(1f)); Switch(o.hasAttachment, { o = o.copy(hasAttachment = it) })
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = o.sizeOver, onClick = { o = o.copy(sizeOver = true) }, label = { Text("Larger than") })
                FilterChip(selected = !o.sizeOver, onClick = { o = o.copy(sizeOver = false) }, label = { Text("Smaller than") })
                OutlinedTextField(o.sizeMb, { o = o.copy(sizeMb = it) }, label = { Text("MB") }, singleLine = true, modifier = Modifier.width(96.dp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(o.after, { o = o.copy(after = it) }, label = { Text("After (YYYY-MM-DD)") }, singleLine = true, modifier = Modifier.weight(1f))
                OutlinedTextField(o.before, { o = o.copy(before = it) }, label = { Text("Before") }, singleLine = true, modifier = Modifier.weight(1f))
            }
            Button(onClick = { mail.searchOptionsOpen = false; mail.applyOptions(o) }, enabled = o.toQuery().isNotEmpty(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Search") }
        }
    }
}

@Composable
private fun OptField(label: String, value: String, onChange: (String) -> Unit) =
    OutlinedTextField(value, onChange, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth())
