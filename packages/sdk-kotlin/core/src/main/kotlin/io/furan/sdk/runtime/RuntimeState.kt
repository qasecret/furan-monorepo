package io.furan.sdk.runtime

/**
 * Lifecycle states for a [FuranRuntime]. The state machine
 * ([StateMachine]) enforces allowed transitions.
 *
 *  - [INITIALIZING] — bootstrapping subsystems; not yet usable.
 *  - [READY]        — fully operational on the happy path.
 *  - [DEGRADED]     — still serving but a subsystem is impaired
 *                     (circuit open, fallback endpoint, etc).
 *  - [RELOADING]    — hot-reload in progress; brief unavailability.
 *  - [SHUTTING_DOWN]— draining; new requests should reject.
 *  - [TERMINATED]   — terminal; nothing further happens.
 */
enum class RuntimeState {
    INITIALIZING,
    READY,
    DEGRADED,
    RELOADING,
    SHUTTING_DOWN,
    TERMINATED,
}
