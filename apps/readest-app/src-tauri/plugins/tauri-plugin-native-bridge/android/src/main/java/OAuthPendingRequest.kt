package com.readest.native_bridge

/** Schedules the bounded lifetime of the one active Android OAuth request. */
internal interface OAuthDeadlineScheduler {
    fun schedule(delayMs: Long, action: () -> Unit): OAuthDeadline
}

/** A cancellable OAuth deadline. */
internal interface OAuthDeadline {
    fun cancel()
}

/**
 * Holds one OAuth request until its exact callback arrives or its deadline expires.
 *
 * The coordinator deliberately refuses replacement. Every terminal path clears the
 * active entry before notifying callers, and timeout callbacks are bound to their
 * entry so a stale deadline cannot affect a later authorization.
 */
internal class OAuthPendingRequest<T : Any>(
    private val scheduler: OAuthDeadlineScheduler,
    private val timeoutMs: Long,
) {
    private class Entry<T : Any>(
        val request: T,
        val callbackTarget: OAuthCallbackTarget,
        val onTimeout: (T) -> Unit,
    ) {
        var deadline: OAuthDeadline? = null
    }

    private var active: Entry<T>? = null

    val hasPendingRequest: Boolean
        get() = active != null

    /** Starts an authorization only when no prior authorization is active. */
    fun begin(
        request: T,
        callbackTarget: OAuthCallbackTarget,
        onTimeout: (T) -> Unit,
    ): Boolean {
        if (active != null) return false

        val entry = Entry(request, callbackTarget, onTimeout)
        active = entry
        val deadline = scheduler.schedule(timeoutMs) {
            val timedOut = take(entry) ?: return@schedule
            timedOut.onTimeout(timedOut.request)
        }
        entry.deadline = deadline
        if (active !== entry) deadline.cancel()
        return true
    }

    /** Returns and clears the active request only when the callback is exact. */
    fun takeMatching(callbackUrl: String): T? {
        val entry = active ?: return null
        if (!entry.callbackTarget.matches(callbackUrl)) return null
        return take(entry)?.request
    }

    /** Clears a request only when it is still the active authorization. */
    fun remove(request: T): Boolean {
        val entry = active
        if (entry == null || entry.request !== request) return false
        return take(entry) != null
    }

    private fun take(entry: Entry<T>): Entry<T>? {
        if (active !== entry) return null
        active = null
        entry.deadline?.cancel()
        return entry
    }
}
