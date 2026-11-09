package org.trackzero.listener;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Minimal native listening controls. Production background playback needs a media service. */
public final class MainActivity extends Activity {
    private RadioController controller;
    private Button play;
    private Button stop;
    private TextView status;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(this);
        title.setText("TrackZero live radio");
        title.setTextSize(24);
        layout.addView(title);
        play = new Button(this); play.setText("Play live station"); layout.addView(play);
        stop = new Button(this); stop.setText("Stop"); layout.addView(stop);
        status = new TextView(this); status.setText("Stopped");
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        layout.addView(status);
        setContentView(layout);

        RadioController.Engine engine = getApplication() instanceof RadioEngineProvider
            ? ((RadioEngineProvider) getApplication()).radioEngine() : null;
        if (engine == null) {
            play.setEnabled(false); stop.setEnabled(false);
            status.setText("Live playback is unavailable");
            return;
        }
        controller = new RadioController(engine, state -> runOnUiThread(() -> {
            status.setText(state == RadioController.State.CONNECTING ? "Connecting to live radio" :
                state == RadioController.State.PLAYING ? "Playing live radio" :
                state == RadioController.State.INTERRUPTED ? "Playback interrupted" : "Stopped");
            play.setEnabled(state == RadioController.State.STOPPED || state == RadioController.State.INTERRUPTED);
            stop.setEnabled(state != RadioController.State.STOPPED);
        }), this::runOnUiThread);
        stop.setEnabled(false);
        // The station ID must come from the verified station catalog in the host application.
        String stationId = getIntent().getStringExtra("stationId");
        if (stationId == null) { play.setEnabled(false); status.setText("Choose a station"); }
        else play.setOnClickListener(view -> {
            try { controller.play(stationId); }
            catch (IllegalArgumentException error) { status.setText("Invalid station"); }
        });
        stop.setOnClickListener(view -> controller.stop());
    }
    @Override protected void onPause() {
        if (controller != null) controller.stop();
        super.onPause();
    }
    @Override protected void onDestroy() {
        if (controller != null) controller.stop();
        super.onDestroy();
    }
}
