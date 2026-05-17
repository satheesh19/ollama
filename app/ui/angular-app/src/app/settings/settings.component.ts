import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../services/api.service';

// We define a local interface for settings that are applicable to the standalone UI
export interface AppSettings {
  apiUrl: string;
  contextLength: number;
  temperature: number;
  systemPrompt: string;
  keepAlive: number;
  thinking: boolean;
  
  // New settings
  jsonMode: boolean;
  jsonSchema: string;
  truncateHistory: boolean;
  maxTokens: number;
  topP: number;
  repeatPenalty: number;
  seed: number;
  stopSequences: string;
  
  // RoPE position embedding stretch options
  ropeFrequencyBase: number;
  ropeScale: number;
  
  // Dev telemetry options
  enableGPUTelemetry?: boolean;
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html'
})
export class SettingsComponent implements OnInit {
  settings = signal<AppSettings>({
    apiUrl: 'http://localhost:11434',
    contextLength: 4096,
    temperature: 0.7,
    systemPrompt: '',
    keepAlive: 5,
    thinking: false,
    jsonMode: false,
    jsonSchema: '',
    truncateHistory: true,
    maxTokens: -1,
    topP: 0.9,
    repeatPenalty: 1.1,
    seed: 0,
    stopSequences: '',
    ropeFrequencyBase: 0,
    ropeScale: 0,
    enableGPUTelemetry: false
  });
  
  showSaved = signal(false);
  
  // Model-specific context boundary signals
  modelName = signal<string>('llama3');
  modelMaxContext = signal<number>(8192);
  
  // Dynamic host system VRAM profile tracking signals
  systemVRAM = signal<number>(8.0); // Default fallback VRAM size (8GB)
  modelSizeGB = signal<number>(4.0); // Size of the currently active model weight in GB
  models = signal<any[]>([]); // Model list storage to find size

  constructor(
    private router: Router,
    private api: ApiService
  ) {}

  ngOnInit() {
    this.loadSettings();
    this.loadModelsList();
    
    // Retrieve currently active selected model to determine context window range
    try {
      const activeModel = localStorage.getItem('ollama_selected_model');
      if (activeModel) {
        this.modelName.set(activeModel);
        
        // Fetch GPU specifications first, then load context bounds
        this.api.getSystemGPUInfo().subscribe({
          next: (info) => {
            if (info && info.total_memory_gb) {
              console.log(`Settings UI resolved host GPU: ${info.gpu_name} with ${info.total_memory_gb} GB VRAM`);
              this.systemVRAM.set(info.total_memory_gb);
            }
            this.loadModelMaxContext(activeModel);
          },
          error: () => {
            console.warn('Settings component running in standalone proxy-less environment; using default 8GB GPU layout.');
            this.loadModelMaxContext(activeModel);
          }
        });
      }
    } catch (e) {}
  }

  loadModelsList() {
    this.api.getModels().subscribe({
      next: (res) => {
        if (res && res.models) {
          this.models.set(res.models);
        }
      },
      error: () => {}
    });
  }

  loadModelMaxContext(modelName: string) {
    if (!modelName) return;
    this.api.getModelInfo(modelName).subscribe({
      next: (res) => {
        // Compute active model weight size in GB
        let sizeBytes = res.size;
        if (!sizeBytes) {
          const matchedModel = this.models().find(m => m.model === modelName);
          if (matchedModel && (matchedModel as any).size) {
            sizeBytes = (matchedModel as any).size;
          }
        }
        if (sizeBytes) {
          this.modelSizeGB.set(Number(sizeBytes) / (1024 * 1024 * 1024));
        } else {
          this.modelSizeGB.set(4.0); // 4GB standard fallback
        }

        let maxCtx = 8192; // default fallback context
        if (res.model_info) {
          for (const key of Object.keys(res.model_info)) {
            if (key.endsWith('.context_length')) {
              maxCtx = Number(res.model_info[key]) || maxCtx;
              break;
            }
          }
        } else {
          // Model family fallbacks
          const lowerName = modelName.toLowerCase();
          if (lowerName.includes('deepseek-r1') || lowerName.includes('llama3.1') || lowerName.includes('llama3.2') || lowerName.includes('llama3.3') || lowerName.includes('qwen2.5') || lowerName.includes('phi4')) {
            maxCtx = 131072;
          } else if (lowerName.includes('llama3') || lowerName.includes('gemma2')) {
            maxCtx = 8192;
          } else if (lowerName.includes('mistral') || lowerName.includes('mixtral')) {
            maxCtx = 32768;
          } else if (lowerName.includes('llama2') || lowerName.includes('codellama')) {
            maxCtx = 4096;
          }
        }
        
        // Dynamic Hardware VRAM Protection clamping calculations
        const totalVram = this.systemVRAM();
        const modelWeight = this.modelSizeGB();
        const freeVram = totalVram - modelWeight;
        
        let hardwareLimit = maxCtx;
        if (freeVram <= 1.5) {
          hardwareLimit = 8192; // Very tight VRAM context clamping
          console.warn(`[Settings] Low host GPU headroom detected (${freeVram.toFixed(1)} GB free). Clamping slider ceiling to 8k.`);
        } else if (freeVram <= 4.0) {
          hardwareLimit = 16384; // Medium VRAM ceiling clamping
          console.warn(`[Settings] Moderate host GPU headroom detected (${freeVram.toFixed(1)} GB free). Clamping slider ceiling to 16k.`);
        } else if (freeVram <= 8.0) {
          hardwareLimit = 32768; // Safe standard clamp
          console.log(`[Settings] Standard host GPU headroom detected (${freeVram.toFixed(1)} GB free). Clamping slider ceiling to 32k.`);
        }

        const resolvedMax = Math.min(maxCtx, hardwareLimit);
        
        console.log(`Settings UI resolved maximum context (with VRAM caps) for active model (${modelName}): ${resolvedMax} (Base max: ${maxCtx})`);
        this.modelMaxContext.set(resolvedMax);
        
        // Safety: If current context exceeds resolved maximum context, auto-clamp setting instantly
        if (this.settings().contextLength > resolvedMax) {
          console.warn(`Settings contextLength (${this.settings().contextLength}) exceeds resolved maximum (${resolvedMax}). Auto-clamping.`);
          this.updateSetting('contextLength', resolvedMax);
        }
      },
      error: (err) => {
        console.warn(`Settings component failed to fetch model details for ${modelName}, using default ceiling`, err);
        this.modelMaxContext.set(8192);
      }
    });
  }

  loadSettings() {
    try {
      const saved = localStorage.getItem('ollama_ui_settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Merge with defaults to ensure new fields like keepAlive are initialized
        this.settings.update(s => ({ ...s, ...parsed }));
      }
    } catch (e) {
      console.error('Failed to load settings', e);
    }
  }

  saveSettings() {
    try {
      localStorage.setItem('ollama_ui_settings', JSON.stringify(this.settings()));
      this.showSaved.set(true);
      setTimeout(() => this.showSaved.set(false), 2000);
    } catch (e) {
      console.error('Failed to save settings', e);
    }
  }

  updateSetting(field: keyof AppSettings, value: any) {
    let finalValue = value;
    
    // Strict numeric casting to prevent sending strings to Ollama options API
    const numericKeys: (keyof AppSettings)[] = [
      'contextLength', 'temperature', 'keepAlive', 'maxTokens', 'topP', 'repeatPenalty', 'seed',
      'ropeFrequencyBase', 'ropeScale'
    ];
    
    if (numericKeys.includes(field)) {
      const num = Number(value);
      if (!isNaN(num)) {
        finalValue = num;
      }
    } else if (field === 'thinking') {
      finalValue = value === true || value === 'true';
    } else if (field === 'jsonMode') {
      finalValue = value === true || value === 'true';
    } else if (field === 'truncateHistory') {
      finalValue = value === true || value === 'true';
    }

    this.settings.update(s => ({ ...s, [field]: finalValue }));
    this.saveSettings();
  }

  handleResetToDefaults() {
    this.settings.set({
      apiUrl: 'http://localhost:11434',
      contextLength: 4096,
      temperature: 0.7,
      systemPrompt: '',
      keepAlive: 5,
      thinking: true,
      jsonMode: false,
      jsonSchema: '',
      truncateHistory: true,
      maxTokens: -1,
      topP: 0.9,
      repeatPenalty: 1.1,
      seed: 0,
      stopSequences: '',
      ropeFrequencyBase: 0,
      ropeScale: 0
    });
    this.saveSettings();
  }

  handleCloseSettings() {
    this.router.navigate(['/']); // Route back to home/chat
  }
}
