package au.sam.seamless

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Accent = the web app's default theme (--color-accent #1867c0 light / #3d8de0 dark); neutrals like Gmail.
private val Light = lightColorScheme(
    primary = Color(0xFF1867C0), onPrimary = Color.White,
    primaryContainer = Color(0xFFE8F1FB), onPrimaryContainer = Color(0xFF12508F),
    background = Color.White, onBackground = Color(0xFF1F1F1F),
    surface = Color.White, onSurface = Color(0xFF1F1F1F),
    surfaceVariant = Color(0xFFEDF1F7), onSurfaceVariant = Color(0xFF444746),
    surfaceContainer = Color(0xFFF2F6FC), surfaceContainerHigh = Color(0xFFEAF1FB),
    outline = Color(0xFF747775), outlineVariant = Color(0xFFC4C7C5),
    error = Color(0xFFB3261E),
)
private val Dark = darkColorScheme(
    primary = Color(0xFF3D8DE0), onPrimary = Color.White,
    primaryContainer = Color(0xFF1B3150), onPrimaryContainer = Color(0xFF9CC8F5),
    background = Color(0xFF111418), onBackground = Color(0xFFE3E3E3),
    surface = Color(0xFF111418), onSurface = Color(0xFFE3E3E3),
    surfaceVariant = Color(0xFF2B2F36), onSurfaceVariant = Color(0xFFC4C7C5),
    surfaceContainer = Color(0xFF1B1F26), surfaceContainerHigh = Color(0xFF242932),
    outline = Color(0xFF8E918F), outlineVariant = Color(0xFF444746),
    error = Color(0xFFF2B8B5),
)

@Composable
fun SeamlessTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
}
