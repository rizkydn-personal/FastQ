package id.co.fastq.pos;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import com.getcapacitor.annotation.CapacitorPlugin;
import org.junit.Test;

public class FastQPrinterPluginTest {

    @Test
    public void pluginRegistersExpectedCapacitorName() {
        CapacitorPlugin registration = FastQPrinterPlugin.class.getAnnotation(CapacitorPlugin.class);

        assertNotNull(registration);
        assertEquals("FastQPrinter", registration.name());
    }
}
