import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class DbService {
  private dbName = 'OllamaUIDB';
  private storeName = 'chats';
  private db: IDBDatabase | null = null;

  constructor() {
    this.initDB();
  }

  private initDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
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
  }

  async getChat(chatId: string): Promise<any[]> {
    try {
      const db = await this.initDB();
      return new Promise((resolve) => {
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
    } catch (e) {
      console.warn('Fallback: DB not available, loading empty array.', e);
      return [];
    }
  }

  async saveChat(chatId: string, messages: any[]): Promise<void> {
    try {
      const db = await this.initDB();
      return new Promise((resolve, reject) => {
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
      return new Promise((resolve) => {
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
