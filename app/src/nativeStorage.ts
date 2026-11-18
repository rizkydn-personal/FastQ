import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';

declare global {
  interface Window {
    PosNativeStorage?: { load: () => Promise<string | null>; save: (value: string) => Promise<void>; clear: () => Promise<void> };
  }
}

const databaseName = 'fastq_pos';
let database: SQLiteDBConnection | undefined;

export async function initializeNativeStorage(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;

  const connection = new SQLiteConnection(CapacitorSQLite);
  await connection.checkConnectionsConsistency();
  const secretStatus = await connection.isSecretStored();
  if (!secretStatus.result) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    await connection.setEncryptionSecret(secret);
  }

  const exists = await connection.isConnection(databaseName, false);
  database = exists.result
    ? await connection.retrieveConnection(databaseName, false)
    : await connection.createConnection(databaseName, true, 'encryption', 1, false);
  await database.open();
  await database.execute(`CREATE TABLE IF NOT EXISTS pos_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  window.PosNativeStorage = {
    load: async () => {
      const result = await database!.query('SELECT payload FROM pos_state WHERE id = 1');
      return result.values?.[0]?.payload as string | undefined ?? null;
    },
    save: async value => {
      await database!.run(
        'INSERT INTO pos_state (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
        [value, new Date().toISOString()],
      );
    },
    clear: async () => {
      await database!.run('DELETE FROM pos_state WHERE id = 1');
    },
  };
  return true;
}
