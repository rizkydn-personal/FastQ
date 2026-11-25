import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'id.co.fastq.pos',
  appName: 'FastQ',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    url: 'https://breezy-crin-brutalx-da8355e1.apps.mistral.run',
  },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      iosIsEncryption: true,
      iosKeychainPrefix: 'fastq',
    },
  },
};

export default config;
