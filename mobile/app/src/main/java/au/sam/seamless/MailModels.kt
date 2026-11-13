package au.sam.seamless

import kotlinx.serialization.Serializable

/** Mirrors the pieces of `shared/src/types.ts` the mailbox screens use. Unknown keys are ignored. */
@Serializable data class ApiAddress(val name: String = "", val email: String = "")

@Serializable data class ApiEmail(
    val id: String,
    val threadId: String = "",
    val accountId: Int = 0,
    val accountColor: String = "",
    val mailboxId: String = "",
    val mailboxRole: String = "",
    val keywords: Map<String, Boolean> = emptyMap(),
    val labelIds: List<Int> = emptyList(),
    val from: List<ApiAddress> = emptyList(),
    val to: List<ApiAddress> = emptyList(),
    val cc: List<ApiAddress> = emptyList(),
    val replyTo: List<ApiAddress> = emptyList(),
    val messageId: String? = null,
    val subject: String = "",
    val preview: String = "",
    val receivedAt: String = "",
    val hasAttachment: Boolean = false,
    val snoozedUntil: String? = null,
    val risk: ApiRisk? = null,
) {
    val unread: Boolean get() = keywords["\$seen"] != true
    val starred: Boolean get() = keywords["\$flagged"] == true
    val sender: String get() = from.firstOrNull()?.let { it.name.ifBlank { it.email } } ?: "(unknown sender)"
}

@Serializable data class ApiRiskReason(val code: String = "", val severity: String = "medium", val text: String = "")

@Serializable data class ApiRisk(val level: String = "medium", val reasons: List<ApiRiskReason> = emptyList())

/** One page of a list: the total match count plus the rows, in the server's order. */
data class EmailPage(val total: Int, val emails: List<ApiEmail>)

@Serializable data class ApiMailbox(
    val id: String, val name: String = "", val role: String = "", val accountId: Int? = null,
    val totalEmails: Int = 0, val unreadEmails: Int = 0,
)

@Serializable data class ApiCategory(
    val id: Int, val key: String = "", val name: String = "", val color: String = "", val accountIds: List<Int> = emptyList(), val unread: Int = 0,
)

@Serializable data class ApiCategoryMailbox(
    val id: Int, val name: String = "", val email: String = "", val color: String = "", val enabled: Boolean = true, val unread: Int = 0,
)

@Serializable data class ApiCategoryOverview(
    val unifiedUnread: Int = 0,
    val categories: List<ApiCategory> = emptyList(),
    val mailboxes: List<ApiCategoryMailbox> = emptyList(),
)

/** Only what is needed to flag a mailbox with a sync problem. */
@Serializable data class ApiAccountStatus(val id: Int, val status: String = "ok", val lastError: String = "") {
    val hasProblem: Boolean get() = status == "error" || (lastError.isNotBlank() && status != "ok" && status != "connecting")
}

@Serializable data class ApiLabel(
    val id: Int, val name: String = "", val color: String = "", val parentId: Int? = null, val unread: Int = 0,
    val shared: Boolean = false, val sharedBy: String = "", val sidebarVisibility: String = "always",
)

@Serializable data class ApiOfferLabel(val id: Int, val name: String = "", val color: String = "")

/** Someone shared labels from their mailbox with me (`status`: pending | accepted | rejected). */
@Serializable data class ApiLabelOffer(
    val accountId: Int, val mailbox: String = "", val ownerName: String = "", val status: String = "pending",
    val count: Int = 0, val labels: List<ApiOfferLabel> = emptyList(), val hideBannerUntil: Long? = null,
)

@Serializable data class ApiServerSettings(val undoSendSeconds: Int = 10, val snoozeWakeOnReply: Boolean = true)

@Serializable data class ApiNotificationPrefs(val mutedAccountIds: List<Int> = emptyList())

@Serializable data class ApiIdentity(val email: String = "", val name: String = "", val accountId: Int = 0, val isDefault: Boolean = false, val isAlias: Boolean = false, val id: Int? = null, val bccSelf: Boolean = false)

@Serializable data class ApiSavedView(val id: Int, val name: String = "", val query: String = "", val scope: String = "unified", val pinned: Boolean = false)

@Serializable data class ApiAlert(val id: Int, val kind: String = "", val title: String = "", val body: String = "", val link: String? = null, val state: String = "open")

@Serializable data class AlertSummary(val items: List<ApiAlert> = emptyList())

@Serializable data class ModeResponse(val mode: String = "live")

@Serializable data class BulkResult(val affected: Int = 0, val undoToken: String? = null, val undoable: Boolean = false)

@Serializable data class BulkRequest(val ids: List<String>, val action: String, val value: kotlinx.serialization.json.JsonElement? = null)

@Serializable data class UndoRequest(val undoToken: String)

@Serializable data class ApiContactSuggestion(val name: String = "", val email: String = "")
