package org.trackzero.listener;

/** The host must supply the reviewed DAE/DRE live adapter; no raw media URL is accepted. */
public interface RadioEngineProvider {
    RadioController.Engine radioEngine();
}
