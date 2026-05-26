package app.leadcrm.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * CALL_OVERLAY_v1 (2026-05-25) — Runo-style call-card overlay drawn on top of
 * the system dialer when an outgoing call is placed from inside the CRM.
 *
 * Trigger: the SPA already calls LeadCRMNative.registerOutgoingCall(phone,
 * leadId, startedAt) right before every dial. We extend that hook to also
 * invoke CallOverlayManager.show() with the lead JSON so the overlay can
 * render name / last note / last call instantly without a server round-trip.
 *
 * Auto-dismiss: 45 seconds from show OR when the user taps the X. The
 * overlay is also wiped on app foreground (MainActivity.onResume).
 *
 * Requires SYSTEM_ALERT_WINDOW (granted via PermissionOnboardingActivity).
 * If the user revoked it, show() silently no-ops.
 *
 * Pure addition — does NOT touch PhoneStateReceiver / RecordingObserver /
 * RecordingsBackgroundSyncWorker / CallerIdPlugin.
 */
object CallOverlayManager {
    private const val TAG = "LeadCRM/Overlay"

    @Volatile private var currentView: View? = null
    @Volatile private var currentWm: WindowManager? = null   // CALL_OVERLAY_v5: cache the exact WM that added the view
    private val mainHandler = Handler(Looper.getMainLooper())
    private val autoDismiss = Runnable { hide(currentCtx) }
    private var currentCtx: Context? = null

    @JvmStatic
    fun show(ctx: Context, phone: String, leadJson: String?) {
        if (!canDrawOverlays(ctx)) {
            Log.w(TAG, "SYSTEM_ALERT_WINDOW not granted — overlay skipped")
            return
        }
        mainHandler.post {
            try {
                currentCtx = ctx.applicationContext
                hide(ctx) // dispose any stale overlay
                val view = buildOverlayView(ctx, phone, leadJson)
                // CALL_OVERLAY_v5: pull WindowManager from APPLICATION context so it
                // survives Activity lifecycle changes (e.g. dialer comes to front),
                // and CACHE the reference so hide() uses the same WM instance.
                val wm = ctx.applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                currentWm = wm
                val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else
                    @Suppress("DEPRECATION")
                    WindowManager.LayoutParams.TYPE_SYSTEM_ALERT
                // CALL_OVERLAY_v4: FLAG_NOT_FOCUSABLE was the culprit — on Vivo /
                // OriginOS it blocks click events from reaching child views inside
                // a WindowManager overlay. Replaced with FLAG_ALT_FOCUSABLE_IM
                // (keeps soft keyboard hidden) + FLAG_NOT_TOUCH_MODAL (touches
                // outside our card still reach the dialer below).
                val lp = WindowManager.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    type,
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        or WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM
                        or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT
                )
                lp.gravity = Gravity.TOP
                lp.y = dp(ctx, 72) // sit below the status bar / notch
                wm.addView(view, lp)
                currentView = view
                mainHandler.removeCallbacks(autoDismiss)
                mainHandler.postDelayed(autoDismiss, 45_000L)
                Log.d(TAG, "overlay shown for $phone")
            } catch (e: Exception) {
                Log.e(TAG, "show() failed: ${e.message}", e)
            }
        }
    }

    @JvmStatic
    fun hide(ctx: Context?) {
        mainHandler.post {
            val v = currentView
            if (v == null) {
                Log.d(TAG, "hide() called but no overlay attached")
                return@post
            }
            // CALL_OVERLAY_v5: visibility-hide FIRST — even if WM removal fails or
            // is delayed, the user sees the overlay disappear instantly.
            try { v.visibility = View.GONE } catch (_: Exception) {}

            // Try the cached WM first (the exact instance that added the view).
            // Fall back to deriving a fresh WM from the application context.
            val wm = currentWm
                ?: (ctx ?: currentCtx)?.applicationContext
                    ?.getSystemService(Context.WINDOW_SERVICE) as? WindowManager

            if (wm != null) {
                try {
                    if (v.isAttachedToWindow) {
                        wm.removeView(v)   // async, safer than removeViewImmediate
                        Log.d(TAG, "overlay removed via WM")
                    } else {
                        Log.d(TAG, "overlay was not attached; visibility-hidden only")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "WM removeView failed (view stays hidden via visibility): ${e.message}", e)
                }
            } else {
                Log.w(TAG, "no WindowManager available to remove overlay; visibility-hidden only")
            }
            currentView = null
            currentWm = null
        }
    }

    private fun canDrawOverlays(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx)

    @SuppressLint("SetTextI18n")
    private fun buildOverlayView(ctx: Context, phone: String, leadJson: String?): View {
        // Parse the lead JSON the SPA passed in. Falls back gracefully when null.
        var name = ""
        var status = ""
        var lastNote = ""
        var lastCallAt = ""
        var leadId = ""
        try {
            if (!leadJson.isNullOrBlank() && leadJson != "null") {
                val o = JSONObject(leadJson)
                name = o.optString("name", "")
                status = o.optString("status_name", "")
                lastNote = o.optString("last_note", "")
                lastCallAt = o.optString("last_call_at", "")
                leadId = o.optString("id", "")
            }
        } catch (e: Exception) { /* ignore */ }

        // Card container
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(ctx, 16), dp(ctx, 14), dp(ctx, 16), dp(ctx, 14))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(Color.WHITE)
                cornerRadius = dp(ctx, 14).toFloat()
                setStroke(dp(ctx, 1), 0xFFE5E7EB.toInt())
            }
            elevation = dp(ctx, 8).toFloat()
        }

        // CALL_OVERLAY_v2: top row = brand pill + explicit ✕ close button
        val topRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, dp(ctx, 4))
        }
        val brand = TextView(ctx).apply {
            text = "📞 SmartCRM"
            setTextColor(0xFF4F46E5.toInt())  // SmartCRM indigo
            textSize = 11f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        topRow.addView(brand)
        // CALL_OVERLAY_v3: real button-sized close target. The previous TextView
        // had a 14dp padding around a single ✕ character — too small for finger
        // tap on Vivo, and click events sometimes get absorbed by the parent
        // WindowManager layer. Now using a 44dp x 44dp clickable region with
        // an explicit isClickable + ripple-style background highlight.
        val closeBtn = TextView(ctx).apply {
            text = "✕"
            setTextColor(0xFF334155.toInt())   // darker for visibility
            textSize = 20f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            gravity = android.view.Gravity.CENTER
            isClickable = true
            isFocusable = true
            // 44x44dp Material-standard touch target — easy to hit
            layoutParams = LinearLayout.LayoutParams(dp(ctx, 44), dp(ctx, 44))
            // Light grey circular background so user sees it's a button
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFFF1F5F9.toInt())
                setStroke(dp(ctx, 1), 0xFFE2E8F0.toInt())
            }
            setOnClickListener {
                Log.d(TAG, "close button tapped → hiding overlay")
                hide(ctx)
            }
            // Belt-and-braces: also listen for touch in case onClick is being
            // swallowed by the WindowManager layer.
            setOnTouchListener { _, ev ->
                if (ev.action == android.view.MotionEvent.ACTION_UP) {
                    Log.d(TAG, "close button touched (UP) → hiding overlay")
                    hide(ctx)
                    true
                } else false
            }
        }
        topRow.addView(closeBtn)
        card.addView(topRow)

        // Phone number (always)
        val phoneTv = TextView(ctx).apply {
            text = phone
            setTextColor(0xFF0F172A.toInt())
            textSize = 17f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }
        card.addView(phoneTv)

        // Name + status row, or "No customer data found"
        if (name.isNotBlank()) {
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(ctx, 4), 0, 0)
            }
            val nameTv = TextView(ctx).apply {
                text = name
                setTextColor(0xFF334155.toInt())
                textSize = 14f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            row.addView(nameTv)
            if (status.isNotBlank()) {
                val pill = TextView(ctx).apply {
                    text = status
                    setTextColor(0xFF4F46E5.toInt())
                    textSize = 11f
                    setPadding(dp(ctx, 8), dp(ctx, 3), dp(ctx, 8), dp(ctx, 3))
                    background = GradientDrawable().apply {
                        shape = GradientDrawable.RECTANGLE
                        setColor(0x1A4F46E5)
                        cornerRadius = dp(ctx, 10).toFloat()
                    }
                }
                row.addView(pill)
            }
            card.addView(row)
            if (lastNote.isNotBlank()) {
                val noteTv = TextView(ctx).apply {
                    text = "📝 " + truncate(lastNote, 90)
                    setTextColor(0xFF475569.toInt())
                    textSize = 12f
                    setPadding(0, dp(ctx, 6), 0, 0)
                }
                card.addView(noteTv)
            }
            if (lastCallAt.isNotBlank()) {
                val callTv = TextView(ctx).apply {
                    text = "📞 Last call: $lastCallAt"
                    setTextColor(0xFF64748B.toInt())
                    textSize = 11f
                    setPadding(0, dp(ctx, 3), 0, 0)
                }
                card.addView(callTv)
            }
        } else {
            val noData = TextView(ctx).apply {
                text = "No customer data found"
                setTextColor(0xFF94A3B8.toInt())
                textSize = 13f
                setPadding(0, dp(ctx, 6), 0, 0)
            }
            card.addView(noData)
        }

        // Action button — opens the lead inside the CRM (or the dialer-add flow)
        val actionBtn = TextView(ctx).apply {
            text = if (name.isNotBlank()) "Open Lead in CRM" else "+ Add as Lead"
            setTextColor(Color.WHITE)
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(ctx, 12), dp(ctx, 10), dp(ctx, 12), dp(ctx, 10))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(0xFF4F46E5.toInt())
                cornerRadius = dp(ctx, 10).toFloat()
            }
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dp(ctx, 12)
            layoutParams = lp
            setOnClickListener {
                hide(ctx)
                try {
                    val i = Intent(ctx, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP
                        if (leadId.isNotBlank()) {
                            putExtra("open_lead_id", leadId)
                        } else {
                            putExtra("open_new_lead_phone", phone)
                        }
                    }
                    ctx.startActivity(i)
                } catch (e: Exception) {
                    Log.e(TAG, "tap action failed: ${e.message}")
                }
            }
        }
        card.addView(actionBtn)

        // CALL_OVERLAY_v4: long-press anywhere on the card also dismisses
        // (200ms threshold so a normal read-tap doesn't fire). The explicit ✕
        // button is the primary mechanism; this is a safety net.
        card.setOnLongClickListener {
            Log.d(TAG, "card long-pressed → hiding overlay")
            hide(ctx); true
        }

        // Wrap in a margin container so it doesn't kiss the screen edge
        val wrap = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(ctx, 12), 0, dp(ctx, 12), 0)
        }
        wrap.addView(card)
        return wrap
    }

    private fun dp(ctx: Context, v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(),
            ctx.resources.displayMetrics).toInt()

    private fun truncate(s: String, n: Int): String =
        if (s.length <= n) s else s.substring(0, n) + "…"
}
