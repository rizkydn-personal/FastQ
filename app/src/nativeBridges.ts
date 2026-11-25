import { registerPlugin } from '@capacitor/core';
import {
  BarcodeFormat,
  BarcodeScanner,
  GoogleBarcodeScannerModuleInstallState,
} from '@capacitor-mlkit/barcode-scanning';

declare global {
  interface Window {
    FastQBarcodeScanner?: {
      scan: (onProgress?: (message: string) => void) => Promise<string | null>;
    };
    FastQNativePrinter?: {
      listBondedBluetooth: () => Promise<{ name: string; address: string }[]>;
      listUsbDevices: () => Promise<
        { deviceName: string; name: string; vendorId: number; productId: number }[]
      >;
      printUsb: (options: { deviceName: string; payload: string }) => Promise<void>;
      printBluetooth: (options: { address: string; payload: string }) => Promise<void>;
    };
  }
}

type FastQPrinterPlugin = {
  getBondedDevices: () => Promise<{ devices: { name: string; address: string }[] }>;
  getUsbDevices: () => Promise<{
    devices: { deviceName: string; name: string; vendorId: number; productId: number }[];
  }>;
  printUsb: (options: { deviceName: string; payload: string }) => Promise<void>;
  printBluetooth: (options: { address: string; payload: string }) => Promise<void>;
};

const FastQPrinter = registerPlugin<FastQPrinterPlugin>('FastQPrinter');

export function installNativeBridges(): () => void {
  window.FastQNativePrinter = {
    listBondedBluetooth: async () => (await FastQPrinter.getBondedDevices()).devices,
    listUsbDevices: async () => (await FastQPrinter.getUsbDevices()).devices,
    printUsb: (options) => FastQPrinter.printUsb(options),
    printBluetooth: (options) => FastQPrinter.printBluetooth(options),
  };
  window.FastQBarcodeScanner = {
    scan: async (onProgress) => {
      const { supported } = await BarcodeScanner.isSupported();
      if (!supported)
        throw new Error(
          'Perangkat ini tidak memiliki kamera yang didukung. Gunakan scanner barcode keyboard.',
        );

      const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (!available) {
        onProgress?.(
          'Menyiapkan scanner Google. Koneksi internet diperlukan saat pemasangan pertama.',
        );
        let timeout: ReturnType<typeof setTimeout>;
        let resolveInstall!: () => void;
        let rejectInstall!: (reason: Error) => void;
        const listener = await BarcodeScanner.addListener(
          'googleBarcodeScannerModuleInstallProgress',
          (event) => {
            if (event.state === GoogleBarcodeScannerModuleInstallState.DOWNLOADING)
              onProgress?.(`Mengunduh scanner Google, ${event.progress}%`);
            else if (event.state === GoogleBarcodeScannerModuleInstallState.INSTALLING)
              onProgress?.('Memasang scanner Google…');
            else if (event.state === GoogleBarcodeScannerModuleInstallState.COMPLETED)
              resolveInstall();
            else if (
              event.state === GoogleBarcodeScannerModuleInstallState.FAILED ||
              event.state === GoogleBarcodeScannerModuleInstallState.CANCELED
            ) {
              rejectInstall(
                new Error(
                  'Scanner Google tidak dapat dipasang. Sambungkan internet atau gunakan scanner keyboard.',
                ),
              );
            }
          },
        );
        const installComplete = new Promise<void>((resolve, reject) => {
          resolveInstall = resolve;
          rejectInstall = reject;
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  'Pemasangan scanner belum selesai. Periksa koneksi internet, lalu coba lagi.',
                ),
              ),
            45_000,
          );
        });
        try {
          await BarcodeScanner.installGoogleBarcodeScannerModule();
          await installComplete;
        } finally {
          clearTimeout(timeout!);
          await listener.remove();
        }
      }

      onProgress?.('Arahkan kamera ke barcode produk. Tekan Kembali untuk membatalkan.');
      const { barcodes } = await BarcodeScanner.scan({
        formats: [
          BarcodeFormat.QrCode,
          BarcodeFormat.Ean13,
          BarcodeFormat.Ean8,
          BarcodeFormat.UpcA,
          BarcodeFormat.UpcE,
          BarcodeFormat.Code128,
          BarcodeFormat.Code39,
        ],
        autoZoom: true,
      });
      return barcodes.find((barcode) => barcode.rawValue)?.rawValue ?? null;
    },
  };

  return () => {
    delete window.FastQBarcodeScanner;
    delete window.FastQNativePrinter;
  };
}
