package au.sam.seamless

import kotlinx.serialization.Serializable

/** Mirrors the pieces of `shared/types.ts` / `GET /api/me` the app uses. Unknown keys are ignored. */
@Serializable data class ServerBrand(val name: String = "Seamless", val version: String = "")

@Serializable data class ApiUser(val id: Int = 0, val email: String = "", val name: String = "", val role: String = "user")

@Serializable data class MeResponse(
    val needsSetup: Boolean = false,
    val loggedIn: Boolean = false,
    val user: ApiUser? = null,
    val mode: String = "live",
    val modeLocked: Boolean = false,
    val server: ServerBrand? = null,
    val mustChangePassword: Boolean = false,
    val mfaEnrollRequired: Boolean = false,
    val settings: kotlinx.serialization.json.JsonObject? = null,
)

@Serializable data class LoginRequest(val email: String, val password: String)

@Serializable data class MfaRequest(val mfaToken: String, val code: String)

@Serializable data class LoginResponse(
    val ok: Boolean = false,
    val mfaRequired: Boolean = false,
    val mfaToken: String = "",
    val usedRecoveryCode: Boolean = false,
)

@Serializable data class ErrorBody(val error: String = "")

/** Mobile-config (T9.1); only the fields the skeleton reads. */
@Serializable data class MobileConfig(
    val pushEnabled: Boolean = false,
    val appMinVersion: String = "0.1.0",
    val serverVersion: String = "",
    val mode: String = "live",
)
