package app.bolsillo;

import android.content.Intent;

/** Bolsillo itself: the store of your apps and the chat with Claude. */
public class MainActivity extends WebActivity {
    @Override
    protected String target() {
        return "/";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Coming back from the notification: if the server restarted meanwhile, reload.
        if (web.getUrl() == null || web.getUrl().startsWith("file:")) open();
    }
}
