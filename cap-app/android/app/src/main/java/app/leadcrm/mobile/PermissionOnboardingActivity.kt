package app.leadcrm.mobile

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * PERM_ONBOARDING_v1 (2026-05-25) — Runo-style permission onboarding screen.
 *
 * Walks the user through 9 permissions on first launch (and on demand from
 * the SPA via LeadCRMNative.openRecordingSetup()):
 *
 *   1. Calendar          — sync follow-ups (READ_CALENDAR, WRITE_CALENDAR)
 *   2. Location          — tag interactions (ACCESS_FINE_LOCATION)
 *   3. Notifications     — show real-time alerts (POST_NOTIFICATIONS, API 33+)
 *   4. Battery           — keep background workers alive (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
 *   5. Phone / Call Log  — track calls (READ_CALL_LOG, READ_PHONE_STATE, CALL_PHONE)
 *   6. Overlay           — caller-ID popup (SYSTEM_ALERT_WINDOW)
 *   7. All-Files-Access  — read recording folders (MANAGE_EXTERNAL_STORAGE)
 *   8. Recording Folder  — SAF tree URI for the call-recordings folder
 *   9. OEM Auto-start    — vendor-specific (Xiaomi/Vivo/Oppo/Honor/OnePlus)
 *
 * Each card has icon + WHY text + status pill. Tap → fires the right
 * intent/dialog. onResume() refreshes statuses so user can grant in
 * Settings and return without restarting.
 *
 * DOES NOT touch: RecordingsBackgroundSyncWorker, PhoneStateReceiver,
 * RecordingObserver, CallerIdPlugin. Pure addition. Existing
 * MainActivity.requestPermissions() runtime-perm batch flow unchanged.
 */
class PermissionOnboardingActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "LeadCRM/PermOnboard"
        const val PREFS = "leadcrm"
        const val KEY_ONBOARDING_DONE = "perm_onboarding_done"
        const val KEY_REC_FOLDER = "recording_folder_uri"
        private const val REQ_RUNTIME = 9101
        private const val REQ_PICK_FOLDER = 9202

        /** Caller decides whether onboarding is needed. */
        @JvmStatic
        fun shouldShow(ctx: Context): Boolean {
            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getBoolean(KEY_ONBOARDING_DONE, false)) {
                // Already shown — only re-show if a CRITICAL permission was revoked
                return !batteryOptIgnored(ctx) || !manageExternalStorageOk(ctx)
                        || prefs.getString(KEY_REC_FOLDER, null).isNullOrEmpty()
            }
            return true
        }

        fun batteryOptIgnored(ctx: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(ctx.packageName)
        }

        fun manageExternalStorageOk(ctx: Context): Boolean {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Environment.isExternalStorageManager()
            } else {
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
            }
        }
    }

    private data class PermCard(
        val key: String,
        val icon: String,        // emoji as icon
        val title: String,
        val why: String,
        val checkGranted: () -> Boolean,
        val onTap: () -> Unit,
        val critical: Boolean    // affects the Done button enable
    )

    private lateinit var cards: List<PermCard>
    private lateinit var listLayout: LinearLayout
    private lateinit var doneBtn: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildLayout())
        cards = buildCards()
        renderCards()
    }

    override fun onResume() {
        super.onResume()
        renderCards()  // status may have changed via Settings round-trip
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        renderCards()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_PICK_FOLDER && resultCode == Activity.RESULT_OK) {
            val uri = data?.data
            if (uri != null) {
                try {
                    val flags = (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                    contentResolver.takePersistableUriPermission(uri, flags)
                    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                        .putString(KEY_REC_FOLDER, uri.toString()).apply()
                } catch (e: Exception) {
                    Log.e(TAG, "takePersistableUriPermission: ${e.message}")
                }
            }
        }
        renderCards()
    }

    private fun buildLayout(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFFF7F8FA.toInt())
            // PERM_ONBOARDING_v1.2: let the system handle status-bar inset automatically
            fitsSystemWindows = true
        }
        // PERM_ONBOARDING_v1.2: status-bar inset on Vivo / Oppo / notch phones.
        // The v1.1 attempt used android:status_bar_height which returns the
        // basic 24dp value and ignores the display cutout. We now use a
        // WindowInsetsListener (true cutout + status bar) and start with a
        // generous static padding (dp(56)) so the title is visible BEFORE
        // the first inset callback fires.
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(20), dp(56), dp(20), dp(16))
            setBackgroundColor(0xFF4F46E5.toInt())  // SmartCRM brand indigo
        }
        // Apply the real top inset (status bar + cutout if any) once we know it.
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(header) { v, insets ->
            val sys = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.statusBars()
                    or androidx.core.view.WindowInsetsCompat.Type.displayCutout()
            )
            val top = if (sys.top > 0) sys.top + dp(12) else dp(56)
            v.setPadding(dp(20), top, dp(20), dp(16))
            insets
        }
        val title = TextView(this).apply {
            text = "App Permissions"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 18f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val skipBtn = TextView(this).apply {
            text = "Skip"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 14f
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setOnClickListener { finishOnboarding(false) }
        }
        header.addView(title)
        header.addView(skipBtn)
        root.addView(header)

        // Intro paragraph
        val intro = TextView(this).apply {
            text = "Grant these permissions so SmartCRM can sync your calls, recordings, follow-ups, and notifications reliably. Tap any row that's not yet green to grant it. You can change these later in your phone Settings."
            setTextColor(0xFF475569.toInt())
            textSize = 13f
            setPadding(dp(20), dp(16), dp(20), dp(8))
        }
        root.addView(intro)

        // Scrollable card list
        val scroll = android.widget.ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        listLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(4), dp(12), dp(80))
        }
        scroll.addView(listLayout)
        root.addView(scroll)

        // Done button (sticky bottom)
        doneBtn = TextView(this).apply {
            text = "Done"
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFF4F46E5.toInt())
            textSize = 16f
            gravity = android.view.Gravity.CENTER
            setPadding(dp(16), dp(16), dp(16), dp(16))
            setOnClickListener { finishOnboarding(true) }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                .also { (it as LinearLayout.LayoutParams).setMargins(dp(20), dp(8), dp(20), dp(20)) }
        }
        root.addView(doneBtn)

        return root
    }

    private fun buildCards(): List<PermCard> = listOf(
        PermCard(
            key = "calendar",
            icon = "📅",  // 📅
            title = "Calendar",
            why = "Sync your follow-up reminders to your phone calendar so you get timely alerts.",
            checkGranted = { hasPerm(Manifest.permission.READ_CALENDAR) && hasPerm(Manifest.permission.WRITE_CALENDAR) },
            onTap = { requestRuntime(arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)) },
            critical = false
        ),
        PermCard(
            key = "location",
            icon = "📍",  // 📍
            title = "Location",
            why = "Tag your check-in / check-out and lead interactions with location. You can turn this off any time.",
            checkGranted = { hasPerm(Manifest.permission.ACCESS_FINE_LOCATION) || hasPerm(Manifest.permission.ACCESS_COARSE_LOCATION) },
            onTap = { requestRuntime(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
            critical = false
        ),
        PermCard(
            key = "notifications",
            icon = "🔔",  // 🔔
            title = "Notifications",
            why = "Show real-time alerts for new leads, WhatsApp messages, follow-ups, and chat assignments.",
            checkGranted = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                    hasPerm(Manifest.permission.POST_NOTIFICATIONS) else true
            },
            onTap = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                    requestRuntime(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                else openAppNotificationSettings()
            },
            critical = true
        ),
        PermCard(
            key = "battery",
            icon = "🔋",  // 🔋
            title = "Battery (Unrestricted)",
            why = "Keep recording sync, call tracking, and notifications running in the background. Without this, the app stops working after 1-2 hours of phone idle.",
            checkGranted = { batteryOptIgnored(this) },
            onTap = { openBatteryOptDialog() },
            critical = true
        ),
        PermCard(
            key = "phone",
            icon = "📞",  // 📞
            title = "Phone & Call Logs",
            why = "Track incoming and outgoing calls, auto-create leads from missed calls, and attach call recordings to the right lead.",
            checkGranted = {
                hasPerm(Manifest.permission.READ_CALL_LOG) &&
                hasPerm(Manifest.permission.READ_PHONE_STATE)
            },
            onTap = { requestRuntime(arrayOf(
                Manifest.permission.READ_CALL_LOG,
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.CALL_PHONE
            )) },
            critical = true
        ),
        PermCard(
            key = "overlay",
            icon = "👤",  // 👤
            title = "Overlay (Appear on top)",
            why = "Show caller-ID popup with lead name, last note, and last call date when your phone rings.",
            checkGranted = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                    Settings.canDrawOverlays(this) else true
            },
            onTap = { openOverlaySettings() },
            critical = false
        ),
        PermCard(
            key = "allfiles",
            icon = "📂",  // 📂
            title = "All Files Access",
            why = "Required to read call recordings from your phone's storage folders (Samsung, Xiaomi, Vivo, Oppo, etc.).",
            checkGranted = { manageExternalStorageOk(this) },
            onTap = { openAllFilesAccessSettings() },
            critical = true
        ),
        PermCard(
            key = "recfolder",
            icon = "🎤",  // 🎤
            title = "Select Recording Folder",
            why = "Pick the folder where your phone saves call recordings. The CRM auto-syncs new files from this folder.",
            checkGranted = {
                !getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_REC_FOLDER, null).isNullOrEmpty()
            },
            onTap = { openFolderPicker() },
            critical = true
        ),
        PermCard(
            key = "autostart",
            icon = "🚀",  // 🚀
            title = "Auto-start (${Build.MANUFACTURER.uppercase()})",
            why = "On Xiaomi / Vivo / Oppo / Honor phones, enable auto-start so background workers survive overnight. We open your phone's vendor settings — find SmartCRM and toggle it on.",
            checkGranted = { false },  // we can't programmatically check; treat as always-needs-attention
            onTap = { openVendorAutoStart() },
            critical = false
        )
    )

    private fun renderCards() {
        listLayout.removeAllViews()
        var allCriticalGranted = true
        for (card in cards) {
            val granted = try { card.checkGranted() } catch (_: Exception) { false }
            if (card.critical && !granted) allCriticalGranted = false
            listLayout.addView(buildCardView(card, granted))
        }
        doneBtn.alpha = if (allCriticalGranted) 1.0f else 0.55f
    }

    private fun buildCardView(card: PermCard, granted: Boolean): View {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(0xFFFFFFFF.toInt())
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).also { (it as LinearLayout.LayoutParams).setMargins(0, dp(6), 0, 0) }
            setOnClickListener {
                try { card.onTap() } catch (e: Exception) { Log.e(TAG, "tap ${card.key}: ${e.message}") }
            }
        }
        val iconBox = TextView(this).apply {
            text = card.icon
            textSize = 22f
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setBackgroundColor(0xFFFEF2F2.toInt())  // light red bg matching Runo
        }
        container.addView(iconBox, LinearLayout.LayoutParams(dp(46), dp(46)).apply { setMargins(0, 0, dp(12), 0) })

        val textCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val titleRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val titleTv = TextView(this).apply {
            text = card.title
            textSize = 15f
            setTextColor(0xFF0F172A.toInt())
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }
        val statusTv = TextView(this).apply {
            textSize = 11f
            setPadding(dp(8), dp(2), dp(8), dp(2))
            if (granted) {
                text = "✓ Granted"
                setTextColor(0xFF065F46.toInt())
                setBackgroundColor(0xFFD1FAE5.toInt())
            } else if (card.key == "autostart") {
                text = "Tap to open"
                setTextColor(0xFF1E40AF.toInt())
                setBackgroundColor(0xFFDBEAFE.toInt())
            } else {
                text = "⚠ Needed"
                setTextColor(0xFF92400E.toInt())
                setBackgroundColor(0xFFFEF3C7.toInt())
            }
        }
        titleRow.addView(titleTv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8) })
        titleRow.addView(statusTv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val whyTv = TextView(this).apply {
            text = card.why
            textSize = 12f
            setTextColor(0xFF64748B.toInt())
            setPadding(0, dp(4), 0, 0)
        }
        textCol.addView(titleRow)
        textCol.addView(whyTv)
        container.addView(textCol)
        return container
    }

    // ---- Permission action helpers --------------------------------------

    private fun hasPerm(p: String): Boolean =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun requestRuntime(perms: Array<String>) {
        val missing = perms.filter { !hasPerm(it) }.toTypedArray()
        if (missing.isEmpty()) return
        androidx.core.app.ActivityCompat.requestPermissions(this, missing, REQ_RUNTIME)
    }

    private fun openBatteryOptDialog() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !batteryOptIgnored(this)) {
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(i)
            }
        } catch (e: Exception) {
            // Fallback: open the battery optimization list directly
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {}
        }
    }

    private fun openOverlaySettings() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val i = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
                startActivity(i)
            }
        } catch (e: Exception) { Log.e(TAG, "openOverlay: ${e.message}") }
    }

    private fun openAllFilesAccessSettings() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val i = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:$packageName"))
                startActivity(i)
            } else {
                requestRuntime(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE))
            }
        } catch (e: Exception) {
            try { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) } catch (_: Exception) {}
        }
    }

    private fun openAppNotificationSettings() {
        try {
            val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            startActivity(i)
        } catch (_: Exception) {}
    }

    private fun openFolderPicker() {
        try {
            val i = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            startActivityForResult(i, REQ_PICK_FOLDER)
        } catch (e: Exception) { Log.e(TAG, "folder picker: ${e.message}") }
    }

    /**
     * Open the vendor-specific auto-start manager. Each OEM hides this
     * setting differently. We try the known activity path, fall back to
     * app-info if it doesn't exist.
     */
    private fun openVendorAutoStart() {
        val manuf = Build.MANUFACTURER.lowercase()
        val tries: List<Pair<String, String>> = when {
            manuf.contains("xiaomi") || manuf.contains("redmi") || manuf.contains("poco") -> listOf(
                "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
                "com.miui.securitycenter" to "com.miui.appmanager.ApplicationsDetailsActivity"
            )
            manuf.contains("vivo") || manuf.contains("iqoo") -> listOf(
                "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
                "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
                "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"
            )
            manuf.contains("oppo") || manuf.contains("realme") -> listOf(
                "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
                "com.coloros.safecenter" to "com.coloros.privacypermissionsentry.PermissionTopActivity"
            )
            manuf.contains("huawei") || manuf.contains("honor") -> listOf(
                "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity"
            )
            manuf.contains("oneplus") -> listOf(
                "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"
            )
            manuf.contains("asus") -> listOf(
                "com.asus.mobilemanager" to "com.asus.mobilemanager.entry.FunctionActivity"
            )
            else -> emptyList()  // Samsung / Motorola / Pixel — no vendor-specific auto-start
        }
        var launched = false
        for ((pkg, cls) in tries) {
            try {
                val i = Intent().apply {
                    component = android.content.ComponentName(pkg, cls)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(i)
                launched = true
                break
            } catch (e: Exception) {
                Log.d(TAG, "vendor intent miss: $pkg/$cls — ${e.message}")
            }
        }
        if (!launched) {
            // Fallback: open the app's info page so user can find Battery / Auto-start
            try {
                val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:$packageName"))
                startActivity(i)
            } catch (_: Exception) {}
        }
    }

    private fun finishOnboarding(markDone: Boolean) {
        if (markDone) {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_ONBOARDING_DONE, true).apply()
        }
        setResult(if (markDone) Activity.RESULT_OK else Activity.RESULT_CANCELED)
        finish()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
