package app.bolsillo;

import android.app.ActivityManager;
import android.net.Uri;
import android.os.Bundle;

/**
 * One of your apps, opened from its home-screen shortcut (bolsillo://app/<id>).
 * Each app gets its own window in the recent-apps list, like a regular installed app.
 */
public class AppActivity extends WebActivity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String name = getIntent().getStringExtra("name");
        if (name != null) setTaskDescription(new ActivityManager.TaskDescription(name));
    }

    @Override
    protected String target() {
        Uri data = getIntent().getData();
        String id = data != null ? data.getLastPathSegment() : null;
        return id != null && id.matches("[a-z0-9-]+") ? "/launch/" + id : "/";
    }
}
