package au.sam.seamless

import org.junit.Assert.*
import org.junit.Test

class AppLockTest {
    private class Mem : KeyValueStore {
        val m = HashMap<String, String>()
        override fun get(key: String) = m[key]
        override fun put(key: String, value: String?) { if (value == null) m.remove(key) else m[key] = value }
    }
    private var t = 1_000_000L
    private fun lock(s: Mem = Mem()) = AppLock(s) { t }

    @Test fun offUntilSet() { assertFalse(lock().enabled) }

    @Test fun rightAndWrongPin() {
        val l = lock(); l.setPin("123456")
        assertTrue(l.enabled)
        assertEquals(PinResult.Ok, l.verify("123456"))
        assertEquals(PinResult.Wrong(4), l.verify("111111"))
        assertEquals(PinResult.Ok, l.verify("123456"))
    }

    @Test fun pinIsNotStoredPlain() {
        val s = Mem(); lock(s).setPin("123456")
        assertFalse(s.m.values.any { it.contains("123456") })
    }

    @Test fun waitsAfterFiveMisses() {
        val l = lock(); l.setPin("123456")
        repeat(4) { l.verify("000000") }
        assertEquals(PinResult.Locked(30), l.verify("000000"))
        assertTrue(l.verify("123456") is PinResult.Locked)   // even the right PIN has to wait
        t += 31_000
        assertEquals(PinResult.Ok, l.verify("123456"))
    }

    @Test fun waitDoubles() {
        val l = lock(); l.setPin("123456")
        repeat(5) { l.verify("000000") }
        t += 31_000
        assertEquals(PinResult.Locked(60), l.verify("000000"))
    }

    @Test fun onlySixDigits() {
        assertFalse(AppLock.isValid("12345")); assertFalse(AppLock.isValid("12345a")); assertTrue(AppLock.isValid("000000"))
        assertThrows(IllegalArgumentException::class.java) { lock().setPin("1234") }
    }

    @Test fun removeTurnsOff() {
        val l = lock(); l.setPin("123456"); l.biometric = true
        assertTrue(l.biometric)
        l.remove()
        assertFalse(l.enabled); assertFalse(l.biometric)
    }
}
