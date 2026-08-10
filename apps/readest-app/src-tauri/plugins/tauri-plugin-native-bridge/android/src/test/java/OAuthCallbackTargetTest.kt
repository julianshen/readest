package com.readest.native_bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** JVM contract coverage for provider callbacks without an Android runtime. */
class OAuthCallbackTargetTest {
    @Test
    fun googleCallback_matchesItsReverseDnsSchemeAndRegisteredPath() {
        val target = OAuthCallbackTarget.parse(
            "com.googleusercontent.apps.209390247301-ctpmep68ppfa56r1b8tr35e4qi4p60kq:/oauthredirect",
        )

        assertNotNull(target)
        assertTrue(
            target!!.matches(
                "COM.GOOGLEUSERCONTENT.APPS.209390247301-CTPMEP68PPFA56R1B8TR35E4QI4P60KQ:/oauthredirect?code=CODE&state=STATE",
            ),
        )
        assertFalse(target.matches("readest://auth-callback?code=CODE"))
        assertFalse(target.matches("https://provider.example/oauthredirect?code=CODE"))
        assertFalse(target.matches("com.googleusercontent.apps.209390247301-ctpmep68ppfa56r1b8tr35e4qi4p60kq:/other?code=CODE"))
    }

    @Test
    fun supabaseCallback_matchesOnlyItsRegisteredDestination() {
        val target = OAuthCallbackTarget.parse("readest://auth-callback")

        assertNotNull(target)
        assertTrue(target!!.matches("readest://auth-callback#access_token=ACCESS&refresh_token=REFRESH"))
        assertFalse(target.matches("readest://attacker#access_token=ACCESS"))
        assertFalse(target.matches("readest-other://auth-callback#access_token=ACCESS"))
        assertFalse(target.matches("readest://auth-callback-other#access_token=ACCESS"))
    }

    @Test
    fun oneDriveCallback_matchesOnlyItsExpectedHostAndRootPath() {
        val target = OAuthCallbackTarget.parse("readest-onedrive://auth")

        assertNotNull(target)
        assertTrue(target!!.matches("READEST-ONEDRIVE://auth/?code=CODE&state=STATE"))
        assertFalse(target.matches("readest-onedrive://attacker/?code=CODE"))
        assertFalse(target.matches("readest-onedrive://auth:1234/?code=CODE"))
        assertFalse(target.matches("readest://auth-callback?code=CODE"))
        assertFalse(target.matches("https://auth/?code=CODE"))
    }
}
