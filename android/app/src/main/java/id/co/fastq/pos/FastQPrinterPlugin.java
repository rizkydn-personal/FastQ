package id.co.fastq.pos;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.app.PendingIntent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.OutputStream;
import java.util.UUID;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "FastQPrinter",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class FastQPrinterPlugin extends Plugin {
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final String USB_PERMISSION = "id.co.fastq.pos.USB_PERMISSION";
    private final ExecutorService printerExecutor = Executors.newSingleThreadExecutor();
    private final Map<BroadcastReceiver, Runnable> pendingUsbPermissions = new ConcurrentHashMap<>();

    @PluginMethod
    public void getBondedDevices(PluginCall call) {
        if (needsBluetoothPermission()) {
            requestPermissionForAlias("bluetooth", call, "bondedDevicesPermissionCallback");
            return;
        }
        resolveBondedDevices(call);
    }

    @PermissionCallback
    private void bondedDevicesPermissionCallback(PluginCall call) {
        if (getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("Izin perangkat Bluetooth diperlukan untuk memilih printer yang sudah dipasangkan.");
            return;
        }
        resolveBondedDevices(call);
    }

    @PluginMethod
    public void printBluetooth(PluginCall call) {
        if (needsBluetoothPermission()) {
            requestPermissionForAlias("bluetooth", call, "printPermissionCallback");
            return;
        }
        printToBondedDevice(call);
    }

    @PluginMethod
    public void getUsbDevices(PluginCall call) {
        UsbManager manager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        if (manager == null) {
            call.reject("USB host tidak tersedia pada perangkat ini.");
            return;
        }
        JSArray devices = new JSArray();
        for (UsbDevice device : manager.getDeviceList().values()) {
            JSObject item = new JSObject();
            item.put("deviceName", device.getDeviceName());
            item.put("name", device.getProductName() == null ? "Printer USB" : device.getProductName());
            item.put("vendorId", device.getVendorId());
            item.put("productId", device.getProductId());
            devices.put(item);
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void printUsb(PluginCall call) {
        String deviceName = call.getString("deviceName");
        String encodedPayload = call.getString("payload");
        if (deviceName == null || encodedPayload == null) {
            call.reject("Pilih printer USB dan kirim data struk.");
            return;
        }
        final byte[] payload;
        try {
            payload = Base64.decode(encodedPayload, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("Data struk tidak valid.", error);
            return;
        }
        if (payload.length == 0 || payload.length > 2_000_000) {
            call.reject("Ukuran data struk tidak valid.");
            return;
        }

        UsbManager manager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        UsbDevice device = manager == null ? null : manager.getDeviceList().get(deviceName);
        if (device == null) {
            call.reject("Printer USB terputus. Sambungkan kembali lalu coba lagi.");
            return;
        }
        if (manager.hasPermission(device)) {
            sendUsbPayload(call, manager, device, payload);
            return;
        }
        requestUsbPermission(call, manager, device, payload);
    }

    private void requestUsbPermission(PluginCall call, UsbManager manager, UsbDevice device, byte[] payload) {
        Context context = getContext();
        Intent intent = new Intent(USB_PERMISSION).setPackage(context.getPackageName());
        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) pendingIntentFlags |= PendingIntent.FLAG_MUTABLE;
        PendingIntent permissionIntent = PendingIntent.getBroadcast(
            context, device.getDeviceId(), intent, pendingIntentFlags
        );
        IntentFilter filter = new IntentFilter(USB_PERMISSION);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context receiverContext, Intent result) {
                if (!USB_PERMISSION.equals(result.getAction())) return;
                finishUsbPermission(context, this);
                if (!result.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                    call.reject("Izin akses printer USB ditolak.");
                    return;
                }
                sendUsbPayload(call, manager, device, payload);
            }
        };
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(receiver, filter);
        Runnable timeout = () -> {
            finishUsbPermission(context, receiver);
            call.reject("Permintaan izin USB tidak dijawab. Sambungkan ulang printer lalu coba lagi.");
        };
        pendingUsbPermissions.put(receiver, timeout);
        mainHandler.postDelayed(timeout, 30_000);
        try {
            manager.requestPermission(device, permissionIntent);
        } catch (RuntimeException error) {
            finishUsbPermission(context, receiver);
            call.reject("Izin akses printer USB tidak dapat diminta.", error);
        }
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private void finishUsbPermission(Context context, BroadcastReceiver receiver) {
        Runnable timeout = pendingUsbPermissions.remove(receiver);
        if (timeout != null) mainHandler.removeCallbacks(timeout);
        try { context.unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { }
    }

    private void sendUsbPayload(PluginCall call, UsbManager manager, UsbDevice device, byte[] payload) {
        printerExecutor.execute(() -> {
            UsbDeviceConnection connection = null;
            UsbInterface claimedInterface = null;
            try {
                connection = manager.openDevice(device);
                if (connection == null) throw new IllegalStateException("Tidak dapat membuka printer USB.");
                UsbEndpoint output = null;
                for (int i = 0; i < device.getInterfaceCount() && output == null; i++) {
                    UsbInterface candidate = device.getInterface(i);
                    for (int j = 0; j < candidate.getEndpointCount(); j++) {
                        UsbEndpoint endpoint = candidate.getEndpoint(j);
                        if (endpoint.getDirection() == UsbConstants.USB_DIR_OUT
                            && endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                            claimedInterface = candidate;
                            output = endpoint;
                            break;
                        }
                    }
                }
                if (output == null) throw new IllegalStateException("Printer USB tidak menyediakan endpoint bulk keluaran ESC/POS.");
                if (!connection.claimInterface(claimedInterface, true)) {
                    throw new IllegalStateException("Antarmuka printer USB sedang digunakan aplikasi lain.");
                }
                int offset = 0;
                while (offset < payload.length) {
                    int length = Math.min(16_384, payload.length - offset);
                    int sent = connection.bulkTransfer(output, payload, offset, length, 5_000);
                    if (sent <= 0) throw new IllegalStateException("Printer USB berhenti menerima data. Periksa kabel dan kertas.");
                    offset += sent;
                }
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Tidak dapat mencetak melalui printer USB." : error.getMessage(), error);
            } finally {
                if (connection != null) {
                    if (claimedInterface != null) {
                        try { connection.releaseInterface(claimedInterface); } catch (Exception ignored) { }
                    }
                    connection.close();
                }
            }
        });
    }

    @PermissionCallback
    private void printPermissionCallback(PluginCall call) {
        if (getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("Izin perangkat Bluetooth diperlukan untuk mencetak.");
            return;
        }
        printToBondedDevice(call);
    }

    private boolean needsBluetoothPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    private BluetoothAdapter getBluetoothAdapter() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private void resolveBondedDevices(PluginCall call) {
        try {
            BluetoothAdapter adapter = getBluetoothAdapter();
            if (adapter == null) {
                call.reject("Perangkat ini tidak memiliki Bluetooth.");
                return;
            }
            if (!adapter.isEnabled()) {
                call.reject("Aktifkan Bluetooth dan pasangkan printer melalui Pengaturan Android.");
                return;
            }
            JSArray devices = new JSArray();
            for (BluetoothDevice device : adapter.getBondedDevices()) {
                JSObject item = new JSObject();
                item.put("name", device.getName() == null ? "Printer Bluetooth" : device.getName());
                item.put("address", device.getAddress());
                devices.put(item);
            }
            JSObject result = new JSObject();
            result.put("devices", devices);
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject("Izin perangkat Bluetooth ditolak.", error);
        }
    }

    private void printToBondedDevice(PluginCall call) {
        String address = call.getString("address");
        String encodedPayload = call.getString("payload");
        if (address == null || encodedPayload == null) {
            call.reject("Alamat printer dan data struk wajib diisi.");
            return;
        }

        final byte[] payload;
        try {
            payload = Base64.decode(encodedPayload, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("Data struk tidak valid.", error);
            return;
        }
        if (payload.length == 0 || payload.length > 2_000_000) {
            call.reject("Ukuran data struk tidak valid.");
            return;
        }

        printerExecutor.execute(() -> {
            BluetoothSocket socket = null;
            try {
                BluetoothAdapter adapter = getBluetoothAdapter();
                if (adapter == null || !adapter.isEnabled()) {
                    throw new IllegalStateException("Aktifkan Bluetooth sebelum mencetak.");
                }
                BluetoothDevice device = adapter.getRemoteDevice(address);
                if (device.getBondState() != BluetoothDevice.BOND_BONDED) {
                    throw new IllegalStateException("Pasangkan printer melalui Pengaturan Android terlebih dahulu.");
                }
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                socket.connect();
                OutputStream output = socket.getOutputStream();
                for (int offset = 0; offset < payload.length; offset += 1024) {
                    int length = Math.min(1024, payload.length - offset);
                    output.write(payload, offset, length);
                }
                output.flush();
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Tidak dapat mengirim struk ke printer Bluetooth." : error.getMessage(), error);
            } finally {
                if (socket != null) {
                    try { socket.close(); } catch (Exception ignored) { }
                }
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        for (BroadcastReceiver receiver : pendingUsbPermissions.keySet()) finishUsbPermission(getContext(), receiver);
        printerExecutor.shutdownNow();
        super.handleOnDestroy();
    }
}
