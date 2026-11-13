package au.sam.seamless

import org.junit.Assert.*
import org.junit.Test

class ServerUrlTest {
    private fun ok(s: String, debug: Boolean = false) = (ServerUrl.parse(s, debug) as ServerUrl.Result.Ok).url
    private fun bad(s: String, debug: Boolean = false) = (ServerUrl.parse(s, debug) as ServerUrl.Result.Bad).message

    @Test fun httpsAnywhere() {
        assertEquals("https://mail.example.com", ok("https://mail.example.com/"))
        assertEquals("https://mail.example.com", ok("mail.example.com"))
        assertEquals("https://mail.example.com:8443/seamless", ok("  Mail.Example.com:8443/seamless/ "))
    }

    @Test fun httpOnlyOnPrivateAddresses() {
        for (h in listOf("192.168.8.101:4901", "10.1.2.3", "172.16.0.1", "172.31.255.254", "localhost:4901", "nas.local", "127.0.0.1")) {
            assertEquals("http://$h".lowercase(), ok("http://$h"))
        }
        for (h in listOf("mail.example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "11.0.0.1", "evil.local.example.com")) {
            assertTrue("$h should be refused", bad("http://$h").contains("home network"))
        }
    }

    @Test fun schemeIsGuessedFromTheHost() {
        assertEquals("http://192.168.8.101:4901", ok("192.168.8.101:4901"))
        assertEquals("http://nas.local", ok("nas.local"))
        assertEquals("https://mail.example.com", ok("mail.example.com"))
    }

    @Test fun emulatorHostIsInTheTenRange() {
        assertEquals("http://10.0.2.2:4901", ok("http://10.0.2.2:4901"))
    }

    @Test fun rejectsJunk() {
        bad("http://10.0.0.256") // not an address at all: refused either way
        assertTrue(bad("").contains("Type"))
        assertTrue(bad("ftp://x.example.com").contains("web address"))
        assertTrue(bad("https://user:pw@mail.example.com").contains("username"))
        assertTrue(bad("http://").contains("web address"))
    }
}
