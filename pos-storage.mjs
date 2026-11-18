const STORAGE = 'fastq-v1';
const LEGACY_STORAGE = 'titik-kasir-v1';
const SECURE_DB = 'fastq-secure-v1';
const LEGACY_SECURE_DB = 'titik-kasir-secure-v1';

export function createPosStorage(onWriteFailure = () => {}, onWriteSuccess = () => {}) {
  let secureDb;
  let deviceKey;
  let encryptedSaveQueue = Promise.resolve();
  let pendingEncryptedSnapshot = null;
  let encryptedWriteRunning = false;
  let encryptedRetryTimer = null;
  let encryptedRetryAttempt = 0;
  let writeFailureReported = false;
  let clearing = false;
  const writeMetrics = {
    completedWrites: 0,
    failedWrites: 0,
    lastSnapshotChars: 0,
    largestSnapshotChars: 0,
    lastSerializationMs: 0,
    largestSerializationMs: 0,
    lastEncryptionMs: null,
    lastDurableWriteMs: 0,
    lastTotalWriteMs: 0,
    backend: null,
  };
  const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();

  function drainEncryptedQueue() {
    if (encryptedWriteRunning || clearing || pendingEncryptedSnapshot === null) return;
    clearTimeout(encryptedRetryTimer);
    encryptedRetryTimer = null;
    encryptedWriteRunning = true;
    encryptedSaveQueue = Promise.resolve().then(async () => {
      let latest = null;
      try {
        while (pendingEncryptedSnapshot !== null) {
          latest = pendingEncryptedSnapshot;
          pendingEncryptedSnapshot = null;
          const serializationStarted = monotonicNow();
          const serialized = JSON.stringify(latest);
          const serializationMs = Math.max(0, monotonicNow() - serializationStarted);
          const snapshotChars = serialized.length;
          writeMetrics.lastSnapshotChars = snapshotChars;
          writeMetrics.largestSnapshotChars = Math.max(writeMetrics.largestSnapshotChars, snapshotChars);
          writeMetrics.lastSerializationMs = serializationMs;
          writeMetrics.largestSerializationMs = Math.max(writeMetrics.largestSerializationMs, serializationMs);
          const writeResult = await writeEncryptedState(serialized);
          writeMetrics.completedWrites++;
          writeMetrics.lastEncryptionMs = writeResult.encryptionMs;
          writeMetrics.lastDurableWriteMs = writeResult.durableWriteMs;
          writeMetrics.lastTotalWriteMs = serializationMs + writeResult.totalWriteMs;
          writeMetrics.backend = writeResult.backend;
          latest = null;
        }
        if (writeFailureReported) {
          writeFailureReported = false;
          encryptedRetryAttempt = 0;
          try { onWriteSuccess(); } catch {}
        }
      } catch {
        writeMetrics.failedWrites++;
        if (pendingEncryptedSnapshot === null && latest !== null) pendingEncryptedSnapshot = latest;
        if (!writeFailureReported) {
          writeFailureReported = true;
          try { onWriteFailure(); } catch {}
        }
        encryptedRetryAttempt++;
      } finally {
        encryptedWriteRunning = false;
        if (pendingEncryptedSnapshot !== null && !clearing) scheduleEncryptedRetry();
      }
    });
  }

  function scheduleEncryptedRetry() {
    if (encryptedRetryTimer !== null || clearing || pendingEncryptedSnapshot === null) return;
    const delays = [1_000, 3_000, 10_000, 30_000, 60_000];
    const delay = delays[Math.min(Math.max(0, encryptedRetryAttempt - 1), delays.length - 1)];
    encryptedRetryTimer = setTimeout(() => {
      encryptedRetryTimer = null;
      drainEncryptedQueue();
    }, delay);
  }

  function openSecureDb(name = SECURE_DB) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Penyimpanan lokal aman tidak tersedia'));
    });
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Penyimpanan lokal gagal'));
    });
  }

  function idbWrite(db, store, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Penyimpanan lokal gagal'));
      tx.onabort = () => reject(tx.error || new Error('Penyimpanan lokal dibatalkan'));
    });
  }

  async function getDeviceKey(db) {
    let key = await idbRequest(db.transaction('keys', 'readonly').objectStore('keys').get('device'));
    if (key) return key;
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idbWrite(db, 'keys', 'device', key);
    return key;
  }

  async function writeEncryptedState(serialized) {
    const writeStarted = monotonicNow();
    if (window.parent !== window && window.parent.PosNativeStorage) {
      await window.parent.PosNativeStorage.save(serialized);
      return { backend: 'native-sqlite', encryptionMs: null, durableWriteMs: Math.max(0, monotonicNow() - writeStarted), totalWriteMs: Math.max(0, monotonicNow() - writeStarted) };
    }
    const db = secureDb || (secureDb = await openSecureDb());
    const key = deviceKey || (deviceKey = await getDeviceKey(db));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptionStarted = monotonicNow();
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(serialized));
    const encryptionMs = Math.max(0, monotonicNow() - encryptionStarted);
    const durableWriteStarted = monotonicNow();
    await idbWrite(db, 'records', 'state', { version: 1, iv, cipher });
    const completedAt = monotonicNow();
    return { backend: 'indexeddb-aes-gcm', encryptionMs, durableWriteMs: Math.max(0, completedAt - durableWriteStarted), totalWriteMs: Math.max(0, completedAt - writeStarted) };
  }

  function queueEncryptedState(snapshot) {
    if (clearing) return;
    pendingEncryptedSnapshot = snapshot;
    encryptedRetryAttempt = 0;
    clearTimeout(encryptedRetryTimer);
    encryptedRetryTimer = null;
    drainEncryptedQueue();
  }

  async function flushEncryptedWrites() {
    while (encryptedWriteRunning || pendingEncryptedSnapshot !== null) {
      const currentWrite = encryptedSaveQueue;
      await currentWrite;
      if (writeFailureReported) throw new Error('Snapshot lokal terenkripsi belum berhasil disimpan.');
    }
    if (writeFailureReported) throw new Error('Snapshot lokal terenkripsi belum berhasil disimpan.');
  }

  function getWriteDiagnostics() {
    return { ...writeMetrics, pendingWrite: encryptedWriteRunning || pendingEncryptedSnapshot !== null, retryAttempt: encryptedRetryAttempt };
  }

  async function readSavedState() {
    if (window.parent !== window && window.parent.PosNativeStorage) {
      const serialized = await window.parent.PosNativeStorage.load();
      return serialized ? JSON.parse(serialized) : null;
    }
    secureDb = await openSecureDb();
    deviceKey = await getDeviceKey(secureDb);
    const record = await idbRequest(secureDb.transaction('records', 'readonly').objectStore('records').get('state'));
    if (record) {
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, deviceKey, record.cipher);
        const restored = JSON.parse(new TextDecoder().decode(plain));
        localStorage.removeItem(STORAGE);
        return restored;
      } catch {
        throw new Error('Data lokal terenkripsi tidak dapat dibuka. Pertahankan penyimpanan ini dan hubungi administrator.');
      }
    }
    const databases = await indexedDB.databases?.() || [];
    if (databases.some(db => db.name === LEGACY_SECURE_DB)) {
      const oldDb = await openSecureDb(LEGACY_SECURE_DB);
      try {
        const oldRecord = await idbRequest(oldDb.transaction('records', 'readonly').objectStore('records').get('state'));
        const oldKey = await idbRequest(oldDb.transaction('keys', 'readonly').objectStore('keys').get('device'));
        if (oldRecord && oldKey) {
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: oldRecord.iv }, oldKey, oldRecord.cipher);
          const restored = JSON.parse(new TextDecoder().decode(plain));
          await writeEncryptedState(JSON.stringify(restored));
          oldDb.close();
          await new Promise((resolve, reject) => {
            const deletion = indexedDB.deleteDatabase(LEGACY_SECURE_DB);
            deletion.onsuccess = () => resolve();
            deletion.onerror = () => reject(deletion.error);
          });
          return restored;
        }
      } finally {
        if (oldDb !== secureDb) oldDb.close();
      }
    }
    const legacy = localStorage.getItem(STORAGE) ?? localStorage.getItem(LEGACY_STORAGE);
    if (!legacy) return null;
    const parsed = JSON.parse(legacy);
    await writeEncryptedState(JSON.stringify(parsed));
    localStorage.removeItem(STORAGE);
    localStorage.removeItem(LEGACY_STORAGE);
    return parsed;
  }

  function deletePosDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Penyimpanan lokal gagal dihapus.'));
      request.onblocked = () => reject(new Error('Tutup tab POS lain sebelum menghapus data lokal.'));
    });
  }

  async function clear() {
    clearing = true;
    clearTimeout(encryptedRetryTimer);
    encryptedRetryTimer = null;
    pendingEncryptedSnapshot = null;
    try {
      await encryptedSaveQueue;
      if (window.parent !== window && window.parent.PosNativeStorage) {
        if (typeof window.parent.PosNativeStorage.clear !== 'function') throw new Error('Versi aplikasi belum mendukung penghapusan data lokal. Perbarui aplikasi lalu coba lagi.');
        await window.parent.PosNativeStorage.clear();
      }
      if (secureDb) {
        secureDb.close();
        secureDb = undefined;
        deviceKey = undefined;
      }
      await deletePosDatabase(SECURE_DB);
      await deletePosDatabase(LEGACY_SECURE_DB);
      localStorage.clear();
      writeFailureReported = false;
      encryptedRetryAttempt = 0;
    } finally {
      clearing = false;
      if (pendingEncryptedSnapshot !== null) scheduleEncryptedRetry();
    }
  }

  return { queueEncryptedState, flushEncryptedWrites, readSavedState, clear, getWriteDiagnostics };
}
