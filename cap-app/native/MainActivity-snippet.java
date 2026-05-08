// Drop this into android/app/src/main/java/<your-package>/MainActivity.java
// after `npx cap add android` generates the boilerplate.
//
// Capacitor's auto-generated MainActivity already extends BridgeActivity.
// We only need to register our custom plugin and handle the deeplink
// extra from the caller-ID notification tap.

package app.leadcrm.mobile;     // change to com.celesteabode.crm for Celeste

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register our caller-ID plugin so the bridge wires up the
        // CallerId.* JS API.
        registerPlugin(CallerIdPlugin.class);
        super.onCreate(savedInstanceState);
        handleDeeplink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeeplink(intent);
    }

    /**
     * The caller-ID notification embeds a `deeplink` extra (e.g.
     * "/#/leads?id=42"). When the rep taps the notification, we navigate
     * the wrapped web view to that route on top of whatever's loaded.
     */
    private void handleDeeplink(Intent intent) {
        if (intent == null) return;
        String deeplink = intent.getStringExtra("deeplink");
        if (deeplink == null || deeplink.isEmpty()) return;
        // Use Capacitor's bridge to hash-navigate the loaded SPA.
        // The CRM uses hash-based routing (#/leads, #/customers, etc.),
        // so we just need to dispatch a hashchange.
        getBridge().eval(
            "window.location.hash = '" + deeplink.replace("'", "\\'") + "'.replace(/^\\/?#/, '');",
            null
        );
    }
}
