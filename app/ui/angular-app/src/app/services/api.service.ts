import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { 
  ChatResponse, 
  ChatsResponse, 
  Model, 
  Settings, 
  User 
} from '../gotypes.gen';

// Basic wrapper around the original fetch-based logic for now
@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly API_BASE = ''; // Adjust if connecting to remote host

  constructor(private http: HttpClient) {}

  private getApiBaseUrl(): string {
    try {
      const saved = localStorage.getItem('ollama_ui_settings');
      if (saved) {
        const s = JSON.parse(saved);
        if (s.apiUrl && s.apiUrl.trim()) {
          let url = s.apiUrl.trim();
          if (url.endsWith('/')) {
            url = url.slice(0, -1);
          }
          return url;
        }
      }
    } catch (e) {}
    return ''; // Relative paths
  }

  getUser(): Observable<User> {
    const base = this.getApiBaseUrl();
    return this.http.post<User>(`${base}/api/me`, {});
  }

  getChats(): Observable<ChatsResponse> {
    const base = this.getApiBaseUrl();
    return this.http.get<ChatsResponse>(`${base}/api/v1/chats`);
  }

  getChat(chatId: string): Observable<ChatResponse> {
    const base = this.getApiBaseUrl();
    return this.http.get<ChatResponse>(`${base}/api/v1/chat/${chatId}`);
  }

  getModels(): Observable<{ models: Model[] }> {
    const base = this.getApiBaseUrl();
    return this.http.get<{ models: Model[] }>(`${base}/api/tags`);
  }

  getModelInfo(modelName: string): Observable<any> {
    const base = this.getApiBaseUrl();
    return this.http.post<any>(`${base}/api/show`, { model: modelName });
  }

  getSystemGPUInfo(): Observable<{ total_memory_bytes: number, total_memory_gb: number, gpu_name: string }> {
    // This custom endpoint resides strictly on our Go proxy wrapper (port 9090 or same host origin).
    // Direct requests to Ollama (port 11434) do not have this endpoint. We enforce querying the wrapper:
    let base = window.location.origin;
    if (base.includes(':4200')) {
      // Dev Mode: Only query Go proxy if explicitly enabled by developer, otherwise bypass to prevent console red warnings!
      let enableTelemetry = false;
      try {
        const saved = localStorage.getItem('ollama_ui_settings');
        if (saved) {
          enableTelemetry = JSON.parse(saved).enableGPUTelemetry === true;
        }
      } catch (e) {}

      if (!enableTelemetry) {
        return new Observable(subscriber => {
          subscriber.error(new Error('GPU telemetry disabled in dev mode.'));
        });
      }
      base = 'http://localhost:9090'; // Dev server port redirection
    } else if (base.includes(':11434')) {
      base = base.replace(':11434', ':9090'); // Direct setting fallback
    }
    return this.http.get<{ total_memory_bytes: number, total_memory_gb: number, gpu_name: string }>(`${base}/api/system/gpu`);
  }

  getSettings(): Observable<{ settings: Settings }> {
    const base = this.getApiBaseUrl();
    return this.http.get<{ settings: Settings }>(`${base}/api/v1/settings`);
  }

  updateSettings(settings: Settings): Observable<{ settings: Settings }> {
    const base = this.getApiBaseUrl();
    return this.http.post<{ settings: Settings }>(`${base}/api/v1/settings`, settings);
  }

  renameChat(chatId: string, title: string): Observable<void> {
    const base = this.getApiBaseUrl();
    return this.http.put<void>(`${base}/api/v1/chat/${chatId}/rename`, { title: title.trim() });
  }

  deleteChat(chatId: string): Observable<void> {
    const base = this.getApiBaseUrl();
    return this.http.delete<void>(`${base}/api/v1/chat/${chatId}`);
  }

  async *sendMessage(
    modelName: string,
    messages: { role: string, content: string, images?: string[] }[],
    options?: any,
    keepAlive?: string,
    thinking?: boolean,
    format?: string,
    truncate?: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<any> {
    const payload: any = {
      model: modelName,
      messages: messages,
      options: options,
      stream: true
    };
    
    if (format) {
      payload.format = format;
    }
    
    if (truncate !== undefined) {
      payload.truncate = truncate;
    }
    
    if (keepAlive) {
      payload.keep_alive = keepAlive;
    }
    
    if (thinking !== undefined) {
      payload.think = thinking;
    }

    const base = this.getApiBaseUrl();
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal
    });

    if (!response.ok) {
      let errMsg = response.statusText;
      try {
        const errJson = await response.json();
        if (errJson && errJson.error) {
          errMsg = errJson.error;
        }
      } catch(e) {}
      throw new Error(errMsg);
    }

    const { parseJsonlFromResponse } = await import('./jsonl-parsing');
    for await (const event of parseJsonlFromResponse<any>(response)) {
      if (event.error) {
        throw new Error(`Ollama Error: ${event.error}`);
      }
      // Raw Ollama API sends { message: { content: "...", role: "assistant" } }
      if (event.message && typeof event.message.content === 'string') {
        yield { content: event.message.content };
      }
    }
  }
}
