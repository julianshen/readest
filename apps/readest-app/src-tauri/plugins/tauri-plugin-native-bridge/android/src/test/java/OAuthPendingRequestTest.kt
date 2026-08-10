package com.readest.native_bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** JVM contract coverage for the single active Android OAuth authorization. */
class OAuthPendingRequestTest {
    @Test
    fun timeout_clearsTheRequestAndAllowsAnotherAuthorization() {
        val scheduler = FakeOAuthDeadlineScheduler()
        val timedOut = mutableListOf<Any>()
        val pending = OAuthPendingRequest<Any>(scheduler, 5 * 60 * 1000L)
        val first = Any()
        val second = Any()
        val target = OAuthCallbackTarget.parse("readest://auth-callback")!!

        assertTrue(pending.begin(first, target) { timedOut += it })
        scheduler.runNext()

        assertEquals(listOf(first), timedOut)
        assertFalse(pending.hasPendingRequest)
        assertTrue(scheduler.deadlines.single().cancelled)
        assertTrue(pending.begin(second, target) { timedOut += it })
    }

    @Test
    fun replacement_doesNotOverwriteTheActiveAuthorization() {
        val scheduler = FakeOAuthDeadlineScheduler()
        val pending = OAuthPendingRequest<Any>(scheduler, 5 * 60 * 1000L)
        val first = Any()
        val second = Any()
        val target = OAuthCallbackTarget.parse("readest://auth-callback")!!

        assertTrue(pending.begin(first, target) {})
        assertFalse(pending.begin(second, target) {})

        assertSame(first, pending.takeMatching("readest://auth-callback#access_token=token"))
        assertFalse(pending.hasPendingRequest)
    }

    @Test
    fun exactCallback_clearsTheRequestAndCancelsItsDeadline() {
        val scheduler = FakeOAuthDeadlineScheduler()
        val pending = OAuthPendingRequest<Any>(scheduler, 5 * 60 * 1000L)
        val request = Any()
        val target = OAuthCallbackTarget.parse("readest://auth-callback")!!

        assertTrue(pending.begin(request, target) {})

        assertSame(request, pending.takeMatching("readest://auth-callback#access_token=token"))
        assertFalse(pending.hasPendingRequest)
        assertTrue(scheduler.deadlines.single().cancelled)
    }

    @Test
    fun callbackCleanup_ignoresRepeatedCallbackAndCancelledDeadline() {
        val scheduler = FakeOAuthDeadlineScheduler()
        val timedOut = mutableListOf<Any>()
        val pending = OAuthPendingRequest<Any>(scheduler, 5 * 60 * 1000L)
        val request = Any()
        val target = OAuthCallbackTarget.parse("readest://auth-callback")!!

        assertTrue(pending.begin(request, target) { timedOut += it })
        assertSame(request, pending.takeMatching("readest://auth-callback#access_token=token"))

        assertNull(pending.takeMatching("readest://auth-callback#access_token=token"))
        scheduler.runNext()
        assertTrue(timedOut.isEmpty())
    }

    @Test
    fun arbitraryCallback_leavesTheActiveAuthorizationUntouched() {
        val scheduler = FakeOAuthDeadlineScheduler()
        val pending = OAuthPendingRequest<Any>(scheduler, 5 * 60 * 1000L)
        val request = Any()
        val target = OAuthCallbackTarget.parse("readest://auth-callback")!!

        assertTrue(pending.begin(request, target) {})

        assertNull(pending.takeMatching("readest://attacker#access_token=token"))
        assertTrue(pending.hasPendingRequest)
        assertFalse(scheduler.deadlines.single().cancelled)
    }
}

private class FakeOAuthDeadlineScheduler : OAuthDeadlineScheduler {
    val deadlines = mutableListOf<FakeOAuthDeadline>()

    override fun schedule(delayMs: Long, action: () -> Unit): OAuthDeadline {
        return FakeOAuthDeadline(action).also { deadlines += it }
    }

    fun runNext() {
        deadlines.first { !it.ran }.run()
    }
}

private class FakeOAuthDeadline(private val action: () -> Unit) : OAuthDeadline {
    var cancelled = false
    var ran = false

    override fun cancel() {
        cancelled = true
    }

    fun run() {
        ran = true
        action()
    }
}
