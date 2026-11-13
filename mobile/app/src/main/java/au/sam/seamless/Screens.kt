package au.sam.seamless

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
fun AppRoot(vm: AppViewModel) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when (vm.screen) {
            Screen.Splash -> SplashScreen(vm)
            Screen.Login -> LoginScreen(vm)
            Screen.Home -> HomeScreen(vm)
        }
    }
}

@Composable
private fun Logo(size: Int = 72) {
    Box(
        Modifier.size(size.dp).clip(RoundedCornerShape((size / 4).dp)).background(MaterialTheme.colorScheme.primary)
            .semantics { contentDescription = "Seamless" },
        contentAlignment = Alignment.Center,
    ) { Text("S", color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.headlineMedium) }
}

@Composable
fun SplashScreen(vm: AppViewModel) {
    Column(Modifier.fillMaxSize().systemBarsPadding().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Logo()
        Spacer(Modifier.height(24.dp))
        val err = vm.splashError
        if (err == null) {
            CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading" })
        } else {
            Text(err, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(16.dp))
            Button(onClick = vm::resume) { Text("Retry") }
            TextButton(onClick = vm::logout) { Text("Sign out") }
        }
    }
}

@Composable
fun LoginScreen(vm: AppViewModel) {
    Column(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Logo()
        Spacer(Modifier.height(16.dp))
        Text("Seamless", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            when (vm.step) {
                LoginStep.Address -> "Connect to your server"
                LoginStep.Password -> "Sign in"
                LoginStep.Code -> "Two-step check"
            },
            style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))

        when (vm.step) {
            LoginStep.Address -> {
                OutlinedTextField(
                    value = vm.address, onValueChange = { vm.address = it }, label = { Text("Server address") },
                    placeholder = { Text("mail.example.com") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { vm.check() }),
                )
                Spacer(Modifier.height(6.dp))
                Text("Use http only on your home network.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(16.dp))
                PrimaryButton("Check", vm.busy, vm::check)
            }
            LoginStep.Password -> {
                if (vm.serverLine != null || vm.address.isNotEmpty()) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            vm.serverLine?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary) }
                            Text(vm.address, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = vm::changeServer) { Text("Change") }
                    }
                    Spacer(Modifier.height(8.dp))
                }
                OutlinedTextField(
                    value = vm.email, onValueChange = { vm.email = it }, label = { Text("Email") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = vm.password, onValueChange = { vm.password = it }, label = { Text("Password") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { vm.signIn() }),
                )
                Spacer(Modifier.height(16.dp))
                PrimaryButton("Sign in", vm.busy, vm::signIn)
            }
            LoginStep.Code -> {
                Text(
                    if (vm.useRecovery) "Enter one of your recovery codes." else "Enter the 6-digit code from your authenticator app.",
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = vm.code, onValueChange = { vm.code = it },
                    label = { Text(if (vm.useRecovery) "Recovery code" else "Code") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = if (vm.useRecovery) KeyboardType.Ascii else KeyboardType.NumberPassword, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { vm.submitCode() }),
                )
                Spacer(Modifier.height(16.dp))
                PrimaryButton("Verify", vm.busy, vm::submitCode)
                TextButton(onClick = vm::toggleRecovery) { Text(if (vm.useRecovery) "Use an authenticator code" else "Use a recovery code") }
            }
        }

        vm.error?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()
                .semantics { contentDescription = "Error: $it" })
        }
    }
}

@Composable
private fun PrimaryButton(label: String, busy: Boolean, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
        if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        else Text(label)
    }
}
