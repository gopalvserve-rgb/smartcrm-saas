package app.leadcrm.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * OUTGOING_CARD_v1 (2026-05-31) - Runo-style card shown on outgoing call.
 *
 * Sibling of [IncomingCallActivity]. Same architecture: a transparent
 * Activity over whatever is on-screen (usually the OEM dialer), rendering
 * a Material card with customer name + status + last remark.
 *
 * Kill switch: SharedPreferences key "outgoing_card_enabled".
 *   "1" or missing = enabled (default ON)
 *   "0"            = disabled (Activity finishes immediately)
 *
 * Auto-dismiss: 45 s, or when the user taps the ✕, or on deeplink tap.
 *
 * Why a separate class (vs. a flag on IncomingCallActivity)?
 *   IncomingCallActivity is marked `singleInstance` + `noHistory` so an
 *   in-flight incoming card isn't replaced by an outgoing one (and vice
 *   versa). Keeping them as distinct Activities keeps the two task
 *   stacks independent on every OEM.
 */
class OutgoingCallActivity : Activity() {
    companion object {
        private const val TAG = "LeadCRM/OutCard"
        private const val PREFS = "leadcrm"
        private const val KEY_ENABLED = "outgoing_card_enabled"
        private const val AUTO_DISMISS_MS = 45_000L

        const val EXTRA_PHONE = "phone"

        fun newIntent(ctx: Context, phone: String): Intent {
            return Intent(ctx, OutgoingCallActivity::class.java).apply {
                putExtra(EXTRA_PHONE, phone)
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                            or Intent.FLAG_ACTIVITY_NO_HISTORY
                            or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
            }
        }

        @JvmStatic
        fun isEnabled(ctx: Context): Boolean {
            val v = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_ENABLED, "1")
            return v != "0"
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val autoDismiss = Runnable { safeFinish("auto-dismiss") }
    private var phone: String = ""
    private var bodyContainer: LinearLayout? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!isEnabled(this)) {
            Log.d(TAG, "outgoing card disabled by user setting")
            finish()
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            try {
                val km = getSystemService(Context.KEYGUARD_SERVICE) as? android.app.KeyguardManager
                km?.requestDismissKeyguard(this, null)
            } catch (_: Exception) {}
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                        or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(0x99000000.toInt()))
        window.addFlags(
            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                    or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        )

        phone = intent?.getStringExtra(EXTRA_PHONE).orEmpty()

        setContentView(buildRoot())
        mainHandler.postDelayed(autoDismiss, AUTO_DISMISS_MS)

        fetchLeadAsync(phone)
    }


    /** CALL_CARD_STALE_PHONE_FIX_v1: this Activity is singleInstance, so a second
     *  call while the previous card is still on screen (within the 45s auto-dismiss
     *  window) routes to onNewIntent rather than onCreate. Without this override the
     *  card stays stuck on the previous caller. Re-read the phone, reset the body,
     *  and re-fetch the lead. */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val newPhone = intent?.getStringExtra(EXTRA_PHONE).orEmpty()
        if (newPhone.isEmpty() || newPhone == phone) return
        phone = newPhone
        setIntent(intent)
        // Reset the auto-dismiss timer for the new call.
        mainHandler.removeCallbacks(autoDismiss)
        mainHandler.postDelayed(autoDismiss, AUTO_DISMISS_MS)
        bodyContainer?.let { renderUnknown(it, looking = true) }
        fetchLeadAsync(phone)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(autoDismiss)
        super.onDestroy()
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun buildRoot(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(16), dp(16), dp(16))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(20).toFloat()
            }
            setPadding(dp(20), dp(18), dp(20), dp(20))
            elevation = dp(8).toFloat()
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val title = TextView(this).apply {
            text = "📤 Outgoing call"
            setTextColor(Color.parseColor("#475569"))
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        // Close (✕) button — large hit-area circle so it doesn't ghost-tap on Vivo/Oppo.
        val closeBtn = TextView(this).apply {
            text = "✕"
            setTextColor(Color.parseColor("#0f172a"))
            textSize = 22f
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(8), dp(16), dp(8))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#f1f5f9"))
                cornerRadius = dp(22).toFloat()
            }
            setOnClickListener {
                Log.d(TAG, "close tapped")
                safeFinish("user-close")
            }
            isClickable = true
            isFocusable = true
        }
        header.addView(title)
        header.addView(closeBtn)
        card.addView(header)

        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(12), 0, 0)
        }
        card.addView(body)
        bodyContainer = body

        renderUnknown(body, looking = true)

        root.addView(card)
        return root
    }

    private fun renderUnknown(body: LinearLayout, looking: Boolean) {
        body.removeAllViews()

        body.addView(TextView(this).apply {
            text = phone.ifEmpty { "Unknown number" }
            setTextColor(Color.parseColor("#0f172a"))
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })

        body.addView(TextView(this).apply {
            text = if (looking) "🔍 Looking up in CRM…" else "⚠️ No customer data found in CRM"
            setTextColor(Color.parseColor("#64748b"))
            textSize = 14f
            setPadding(0, dp(10), 0, dp(14))
        })

        body.addView(makeButton("+ Add to CRM", primary = true) {
            openDeeplink("/#/leads?new=1&phone=" + Uri.encode(phone))
        })
    }

    private fun renderKnown(body: LinearLayout, name: String, status: String, remark: String, leadId: Long) {
        body.removeAllViews()

        body.addView(TextView(this).apply {
            text = name
            setTextColor(Color.parseColor("#0f172a"))
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })

        body.addView(TextView(this).apply {
            text = "📞 $phone"
            setTextColor(Color.parseColor("#475569"))
            textSize = 14f
            setPadding(0, dp(4), 0, 0)
        })

        if (status.isNotEmpty()) {
            val pill = TextView(this).apply {
                text = "🏷  $status"
                setTextColor(Color.parseColor("#1e3a8a"))
                textSize = 13f
                setPadding(dp(10), dp(4), dp(10), dp(4))
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#dbeafe"))
                    cornerRadius = dp(12).toFloat()
                }
            }
            val wrap = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(10), 0, 0)
            }
            wrap.addView(pill)
            body.addView(wrap)
        }

        if (remark.isNotEmpty()) {
            body.addView(TextView(this).apply {
                text = "📝 $remark"
                setTextColor(Color.parseColor("#334155"))
                textSize = 14f
                setPadding(0, dp(10), 0, dp(14))
                maxLines = 3
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
        } else {
            body.addView(TextView(this).apply {
                text = ""
                setPadding(0, dp(10), 0, dp(14))
            })
        }

        body.addView(makeButton("Open in CRM", primary = true) {
            openDeeplink("/#/leads/$leadId")
        })
    }

    private fun makeButton(label: String, primary: Boolean, onTap: () -> Unit): TextView {
        return TextView(this).apply {
            text = label
            setTextColor(if (primary) Color.WHITE else Color.parseColor("#0f172a"))
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = GradientDrawable().apply {
                setColor(if (primary) Color.parseColor("#4f46e5") else Color.parseColor("#f1f5f9"))
                cornerRadius = dp(12).toFloat()
            }
            setOnClickListener {
                Log.d(TAG, "button '$label' tapped")
                onTap()
            }
            isClickable = true
            isFocusable = true
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
    }

    private fun fetchLeadAsync(phone: String) {
        if (phone.isBlank()) return
        Thread {
            try {
                val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val apiBase = prefs.getString("api_base", "").orEmpty()
                val token = prefs.getString("auth_token", "").orEmpty()
                if (apiBase.isEmpty() || token.isEmpty()) {
                    Log.w(TAG, "no creds - staying in unknown state")
                    mainHandler.post { bodyContainer?.let { renderUnknown(it, looking = false) } }
                    return@Thread
                }
                val url = URL(apiBase + "/api/lookup_lead_native?phone=" + Uri.encode(phone))
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = 6000
                conn.readTimeout = 6000
                if (conn.responseCode in 200..299) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val json = JSONObject(body)
                    val lead = json.optJSONObject("lead")
                    if (lead != null) {
                        val name = lead.optString("name", "")
                        val status = lead.optString("status", "")
                        val remark = lead.optString("last_remark", "")
                        val id = lead.optLong("id", 0L)
                        if (name.isNotEmpty() && id > 0) {
                            mainHandler.post {
                                bodyContainer?.let { renderKnown(it, name, status, remark, id) }
                            }
                            return@Thread
                        }
                    }
                }
                mainHandler.post { bodyContainer?.let { renderUnknown(it, looking = false) } }
            } catch (e: Exception) {
                Log.w(TAG, "lookup failed: ${e.message}")
                mainHandler.post { bodyContainer?.let { renderUnknown(it, looking = false) } }
            }
        }.start()
    }

    private fun openDeeplink(path: String) {
        try {
            val i = Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("deeplink", path)
            }
            startActivity(i)
        } catch (e: Exception) {
            Log.w(TAG, "deeplink failed: ${e.message}")
        }
        safeFinish("deeplink")
    }

    private fun safeFinish(reason: String) {
        try {
            Log.d(TAG, "finish - $reason")
            finish()
            overridePendingTransition(0, android.R.anim.fade_out)
        } catch (_: Exception) {}
    }
}
