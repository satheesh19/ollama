import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class DbService {
  private dbName = 'OllamaUIDB';
  private storeName = 'chats';
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor() {
    this.initDB().catch(err => console.error('IndexedDB initialization failed on boot:', err));
  }

  private initDB(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      if (this.db) {
        resolve(this.db);
        return;
      }

      try {
        const request = indexedDB.open(this.dbName, 1);

        request.onerror = (event) => {
          console.error('IndexedDB failed to open:', event);
          reject(new Error('Failed to open IndexedDB'));
        };

        request.onsuccess = (event: any) => {
          this.db = event.target.result;
          resolve(this.db!);
        };

        request.onupgradeneeded = (event: any) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName);
          }
        };
      } catch (err) {
        console.error('IndexedDB initialization error:', err);
        reject(err);
      }
    });

    return this.dbPromise;
  }

  async getChat(chatId: string): Promise<any[]> {
    try {
      const db = await this.initDB();
      const messages = await new Promise<any[]>((resolve) => {
        const transaction = db.transaction([this.storeName], 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.get(chatId);

        request.onsuccess = (event: any) => {
          resolve(event.target.result || []);
        };

        request.onerror = () => {
          resolve([]);
        };
      });

      if (messages && messages.length > 0) {
        return messages;
      }

      // IndexedDB is empty for this chat; check for legacy localStorage data
      try {
        const legacyKey1 = 'ollama_chat_' + chatId;
        const legacyKey2 = chatId;
        const legacyData = localStorage.getItem(legacyKey1) || localStorage.getItem(legacyKey2);
        
        if (legacyData) {
          const parsed = JSON.parse(legacyData);
          if (Array.isArray(parsed) && parsed.length > 0) {
            console.log(`[Migration] Auto-migrating legacy chat ${chatId} from localStorage to IndexedDB...`);
            // Save to IndexedDB so it's persisted in the new architecture
            await this.saveChat(chatId, parsed);
            // Clear localStorage keys to reclaim quota space
            localStorage.removeItem(legacyKey1);
            localStorage.removeItem(legacyKey2);
            return parsed;
          }
        }
      } catch (err) {
        console.error('[Migration] Failed to migrate legacy localStorage chat:', err);
      }

      return messages;
    } catch (e) {
      console.warn('Fallback: DB not available, loading empty array.', e);
      return [];
    }
  }

  async saveChat(chatId: string, messages: any[]): Promise<void> {
    try {
      const db = await this.initDB();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.put(messages, chatId);

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = (event) => {
          console.error('IndexedDB save failed:', event);
          reject(new Error('Failed to save to IndexedDB'));
        };
      });
    } catch (e) {
      console.error('IndexedDB save exception:', e);
      throw e;
    }
  }

  async deleteChat(chatId: string): Promise<void> {
    try {
      const db = await this.initDB();
      await new Promise<void>((resolve) => {
        const transaction = db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(chatId);

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => {
          resolve();
        };
      });
    } catch (e) {
      console.warn('IndexedDB delete failed:', e);
    }
  }
}
