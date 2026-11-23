package id.co.fastq.pos;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class FastQApplicationInstrumentedTest {

    @Test
    public void applicationUsesConfiguredPackageId() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("id.co.fastq.pos", appContext.getPackageName());
    }
}
