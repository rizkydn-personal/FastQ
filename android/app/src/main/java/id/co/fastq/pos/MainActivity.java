package id.co.fastq.pos;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(FastQPrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
