package org.trackzero.listener;

import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

/** UI-independent boundary for a DAE-09 endpoint-encrypted live radio session. */
public final class RadioController {
    public enum State { STOPPED, CONNECTING, PLAYING, INTERRUPTED }
    public interface Session {
        void start() throws Exception;
        void close();
    }
    public interface Engine {
        CompletableFuture<Session> joinLive(String stationId);
    }

    private final Engine engine;
    private final Consumer<State> listener;
    private long epoch;
    private Session session;
    private boolean closeUncertain;
    private State state = State.STOPPED;

    public RadioController(Engine engine, Consumer<State> listener) {
        this.engine = Objects.requireNonNull(engine);
        this.listener = Objects.requireNonNull(listener);
    }
    public synchronized State state() { return state; }
    private void setState(State next) { state = next; listener.accept(next); }

    /** Playback starts only after an explicit user action; no item selection or seek API exists. */
    public synchronized void play(String stationId) {
        if (stationId == null || !stationId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"))
            throw new IllegalArgumentException("Invalid station ID");
        if (closeUncertain) { setState(State.INTERRUPTED); return; }
        stop();
        if (closeUncertain) return; // prior session may still be audible
        final long request = epoch;
        setState(State.CONNECTING);
        final CompletableFuture<Session> pending;
        try { pending = Objects.requireNonNull(engine.joinLive(stationId)); }
        catch (RuntimeException error) { setState(State.INTERRUPTED); return; }
        pending.whenComplete((joined, error) -> {
            synchronized (RadioController.this) {
                if (request != epoch) {
                    if (joined != null) { try { joined.close(); }
                        catch (RuntimeException ignored) { closeUncertain = true; stop(); } }
                    return;
                }
                if (error != null || joined == null) { setState(State.INTERRUPTED); return; }
                session = joined;
                try { joined.start(); setState(State.PLAYING); }
                catch (Exception failure) {
                    try { joined.close(); } catch (RuntimeException ignored) { closeUncertain = true; }
                    session = null; setState(State.INTERRUPTED);
                }
            }
        });
    }
    public synchronized void stop() {
        epoch++;
        Session closing = session;
        session = null;
        try {
            if (closing != null) closing.close();
            setState(closeUncertain ? State.INTERRUPTED : State.STOPPED);
        } catch (RuntimeException error) { closeUncertain = true; setState(State.INTERRUPTED); }
    }
}
