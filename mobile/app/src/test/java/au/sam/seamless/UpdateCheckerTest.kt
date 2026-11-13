package au.sam.seamless

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckerTest {
    @Test fun versionsCompareNumerically() {
        assertTrue(UpdateChecker.compare("1.10.0", "1.9.2") > 0)
        assertTrue(UpdateChecker.compare("1.0.0", "1.0.0") == 0)
        assertTrue(UpdateChecker.compare("2.0", "1.9.9") > 0)
        assertTrue(UpdateChecker.compare("1.1.0", "1.1") == 0)
    }
}
