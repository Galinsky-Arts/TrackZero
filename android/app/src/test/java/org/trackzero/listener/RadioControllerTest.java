package org.trackzero.listener;

import org.junit.Test;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public final class RadioControllerTest {
    private static final class FakeSession implements RadioController.Session {
        int starts, closes;
        public void start() { starts++; }
        public void close() { closes++; }
    }
    @Test public void explicitPlayAndStop() {
        FakeSession session = new FakeSession();
        List<RadioController.State> events = new ArrayList<>();
        RadioController controller = new RadioController(id -> CompletableFuture.completedFuture(session), events::add);
        assertEquals(RadioController.State.STOPPED, controller.state());
        controller.play("station-1");
        assertEquals(RadioController.State.PLAYING, controller.state());
        assertEquals(1, session.starts);
        controller.stop();
        assertEquals(1, session.closes);
        assertEquals(RadioController.State.STOPPED, controller.state());
    }
    @Test public void stopBeforeJoinPreventsLatePlayback() {
        CompletableFuture<RadioController.Session> future = new CompletableFuture<>();
        RadioController controller = new RadioController(id -> future, state -> {});
        controller.play("station-1");controller.stop();
        FakeSession late = new FakeSession();future.complete(late);
        assertEquals(0, late.starts);assertEquals(1, late.closes);
    }
    @Test public void rejectedStationAndFailedJoin() {
        AtomicInteger joins = new AtomicInteger();
        RadioController controller = new RadioController(id -> {joins.incrementAndGet();
            CompletableFuture<RadioController.Session> failed = new CompletableFuture<>();
            failed.completeExceptionally(new IllegalStateException("network"));return failed;
        }, state -> {});
        try { controller.play("../other"); fail("invalid ID accepted"); }
        catch (IllegalArgumentException expected) { assertEquals(0, joins.get()); }
        controller.play("s1");
        assertEquals(RadioController.State.INTERRUPTED, controller.state());
    }
    @Test public void closeFailureDoesNotRetainSessionOrPretendPlaybackContinues() {
        AtomicInteger closes = new AtomicInteger();
        RadioController.Session faulty = new RadioController.Session() {
            public void start() { }
            public void close() { closes.incrementAndGet(); throw new IllegalStateException("close failed"); }
        };
        RadioController controller = new RadioController(id -> CompletableFuture.completedFuture(faulty), state -> {});
        controller.play("s1");
        controller.stop();
        assertEquals(RadioController.State.INTERRUPTED, controller.state());
        controller.stop();
        assertEquals(1, closes.get());
        assertEquals(RadioController.State.INTERRUPTED, controller.state());
    }
    @Test public void lateCloseFailureIsReportedAsInterrupted() {
        CompletableFuture<RadioController.Session> future = new CompletableFuture<>();
        RadioController controller = new RadioController(id -> future, state -> {});
        controller.play("s1"); controller.stop();
        future.complete(new RadioController.Session() {
            public void start() { fail("late session started"); }
            public void close() { throw new IllegalStateException("close failed"); }
        });
        assertEquals(RadioController.State.INTERRUPTED, controller.state());
    }
    @Test public void failedClosePreventsStartingAnotherStation() {
        AtomicInteger joins = new AtomicInteger();
        RadioController.Session faulty = new RadioController.Session() {
            public void start() { }
            public void close() { throw new IllegalStateException("could still be audible"); }
        };
        RadioController controller = new RadioController(id -> {
            joins.incrementAndGet(); return CompletableFuture.completedFuture(faulty);
        }, state -> {});
        controller.play("station-a");
        controller.play("station-b");
        assertEquals(1, joins.get());
        assertEquals(RadioController.State.INTERRUPTED, controller.state());
    }
    @Test public void completionUsesInjectedDispatcher() {
        List<Runnable> tasks = new ArrayList<>();
        FakeSession session = new FakeSession();
        RadioController controller = new RadioController(id -> CompletableFuture.completedFuture(session), state -> {}, tasks::add);
        controller.play("s1");
        assertEquals(RadioController.State.CONNECTING, controller.state());
        assertEquals(0, session.starts);
        tasks.remove(0).run();
        assertEquals(RadioController.State.PLAYING, controller.state());
        assertEquals(1, session.starts);
        controller.stop();
    }
}
